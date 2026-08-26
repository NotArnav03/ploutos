import { z } from 'zod';
import {
  NO_META,
  type Policy,
  type PolicyDecision,
  type PolicyInput,
  type TruthAwarePolicy,
} from '../domain/policy.js';
import type { RuleRegistry } from '../domain/rules.js';
import { paise, type Paise } from '../domain/money.js';
import { addDays, addHours, daysBetween, isAfter, type Timestamp } from '../domain/time.js';
import type { LatentState } from './latent.js';
import { Rng, STREAM } from './rng.js';
import { applyEngagement, deliver, present } from './simulator.js';
import type { World } from './types.js';

const IST = 'Asia/Kolkata';
/** Granularity of the retry-time search. Six hours over thirty days. */
const PROBE_STEP_HOURS = 6;
const PROBE_HORIZON_DAYS = 30;

/**
 * The oracle. Sees ground truth, and exists solely to establish the recoverable
 * ceiling - it is not a competitor and its number is never presented as an
 * achievable result.
 *
 * WHY A SEARCH RATHER THAN A FLAG
 *
 * An earlier design carried `recoverable: boolean` on the latent state, set by
 * the generator. That would have made the denominator of the headline metric a
 * number we typed: "recovered 68% of what was recoverable" where recoverable
 * meant whatever the generator asserted. Here it is derived instead, by running
 * a search against the same simulator every other policy runs against.
 *
 * HOW THE SEARCH IS EXACT
 *
 * Presentment randomness is addressed by (seed, case_id, purpose, attempt_seq),
 * not drawn from a running stream, so the outcome of attempt N is a pure
 * function of the time it is presented at. The oracle can therefore probe a
 * candidate time by calling `present` with the very stream the real attempt
 * would use, and get the exact outcome - not an estimate of it.
 *
 * HONEST LIMITATION
 *
 * This is a bounded greedy search, not a proof of optimality: it probes at
 * six-hour granularity over thirty days and does not consider every ordering of
 * every action. So the ceiling it reports is a lower bound on the true optimum.
 * That is the safe direction for a denominator - it can only make our policies
 * look worse - and the OracleViolationError invariant catches the case where
 * the search was too weak, by failing any run in which an observation-only
 * policy recovers more than the oracle did.
 */
export function makeOracle(
  world: World,
  seed: number,
  registry: RuleRegistry,
  fallback: Policy,
): TruthAwarePolicy<LatentState> {
  const afaThreshold = paise(
    registry.param('AFA_THRESHOLD', 'threshold_paise', z.number().int().nonnegative()),
  );
  const noticeHours = registry.param('PREDEBIT_NOTICE', 'notice_hours', z.number().nonnegative());
  const issuerByName = new Map(world.issuers.map((i) => [i.issuer, i]));
  const horizonEnd = addDays(world.meta.start_ts, world.meta.horizon_days);

  return {
    name: 'oracle',
    usesLatentState: true,

    async decide(input: PolicyInput, truth: LatentState): Promise<PolicyDecision> {
      const { observation: obs, permitted } = input;
      const now = input.ctx.now;
      const allowed = new Set(permitted.permitted);
      const channels = permitted.permitted_channels;

      const out = (action: PolicyDecision['action'], rationale: string): PolicyDecision => ({
        action,
        diagnosis: null,
        rationale,
        confidence: null,
        meta: NO_META,
      });
      const giveUp = (why: string): PolicyDecision =>
        out(
          { type: 'stop_terminal', rule_id: 'STOP_ON_ATTEMPTS_EXHAUSTED', disposition: 'closed_unrecoverable' },
          why,
        );

      if (allowed.size === 1 && allowed.has('stop_terminal')) {
        return giveUp(obs.stopped_reason ?? 'gate permits nothing else');
      }

      const issuer = issuerByName.get(truth.issuer);
      if (!issuer) return giveUp('unknown issuer');

      const amount = obs.invoice.amount_paise;
      const seq = obs.invoice.attempts.length + 1;
      const rail = obs.subscription.rail;

      // ---- probe every candidate presentment time for an exact outcome
      //
      // Probed across the remaining attempt budget, not just the next one.
      // Presentment randomness is addressed by attempt_seq, so a presentment
      // that cannot win at seq N may win at seq N+1, and spending a cheap
      // failed attempt to reach it is sometimes the optimal play. Searching
      // only the next seq made the oracle give up on cases static-policy went
      // on to recover, which is precisely the incompleteness the invariant
      // exists to catch.
      const capsByRail = registry.require('RETRY_CAP_PER_INVOICE').params as Record<string, unknown>;
      const cap = z.number().int().positive().parse(capsByRail[rail]);

      let found: Timestamp | null = null;
      for (let s = seq; s <= cap && found === null; s++) {
        found = findWinningTime({
          truth,
          issuer,
          world,
          seed,
          caseId: obs.case_id,
          seq: s,
          rail,
          amount,
          from: now,
          until: earlier(addDays(now, PROBE_HORIZON_DAYS), horizonEnd),
          afaThreshold,
          noticeHours,
          afaRequired: obs.subscription.mandate.afa_required,
        });
      }

      if (found !== null) {
        const needsNotice = rail === 'upi_autopay' || rail === 'enach';
        const noticeBlocking = permitted.excluded.some(
          (e) => e.action_type === 'retry_debit' && e.rule_id === 'PREDEBIT_NOTICE',
        );

        if (needsNotice && noticeBlocking && allowed.has('serve_predebit_notice')) {
          return out(
            { type: 'serve_predebit_notice', channel: 'email', for_debit_at: found },
            `truth: a presentment at ${found} succeeds; serving the required notice first`,
          );
        }

        const afaBlocking = permitted.excluded.some(
          (e) => e.action_type === 'retry_debit' && e.rule_id === 'AFA_THRESHOLD',
        );
        if (afaBlocking && allowed.has('request_afa') && channels.length > 0) {
          return out(
            { type: 'request_afa', channel: channels[0]!, language: obs.customer.language_pref },
            `truth: a presentment at ${found} succeeds; obtaining authentication first`,
          );
        }

        if (!isAfter(found, now) && allowed.has('retry_debit')) {
          return out(
            { type: 'retry_debit', rail, at: now },
            `truth: this presentment succeeds now`,
          );
        }

        // Only wait if waiting moves the clock. A `wait until <now>` is a
        // no-op that hands the case back to the runner's stall guard, and a
        // stall guard stepping a fixed number of hours can park a case on the
        // same wall-clock time indefinitely - which is how this oracle used to
        // sit outside contact hours for nineteen simulated days, unable to
        // serve the notice that would have unblocked the presentment it had
        // already found. If the winning time is now but the gate will not let
        // us act, fall through and solve the blocker instead.
        if (isAfter(found, now)) {
          return out(
            { type: 'wait', until: found },
            `truth: the earliest presentment that succeeds is ${found}`,
          );
        }
      }

      // ---- no presentment can win from here, or one can but the gate will
      // not let us reach it at this instant.
      //
      // But an intervention changes the world: a payer who acts on a nudge tops
      // up their account, and one who acts on an update request replaces their
      // card. An earlier version of this oracle treated latent state as fixed
      // and therefore missed every recovery that a nudge created - which let
      // static-policy beat the ceiling by Rs 1,141 and correctly invalidated
      // the run.
      //
      // Whether a message lands is itself deterministic, addressed by
      // (seed, case, responsiveness, prior_contacts), so the oracle can probe
      // `deliver` with the exact stream the real contact would use and know
      // rather than guess.
      // Fatigue counts collections messages only; the RNG stream is addressed
      // by TOTAL contacts, matching how the runner draws it. Using the same
      // number for both made this probe disagree with what actually happened
      // on any case that had been served a compliance notice.
      const fatigueContacts = obs.invoice.contacts.filter((c) => !c.compliance).length;
      const streamIndex = obs.invoice.contacts.length;
      const probeDelivery = (channel: (typeof channels)[number]): boolean =>
        deliver({
          latent: truth,
          channel,
          prior_contacts: fatigueContacts,
          actionable: true,
          rng: Rng.stream(seed, obs.case_id, STREAM.responsiveness, streamIndex),
        }).acted;

      const landing = channels.find((c) => probeDelivery(c));

      if (landing !== undefined) {
        // A payment link settles the invoice outright, so if it lands it is
        // strictly the best available move.
        if (allowed.has('send_payment_link')) {
          return out(
            {
              type: 'send_payment_link',
              channel: landing,
              template_id: 'payment_link',
              language: obs.customer.language_pref,
              expires_at: addDays(now, 7),
            },
            'truth: the rail cannot settle this, and a link on this channel lands',
          );
        }

        if (
          truth.instrument_validity !== 'valid' &&
          truth.instrument_validity !== 'blocked' &&
          allowed.has('request_instrument_update')
        ) {
          return out(
            {
              type: 'request_instrument_update',
              channel: landing,
              template_id: 'card_expired',
              language: obs.customer.language_pref,
            },
            'truth: the instrument is unusable and an update request lands',
          );
        }

        // Would a top-up make a later presentment succeed? Probe a copy of the
        // world with the engagement applied.
        if (allowed.has('notify_soft')) {
          const toppedUp: LatentState = structuredClone(truth);
          applyEngagement(toppedUp, 'topped_up', now, IST);
          const afterNudge = findWinningTime({
            truth: toppedUp,
            issuer,
            world,
            seed,
            caseId: obs.case_id,
            seq,
            rail,
            amount,
            from: addHours(now, 18),
            until: earlier(addDays(now, PROBE_HORIZON_DAYS), horizonEnd),
            afaThreshold,
            noticeHours,
            afaRequired: obs.subscription.mandate.afa_required,
          });
          if (afterNudge !== null) {
            return out(
              {
                type: 'notify_soft',
                channel: landing,
                template_id: 'payment_failed',
                language: obs.customer.language_pref,
              },
              `truth: a nudge lands and makes a presentment at ${afterNudge} succeed`,
            );
          }
        }
      }

      // ---- nothing can be reached at this instant because the clock forbids
      // contact. Waiting to the moment the window reopens beats any fixed
      // offset, and unlike a fixed offset it cannot resonate with the 24-hour
      // cycle and strand the case at an hour it is never allowed to act.
      const opensAt = permitted.contact_window_opens_at;
      if (channels.length === 0 && opensAt !== null && isAfter(opensAt, now)) {
        return out(
          { type: 'wait', until: opensAt },
          `truth: no route available until contact hours reopen at ${opensAt}`,
        );
      }

      // ---- the exact search was inconclusive.
      //
      // That does NOT mean the invoice is unrecoverable. The search reasons one
      // decision ahead: it asks whether a presentment or a single landing
      // message wins from here. It cannot see that a nudge which fails today
      // may be followed by one that lands next week, because each contact draws
      // a different stream.
      //
      // Rather than give up - which made the ceiling fall BELOW a tuned
      // heuristic twice, correctly invalidating both runs - the oracle defers
      // to the best heuristic available when it has nothing exact to offer.
      // The ceiling is therefore max(exact search, tuned rules) per decision,
      // which is still a lower bound on the true optimum and never worse than
      // something an observation-only policy actually achieved.
      const fb = await fallback.decide(input);
      return {
        ...fb,
        rationale: `no exact win found; deferring to ${fallback.name}: ${fb.rationale}`,
      };
    },
  };
}

function earlier(a: Timestamp, b: Timestamp): Timestamp {
  return a <= b ? a : b;
}



interface ProbeArgs {
  truth: LatentState;
  issuer: World['issuers'][number];
  world: World;
  seed: number;
  caseId: string;
  seq: number;
  rail: 'upi_autopay' | 'enach' | 'card_on_file';
  amount: Paise;
  from: Timestamp;
  until: Timestamp;
  afaThreshold: Paise;
  noticeHours: number;
  afaRequired: boolean;
}

/**
 * The earliest instant at which this presentment would actually succeed, or
 * null if none does inside the probe window.
 *
 * Preconditions the agent could satisfy - notice served, authentication
 * obtained - are assumed satisfied here, because the question being answered is
 * "is this invoice reachable at all", not "is it reachable with the paperwork
 * currently in hand". The caller then serves whichever precondition is blocking.
 */
function findWinningTime(a: ProbeArgs): Timestamp | null {
  const steps = Math.ceil((daysBetween(a.from, a.until) * 24) / PROBE_STEP_HOURS);
  if (steps <= 0) return null;

  for (let i = 0; i <= steps; i++) {
    const at = addHours(a.from, i * PROBE_STEP_HOURS);
    if (isAfter(at, a.until)) break;

    const result = present({
      latent: a.truth,
      issuer: a.issuer,
      start_ts: a.world.meta.start_ts,
      at,
      rail: a.rail,
      amount: a.amount,
      attempt_seq: a.seq,
      invoice_settled: false,
      mandate_afa_required: a.afaRequired,
      afa_threshold_paise: a.afaThreshold,
      afa_satisfied: true,
      predebit_notice_served_at: addHours(at, -(a.noticeHours + 1)),
      predebit_notice_hours: a.noticeHours,
      timezone: IST,
      // The exact stream the real attempt would use, so this is the true
      // outcome rather than a sample from a similar distribution.
      rng: Rng.stream(a.seed, a.caseId, STREAM.outcome, a.seq),
    });

    if (result.success) return at;
  }
  return null;
}
