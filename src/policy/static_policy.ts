import { NO_META, type Policy, type PolicyDecision, type PolicyInput } from '../domain/policy.js';
import type { Channel } from '../domain/schemas.js';
import { addDays, addHours, localDayOfMonth, type Timestamp } from '../domain/time.js';

/**
 * Decline-code-keyed recovery rules. No LLM.
 *
 * This is the ablation. If the agent cannot beat a well-tuned rules engine,
 * that is the finding and it gets published - so this baseline has to be a
 * genuine opponent rather than a strawman. Its parameters are fitted by
 * `npm run tune`, which grid-searches retry offsets against the training seeds
 * and writes the winner into STATIC_PARAMS below.
 *
 * A weak version of this file is the easiest way in the whole project to make
 * an LLM look good dishonestly, which is exactly why it is worth the effort.
 */

export interface StaticParams {
  /** Hours after the last failure to re-present, per failure code. */
  retry_offset_hours: Record<string, number>;
  /** Days ahead to aim a funds retry, relative to the payer's likely refill. */
  funds_target_offset_days: number;
  /** Only nudge when the invoice is worth more than this, in paise. */
  nudge_min_value_paise: number;
  /** Escalate to a payment link after this many failed presentments. */
  link_after_attempts: number;
  /** Hand to a human above this invoice value once retries are exhausted. */
  handoff_min_value_paise: number;
}

/**
 * Fitted by `npm run tune` on seeds 101-103, which are disjoint from the
 * evaluation seed. Tuning on the seed we report would be fitting the test set.
 *
 * A NOTE ON handoff_min_value_paise, which the search drove above every invoice
 * in the batch - i.e. "never hand off".
 *
 * That is the metric talking, not a finding about collections. We count an
 * escalated case as unrecovered, because the money was not collected by this
 * system; a real merchant's human team would recover some fraction of what it
 * receives, and we have no basis to estimate that fraction, so we do not model
 * it. Under that accounting, handing off is pure cost and the optimiser
 * correctly refuses to do it.
 *
 * The honest reading: every policy here is measured on AUTOMATED recovery only.
 * We keep the tuned value rather than hobbling the baseline for realism, because
 * a baseline weakened on purpose is exactly the strawman this file exists to
 * avoid. Escalations are reported separately so the choice stays visible.
 */
export const STATIC_PARAMS: StaticParams = {
  retry_offset_hours: {
    INSUFFICIENT_FUNDS: 96,
    ISSUER_UNAVAILABLE: 12,
    TXN_TIMEOUT: 6,
    LIMIT_EXCEEDED: 30,
    RISK_HOLD: 80,
    PSP_DOWN: 18,
    PREDEBIT_NOTICE_MISSING: 26,
    AFA_REQUIRED: 26,
    INSTRUMENT_EXPIRED: 24,
    MANDATE_CAP_EXCEEDED: 24,
  },
  funds_target_offset_days: 2,
  nudge_min_value_paise: 20000,
  link_after_attempts: 3,
  handoff_min_value_paise: 100000000,
};

export function makeStaticPolicy(params: StaticParams = STATIC_PARAMS): Policy {
  return {
    name: 'static-policy',
    usesLatentState: false,

    decide(input: PolicyInput): PolicyDecision {
      const { observation: obs, permitted } = input;
      const now = input.ctx.now;
      const allowed = new Set(permitted.permitted);
      const channels = permitted.permitted_channels;

      const out = (
        action: PolicyDecision['action'],
        rationale: string,
      ): PolicyDecision => ({
        action,
        diagnosis: null,
        rationale,
        confidence: null,
        meta: NO_META,
      });

      const stop = (rule: string, why: string): PolicyDecision =>
        out({ type: 'stop_terminal', rule_id: rule, disposition: 'written_off' }, why);

      if (allowed.size === 1 && allowed.has('stop_terminal')) {
        return stop(obs.stopped_reason ?? 'STOP_ON_ATTEMPTS_EXHAUSTED', 'gate permits nothing else');
      }

      const last = obs.invoice.attempts[obs.invoice.attempts.length - 1];
      const code = last?.code ?? '';
      const attempts = obs.invoice.attempts.length;
      const value = obs.invoice.amount_paise;
      const pickChannel = (): Channel =>
        channels.includes('whatsapp')
          ? 'whatsapp'
          : channels.includes('email')
            ? 'email'
            : channels.includes('sms')
              ? 'sms'
              : 'inapp';

      // --- structural blocks that no retry can clear -----------------------
      // A cap breach needs the payer to re-authorise, which is outside this
      // system's authority, so the only honest move is a human or a link.
      if (code === 'MANDATE_CAP_EXCEEDED') {
        if (allowed.has('send_payment_link') && channels.length > 0) {
          return out(
            {
              type: 'send_payment_link',
              channel: pickChannel(),
              template_id: 'cap_breach_link',
              language: obs.customer.language_pref,
              expires_at: addDays(now, 7),
            },
            'invoice exceeds the mandate cap; a manual payment is the only route',
          );
        }
        if (allowed.has('handoff_human')) {
          return out(
            {
              type: 'handoff_human',
              reason: 'mandate cap breached',
              case_summary: `Invoice ${obs.invoice.id} exceeds the mandate cap. Needs re-authorisation.`,
              priority: value >= params.handoff_min_value_paise ? 'high' : 'normal',
            },
            'cap breach requires re-authorisation, which is outside agent authority',
          );
        }
        return stop('MANDATE_CAP_RESPECTED', 'cap breach with no route available');
      }

      if (code === 'INSTRUMENT_EXPIRED') {
        if (allowed.has('request_instrument_update') && channels.length > 0) {
          return out(
            {
              type: 'request_instrument_update',
              channel: pickChannel(),
              template_id: 'card_expired',
              language: obs.customer.language_pref,
            },
            'saved card is expired; no re-presentment of it can succeed',
          );
        }
      }

      // --- compliance preconditions ---------------------------------------
      const noticeBlocking = permitted.excluded.some(
        (e) => e.action_type === 'retry_debit' && e.rule_id === 'PREDEBIT_NOTICE',
      );
      if (noticeBlocking && allowed.has('serve_predebit_notice')) {
        return out(
          { type: 'serve_predebit_notice', channel: 'email', for_debit_at: addHours(now, 26) },
          'advance notice required before this e-mandate debit',
        );
      }

      const afaBlocking = permitted.excluded.some(
        (e) => e.action_type === 'retry_debit' && e.rule_id === 'AFA_THRESHOLD',
      );
      if (afaBlocking && allowed.has('request_afa') && channels.length > 0) {
        return out(
          { type: 'request_afa', channel: pickChannel(), language: obs.customer.language_pref },
          'debit is above the authentication threshold',
        );
      }

      // --- the timing lever -------------------------------------------------
      if (allowed.has('retry_debit')) {
        return out(
          { type: 'retry_debit', rail: obs.subscription.rail, at: now },
          `code ${code}: gate permits a presentment now`,
        );
      }

      // --- escalation once presentments are not available -------------------
      if (
        attempts >= params.link_after_attempts &&
        value >= params.nudge_min_value_paise &&
        allowed.has('send_payment_link') &&
        channels.length > 0
      ) {
        return out(
          {
            type: 'send_payment_link',
            channel: pickChannel(),
            template_id: 'payment_link',
            language: obs.customer.language_pref,
            expires_at: addDays(now, 5),
          },
          `${attempts} presentments without success; offering a manual route`,
        );
      }

      if (
        value >= params.nudge_min_value_paise &&
        allowed.has('notify_soft') &&
        channels.length > 0
      ) {
        return out(
          {
            type: 'notify_soft',
            channel: pickChannel(),
            template_id: 'payment_failed',
            language: obs.customer.language_pref,
          },
          'nudging the payer to fund the account before the next presentment',
        );
      }

      if (value >= params.handoff_min_value_paise && allowed.has('handoff_human')) {
        return out(
          {
            type: 'handoff_human',
            reason: 'high-value invoice not recovered by automated means',
            case_summary:
              `Invoice ${obs.invoice.id} (${value} paise) failed with ${code} after ` +
              `${attempts} presentments. Automated routes exhausted.`,
            priority: 'high',
          },
          'high value and no automated route left',
        );
      }

      // --- otherwise wait for the next opportunity --------------------------
      const offset = params.retry_offset_hours[code] ?? 48;
      let target: Timestamp = addHours(last?.ts ?? now, offset);

      // For funds failures, aim at the start of the month rather than a blind
      // offset: Indian salary cycles cluster around the 1st and the 7th, and
      // presenting into a known-empty account just burns an attempt.
      if (code === 'INSUFFICIENT_FUNDS') {
        const dom = localDayOfMonth(now, 'Asia/Kolkata');
        const daysToFirst = dom <= 1 ? 0 : 32 - dom;
        const daysToSeventh = dom <= 7 ? 7 - dom : 99;
        const best = Math.min(daysToFirst, daysToSeventh) + params.funds_target_offset_days;
        if (best >= 0 && best < 14) target = addDays(now, Math.max(1, best));
      }

      // Only reshape the wait when there is nothing deliberate left in it.
      //
      // A target in the future is a plan - usually aimed at the payer's next
      // salary credit - and pulling it forward just burns a presentment into a
      // known-empty account. But a target that has already passed is a stall,
      // and a stall resolved with a fixed offset that divides 24 hours parks
      // the case on the same wall-clock time on every wake, so a rule keyed on
      // time of day can block it forever. When the clock is the only thing in
      // the way, wait for the clock.
      if (target <= now) {
        const opensAt = permitted.contact_window_opens_at;
        target =
          channels.length === 0 && opensAt !== null && opensAt > now
            ? opensAt
            : addHours(now, 7);
      }
      return out({ type: 'wait', until: target }, `waiting until ${target} for code ${code}`);
    },
  };
}

export const staticPolicy = makeStaticPolicy();
