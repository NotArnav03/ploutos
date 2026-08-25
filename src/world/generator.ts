import { paise, rupees, type Paise } from '../domain/money.js';
import { RuleRegistry } from '../domain/rules.js';
import { TaxonomyIndex, loadMixes } from '../domain/taxonomy.js';
import type {
  Attempt,
  ChannelMap,
  Customer,
  Invoice,
  Language,
  Mandate,
  Rail,
  Segment,
  Subscription,
} from '../domain/schemas.js';
import {
  TimestampSchema,
  addDays,
  addHours,
  localDayOfMonth,
  type Timestamp,
} from '../domain/time.js';
import { z } from 'zod';
import type { IssuerSchedule, LatentState, Responsiveness } from './latent.js';
import { LatentStateSchema } from './latent.js';
import { Rng, STREAM } from './rng.js';
import { present, simDay } from './simulator.js';
import {
  ADVERSARIAL_KINDS,
  ARCHETYPE_EXPECTED_CODE,
  CODE_TO_ARCHETYPES,
  type AdversarialKind,
  type ArchetypeId,
  type World,
  type WorldCase,
} from './types.js';

export const GENERATOR_VERSION = '1.0.0';

const DEFAULT_START = TimestampSchema.parse('2026-08-01T00:00:00.000Z');
const ISSUER_COUNT = 10;
const RAIL_POPULARITY: Record<Rail, number> = {
  upi_autopay: 0.55,
  card_on_file: 0.3,
  enach: 0.15,
};
const IST = 'Asia/Kolkata';

export interface GenerateOptions {
  seed: number;
  size: number;
  mix?: string;
  /** Share of the batch that is a hand-shaped edge case. */
  adversarial_share?: number;
  start_ts?: Timestamp;
  horizon_days?: number;
}

export interface GenerateResult {
  world: World;
  /** Target weights from the mix config. */
  target_mix: Record<string, number>;
  /**
   * Weights actually observed once the simulator derived each day-0 code.
   * Reported beside the target rather than forced to match it: the mix is what
   * we asked for, this is what the mechanism produced.
   */
  realised_mix: Record<string, number>;
  /** Cases whose derived code differed from the archetype drawn for them. */
  relabelled: number;
}

// ------------------------------------------------------------------ issuers

/**
 * Issuer availability over the horizon. Each issuer gets a baseline set by its
 * tier and, with some probability, one degradation window - a couple of days
 * where availability drops sharply.
 *
 * The windows are what make issuer-health detection a real signal: failures
 * cluster on one bank on one day, across many unrelated accounts.
 */
function makeIssuers(seed: number, horizonDays: number): IssuerSchedule[] {
  const out: IssuerSchedule[] = [];

  for (let i = 1; i <= ISSUER_COUNT; i++) {
    const issuer = `ISSUER_${String(i).padStart(2, '0')}`;
    const rng = Rng.stream(seed, issuer, STREAM.issuerSchedule);
    const tier = i <= 3 ? 'large' : i <= 7 ? 'mid' : 'small';
    const baseline: number = tier === 'large' ? 0.985 : tier === 'mid' ? 0.97 : 0.945;

    const availability: number[] = Array.from({ length: horizonDays }, () => baseline);

    // Guarantee that some degradation overlaps the due-date window (sim days
    // 0-6). Without this, outages scatter across a 45-day horizon, almost never
    // land in the week invoices actually fall due, and issuer_flaky cases find
    // no degraded issuer to sit on - measured at 2.6% against a 12% target.
    if (i <= 3) {
      const startDay = rng.int(0, 6);
      const length = rng.int(2, 4);
      const depth = rng.next() * 0.3 + 0.1;
      for (let d = startDay; d < Math.min(startDay + length, horizonDays); d++) {
        availability[d] = depth;
      }
    }

    // Most issuers have at least one further bad patch over six weeks.
    const outages = rng.int(0, 2);
    for (let o = 0; o < outages; o++) {
      const startDay = rng.int(0, horizonDays - 3);
      const length = rng.int(1, 3);
      const depth = rng.next() * 0.55 + 0.15; // availability floor 0.15-0.70
      for (let d = startDay; d < Math.min(startDay + length, horizonDays); d++) {
        availability[d] = depth;
      }
    }
    out.push({ issuer, tier, availability });
  }
  return out;
}

// ----------------------------------------------------------------- customers

const B2C_AMOUNTS = [99, 149, 199, 249, 299, 399, 499, 599, 799, 999, 1499];
const SMB_AMOUNTS = [1999, 2999, 4999, 7499, 9999, 14999, 19999, 24999];

const STATES = [
  'Karnataka',
  'Maharashtra',
  'Delhi',
  'Tamil Nadu',
  'Telangana',
  'Gujarat',
  'West Bengal',
  'Uttar Pradesh',
  'Kerala',
  'Rajasthan',
];

function makeChannels(rng: Rng, segment: Segment): ChannelMap {
  const dndSms = rng.bool(0.18);
  return {
    sms: { reachable: true, consent: rng.bool(0.9), dnd: dndSms },
    email: { reachable: true, consent: rng.bool(segment === 'smb' ? 0.97 : 0.82), dnd: false },
    whatsapp: { reachable: rng.bool(0.85), consent: rng.bool(0.7), dnd: dndSms },
    inapp: { reachable: rng.bool(0.6), consent: true, dnd: false },
  };
}

function makeCustomer(seed: number, id: string, planAmount: Paise, segment: Segment): Customer {
  const rng = Rng.stream(seed, id, STREAM.customer);
  const tenure = rng.normalInt(14, 12, 1, 72);
  const language: Language = rng.weighted([
    ['en', 0.45],
    ['hinglish', 0.4],
    ['hi', 0.15],
  ]);

  // Prior history is observable and is the agent's main signal about whether a
  // payer recovers on their own. Longer tenure means more chances to have both.
  const priorFailures = rng.int(0, Math.min(6, Math.floor(tenure / 4)));
  const priorRecoveries = priorFailures === 0 ? 0 : rng.int(0, priorFailures);

  return {
    id,
    segment,
    tenure_months: tenure,
    ltv_paise: paise(planAmount * Math.max(1, tenure)),
    prior_failures: priorFailures,
    prior_recoveries: priorRecoveries,
    state: rng.pick(STATES),
    language_pref: language,
    channels: makeChannels(rng, segment),
  };
}

function makeResponsiveness(rng: Rng, segment: Segment): Responsiveness {
  const base = segment === 'smb' ? 0.55 : 0.4;
  const jitter = (): number => Math.min(0.95, Math.max(0.02, rng.normal(base, 0.18)));
  return {
    sms: jitter(),
    email: jitter(),
    whatsapp: Math.min(0.95, jitter() * 1.2),
    inapp: jitter(),
    fatigue_decay: rng.next() * 0.25 + 0.6, // 0.60-0.85 per prior contact
  };
}

// -------------------------------------------------------------------- latent

interface LatentSeed {
  subscription_id: string;
  issuer: string;
  issuers: IssuerSchedule[];
  rail: Rail;
  amount: Paise;
  due: Timestamp;
  start: Timestamp;
  horizon: number;
  segment: Segment;
  archetype: ArchetypeId;
  rng: Rng;
}

/**
 * Build latent state that will MECHANICALLY produce the drawn archetype's
 * failure at the day-0 presentment.
 *
 * Note what this function does not do: it never records the archetype anywhere
 * the simulator can read. It sets balances, dates and caps, and the simulator
 * independently derives a code from those. Whether it derives the intended one
 * is then checked, not assumed - see generateWorld's rejection loop.
 */
function makeLatent(s: LatentSeed): LatentState {
  const { rng, amount, due, start, horizon } = s;
  const dueDom = localDayOfMonth(due, IST);

  // Healthy baseline: funded AT THE DUE DATE, authorised, valid, quiet.
  //
  // The funding part is load-bearing. An earlier draft placed the refill day
  // after the due date, so the baseline account was broke at presentment and
  // every archetype whose own mechanism failed to fire fell through to the
  // funds check. INSUFFICIENT_FUNDS measured 17 points above target and
  // TXN_TIMEOUT - which sits after funds in the check order - never appeared
  // at all. Only the drawn archetype should cause the day-0 failure.
  const backoff = rng.int(0, 5);
  const refillDay = ((dueDom - backoff - 1 + 28) % 28) + 1;
  const latent: LatentState = {
    subscription_id: s.subscription_id,
    issuer: s.issuer,

    balance_refill_day: refillDay,
    available_on_refill_paise: paise(amount * rng.int(3, 12)),
    funded_window_days: rng.int(backoff + 8, 20),
    residual_balance_paise: paise(Math.floor(amount * (rng.next() * 0.6))),
    per_txn_limit_paise: rupees(100000),

    true_mandate_status: 'active',
    true_mandate_cap_paise: paise(amount * rng.int(2, 4)),
    revoked_at: null,
    true_valid_till: addDays(start, rng.int(200, 700)),

    instrument_validity: 'valid',
    instrument_expires_at: s.rail === 'card_on_file' ? addDays(start, rng.int(200, 900)) : null,

    working_rails: [s.rail],
    psp_available_by_day: Array.from({ length: horizon }, () => 1),

    risk_flag_after_attempts: null,
    timeout_probability: rng.next() * 0.03,

    responsiveness: makeResponsiveness(rng, s.segment),
    intent: rng.weighted([
      ['willing', 0.55],
      ['forgot', 0.35],
      ['churned', 0.06],
      ['insolvent', 0.04],
    ]),

    out_of_band_payment_at: null,
    cancellation_request_at: null,
    account_closed_at: null,
    dispute_raised_at: null,
  };

  // Roughly a third of payers have a second usable rail, which is what makes
  // switch_rail a real option rather than a decoration.
  if (rng.bool(0.35)) {
    const others: Rail[] = (['upi_autopay', 'enach', 'card_on_file'] as const).filter(
      (r) => r !== s.rail,
    );
    latent.working_rails = [s.rail, rng.pick(others)];
  }

  switch (s.archetype) {
    case 'salary_timing': {
      // Due before payday, funded after it. Pure timing: a retry placed on the
      // right day recovers in full, and one placed a day early does not.
      latent.balance_refill_day = ((dueDom + rng.int(3, 10) - 1) % 28) + 1;
      latent.funded_window_days = rng.int(8, 16);
      latent.residual_balance_paise = paise(Math.floor(amount * (rng.next() * 0.7)));
      latent.available_on_refill_paise = paise(amount * rng.int(4, 15));
      latent.intent = rng.bool(0.75) ? 'willing' : 'forgot';
      break;
    }
    case 'chronic_shortfall': {
      // Never funded enough, at any point in the window. Unrecoverable by
      // timing, and the agent should stop rather than keep re-presenting.
      latent.available_on_refill_paise = paise(Math.floor(amount * (rng.next() * 0.5)));
      latent.residual_balance_paise = paise(Math.floor(amount * (rng.next() * 0.2)));
      latent.intent = 'insolvent';
      break;
    }
    case 'issuer_flaky': {
      // Assigned to an issuer that is degraded on the due day; handled by the
      // caller, which picks the issuer and day together.
      latent.timeout_probability = rng.next() * 0.05;
      break;
    }
    case 'switch_timeout': {
      latent.timeout_probability = rng.next() * 0.1 + 0.85;
      break;
    }
    case 'limit_capped': {
      latent.per_txn_limit_paise = paise(Math.max(1, Math.floor(amount * 0.8)));
      break;
    }
    case 'risk_flagged': {
      latent.risk_flag_after_attempts = 1;
      break;
    }
    case 'card_expired': {
      latent.instrument_validity = 'expired';
      latent.instrument_expires_at = addDays(due, -rng.int(1, 40));
      break;
    }
    case 'cap_breached': {
      // A price rise pushed the invoice above what the mandate authorises.
      latent.true_mandate_cap_paise = paise(Math.max(1, Math.floor(amount * 0.85)));
      break;
    }
    case 'notice_missing': {
      // Handled by the caller: it withholds the pre-debit notice for this case.
      break;
    }
    case 'afa_needed': {
      // Handled by the caller: amount is placed above the threshold.
      break;
    }
    case 'psp_outage': {
      const d = Math.max(0, simDay(start, due));
      for (let k = d; k < Math.min(d + rng.int(1, 3), horizon); k++) {
        latent.psp_available_by_day[k] = rng.next() * 0.2;
      }
      break;
    }
    case 'mandate_revoked': {
      latent.true_mandate_status = 'revoked';
      latent.revoked_at = addDays(due, -rng.int(1, 30));
      latent.intent = rng.bool(0.6) ? 'churned' : 'willing';
      break;
    }
    case 'account_closed': {
      latent.account_closed_at = addDays(due, -rng.int(1, 25));
      latent.intent = 'churned';
      break;
    }
    case 'card_blocked': {
      latent.instrument_validity = 'blocked';
      break;
    }
    case 'disputing': {
      latent.dispute_raised_at = addDays(due, -rng.int(1, 10));
      latent.intent = 'disputing';
      break;
    }
  }

  return LatentStateSchema.parse(latent);
}

// ----------------------------------------------------------------- assembly

function makeMandate(
  rng: Rng,
  latent: LatentState,
  start: Timestamp,
  due: Timestamp,
  amount: Paise,
  afaThreshold: Paise,
  serveNotice: boolean,
): Mandate {
  return {
    ref: `MND-${latent.subscription_id.slice(4)}`,
    // The merchant's view, which lags the bank's. A payer who revoked at their
    // bank three weeks ago still shows as active here - that staleness is what
    // makes MANDATE_ACTIVE_REQUIRED a real check rather than a tautology.
    status: 'active',
    max_amount_paise: latent.true_mandate_cap_paise,
    valid_till: latent.true_valid_till,
    created_at: addDays(start, -rng.int(60, 900)),
    afa_required: amount >= afaThreshold,
    last_predebit_notice_at: serveNotice ? addHours(due, -rng.int(25, 72)) : null,
  };
}

export function generateWorld(opts: GenerateOptions): GenerateResult {
  const {
    seed,
    size,
    mix: mixName,
    adversarial_share = 0.05,
    start_ts = DEFAULT_START,
    horizon_days = 45,
  } = opts;

  const taxonomy = new TaxonomyIndex();
  const registry = new RuleRegistry();
  const mixes = loadMixes();
  const chosenMix = mixName ?? mixes.default_mix;
  const mix = mixes.mixes[chosenMix];
  if (!mix) throw new Error(`unknown mix ${chosenMix}, have ${Object.keys(mixes.mixes).join(', ')}`);

  const afaThreshold = paise(
    registry.param('AFA_THRESHOLD', 'threshold_paise', z.number().int().nonnegative()),
  );
  const noticeHours = registry.param(
    'PREDEBIT_NOTICE',
    'notice_hours',
    z.number().nonnegative(),
  );

  const issuers = makeIssuers(seed, horizon_days);
  const issuerByName = new Map(issuers.map((i) => [i.issuer, i]));

  const adversarialCount = Math.round(size * adversarial_share);
  const cases: WorldCase[] = [];
  const realisedCounts: Record<string, number> = {};
  let relabelled = 0;

  for (let i = 0; i < size; i++) {
    const n = String(i + 1).padStart(5, '0');
    const caseId = `CASE-${n}`;
    const subId = `SUB-${n}`;
    const custId = `CUST-${n}`;

    const shapeRng = Rng.stream(seed, subId, STREAM.subscription);
    const adversarial: AdversarialKind | null =
      i < adversarialCount
        ? ADVERSARIAL_KINDS[i % ADVERSARIAL_KINDS.length] ?? null
        : null;

    const segment: Segment = shapeRng.bool(0.78) ? 'b2c' : 'smb';

    // Due dates spread over the first week, so the batch reads as a real queue
    // rather than one synchronised billing run.
    const due = addHours(addDays(start_ts, shapeRng.int(0, 6)), shapeRng.int(2, 14));

    // Draw the ROOT CAUSE first, then a rail that can actually exhibit it.
    //
    // The earlier draft drew the rail first and renormalised the mix over the
    // codes that rail supports, which makes a global target mix arithmetically
    // unreachable: INSTRUMENT_EXPIRED exists only on cards, so a 9% global
    // target is capped near (card share x renormalised weight) and measured at
    // 2.2%. Drawing the cause first and letting it pick its own rail hits the
    // global mix directly and produces the rail split as a consequence, which
    // is also the more honest direction - a merchant's failure mix is a
    // property of their book, not of a rail chosen in advance.
    const codeWeights: [string, number][] = Object.entries(mix.weights).filter(
      ([, w]) => w > 0,
    );
    const drawnCode = shapeRng.weighted(codeWeights);
    const archOptions = CODE_TO_ARCHETYPES[drawnCode] ?? [];
    if (archOptions.length === 0) throw new Error(`no archetype produces ${drawnCode}`);
    let archetype: ArchetypeId = shapeRng.pick(archOptions);

    const railOptions = taxonomy.get(drawnCode).rails;
    const rail: Rail = shapeRng.weighted(
      railOptions.map((r) => [r, RAIL_POPULARITY[r]] as const),
    );

    let amount: Paise = rupees(shapeRng.pick(segment === 'b2c' ? B2C_AMOUNTS : SMB_AMOUNTS));
    if (archetype === 'afa_needed') amount = paise(afaThreshold + shapeRng.int(100, 500000));
    if (adversarial === 'afa_threshold_edge') {
      amount = paise(afaThreshold + shapeRng.int(1, 5000));
    }

    // Authentication for a high-value recurring debit is arranged as part of
    // normal billing, exactly like the pre-debit notice. Leaving it unsatisfied
    // by default made every SMB invoice above the threshold fail with
    // AFA_REQUIRED regardless of its drawn cause.
    const afaArranged = archetype !== 'afa_needed' && adversarial !== 'afa_threshold_edge';

    // issuer_flaky needs an issuer that is actually degraded on the due day.
    let issuer: IssuerSchedule;
    const dueDay = Math.max(0, simDay(start_ts, due));
    if (archetype === 'issuer_flaky') {
      const degraded = issuers.filter((s) => (s.availability[dueDay] ?? 1) < 0.75);
      issuer = degraded.length > 0 ? shapeRng.pick(degraded) : shapeRng.pick(issuers);
    } else {
      const healthy = issuers.filter((s) => (s.availability[dueDay] ?? 1) > 0.9);
      issuer = healthy.length > 0 ? shapeRng.pick(healthy) : shapeRng.pick(issuers);
    }

    const serveNotice = archetype !== 'notice_missing';
    const customer = makeCustomer(seed, custId, amount, segment);

    // Rejection sampling: build latent, present the debit for real, and keep
    // the result only if the simulator derived the code we were aiming for.
    // Bounded, and on exhaustion we accept whatever the mechanism produced and
    // relabel the case rather than forcing the world to agree with the label.
    let latent!: LatentState;
    let result!: ReturnType<typeof present>;
    const wanted = ARCHETYPE_EXPECTED_CODE[archetype];

    for (let attempt = 0; attempt < 6; attempt++) {
      const latentRng = Rng.stream(seed, subId, STREAM.latent, attempt);
      latent = makeLatent({
        subscription_id: subId,
        issuer: issuer.issuer,
        issuers,
        rail,
        amount,
        due,
        start: start_ts,
        horizon: horizon_days,
        segment,
        archetype,
        rng: latentRng,
      });

      result = present({
        latent,
        issuer,
        start_ts,
        at: due,
        rail,
        amount,
        attempt_seq: 1,
        invoice_settled: false,
        mandate_afa_required: amount >= afaThreshold,
        afa_threshold_paise: afaThreshold,
        afa_satisfied: afaArranged,
        predebit_notice_served_at: serveNotice ? addHours(due, -25) : null,
        predebit_notice_hours: noticeHours,
        timezone: IST,
        rng: Rng.stream(seed, subId, STREAM.outcome, 0, attempt),
      });

      if (!result.success && result.code === wanted) break;
    }

    // The batch is a queue of invoices that have ALREADY failed once. A case
    // that succeeded on presentment one does not belong in it.
    if (result.success || result.code === null) {
      const forced = Rng.stream(seed, subId, STREAM.latent, 99);
      latent = makeLatent({
        subscription_id: subId,
        issuer: issuer.issuer,
        issuers,
        rail,
        amount,
        due,
        start: start_ts,
        horizon: horizon_days,
        segment,
        archetype: 'chronic_shortfall',
        rng: forced,
      });
      result = present({
        latent,
        issuer,
        start_ts,
        at: due,
        rail,
        amount,
        attempt_seq: 1,
        invoice_settled: false,
        mandate_afa_required: amount >= afaThreshold,
        afa_threshold_paise: afaThreshold,
        afa_satisfied: afaArranged,
        predebit_notice_served_at: serveNotice ? addHours(due, -25) : null,
        predebit_notice_hours: noticeHours,
        timezone: IST,
        rng: Rng.stream(seed, subId, STREAM.outcome, 0, 99),
      });
    }

    const derived = result.code;
    if (derived === null) throw new Error(`${caseId}: could not produce a day-0 failure`);
    if (derived !== wanted) {
      relabelled++;
      const alt = CODE_TO_ARCHETYPES[derived]?.[0];
      if (alt) archetype = alt;
    }
    realisedCounts[derived] = (realisedCounts[derived] ?? 0) + 1;

    // Adversarial overlays, applied after the day-0 failure is established so
    // they shape the RECOVERY window rather than the initial decline.
    const advRng = Rng.stream(seed, subId, STREAM.adversarial);
    switch (adversarial) {
      case 'out_of_band_payment':
        latent.out_of_band_payment_at = addDays(due, advRng.int(2, 9));
        latent.intent = 'willing';
        break;
      case 'cancellation_mid_ladder':
        latent.cancellation_request_at = addDays(due, advRng.int(3, 11));
        latent.intent = 'churned';
        break;
      case 'dnd_split_consent':
        customer.channels.sms = { reachable: true, consent: true, dnd: true };
        customer.channels.email = { reachable: true, consent: true, dnd: false };
        break;
      case 'mandate_expiring':
        latent.true_valid_till = addDays(due, advRng.int(2, 6));
        break;
      case 'high_ltv_repeat_failure':
        customer.prior_failures = advRng.int(3, 5);
        customer.prior_recoveries = customer.prior_failures - 1;
        customer.ltv_paise = paise(amount * advRng.int(30, 60));
        break;
      case 'afa_threshold_edge':
      case 'duplicate_event':
      case null:
        break;
    }

    const taxEntry = taxonomy.get(derived);
    const attempt1: Attempt = {
      id: `ATT-${n}-1`,
      invoice_id: `INV-${n}`,
      seq: 1,
      ts: due,
      rail,
      amount_paise: amount,
      code: derived,
      class: taxEntry.class,
      remedy: taxEntry.remedy,
      succeeded: false,
      retry_allowed_after: taxEntry.retryable
        ? addHours(due, taxEntry.min_retry_gap_hours)
        : null,
      description: taxEntry.label,
    };

    const subRng = Rng.stream(seed, subId, STREAM.mandate);
    const subscription: Subscription = {
      id: subId,
      customer_id: custId,
      plan: { amount_paise: amount, interval: 'monthly' },
      rail,
      mandate: makeMandate(subRng, latent, start_ts, due, amount, afaThreshold, serveNotice),
      started_at: addDays(start_ts, -30 * Math.max(1, customer.tenure_months)),
      cycles_completed: customer.tenure_months,
      alternate_rails: latent.working_rails.filter((r) => r !== rail),
    };

    const invoice: Invoice = {
      id: `INV-${n}`,
      subscription_id: subId,
      customer_id: custId,
      amount_paise: amount,
      due_date: due,
      status: 'failed',
      first_failed_at: due,
      attempts: [attempt1],
      contacts: [],
      promises: [],
    };

    cases.push({
      case_id: caseId,
      customer,
      subscription,
      invoice,
      latent,
      archetype,
      adversarial,
    });
  }

  const realised: Record<string, number> = {};
  for (const [code, count] of Object.entries(realisedCounts)) realised[code] = count / size;

  return {
    world: {
      meta: {
        seed,
        mix: chosenMix,
        size,
        start_ts,
        horizon_days,
        generator_version: GENERATOR_VERSION,
      },
      issuers,
      cases,
    },
    target_mix: mix.weights,
    realised_mix: realised,
    relabelled,
  };
}
