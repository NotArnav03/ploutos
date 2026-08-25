import { TimestampSchema, addHours, type Timestamp } from '../domain/time.js';
import { NO_META, type Policy, type PolicyDecision, type PolicyInput } from '../domain/policy.js';

const FAR_FUTURE = TimestampSchema.parse('2099-01-01T00:00:00.000Z');

/**
 * Baseline policies. Neither reasons; both exist to give the agent something
 * honest to be measured against.
 */

/**
 * Does nothing, ever. Establishes the denominator: money that walks out the
 * door when a merchant has no recovery process at all.
 */
export const doNothing: Policy = {
  name: 'do-nothing',
  usesLatentState: false,
  decide(): PolicyDecision {
    return {
      action: { type: 'wait', until: FAR_FUTURE },
      diagnosis: null,
      rationale: 'no recovery process',
      confidence: null,
      meta: NO_META,
    };
  },
};

/**
 * Fixed retry schedule, one rail, no messaging: re-present at +24h, +72h and
 * +120h from the first failure and then give up.
 *
 * This is the honest bar. It is roughly what a dunning configuration does out
 * of the box, and beating it is the minimum claim worth making.
 *
 * It does serve the pre-debit notice an e-mandate debit requires. Leaving that
 * out would have made the baseline fail every retry on a compliance
 * precondition and turned it into a strawman - the point of comparison is
 * judgement about timing and targeting, not who is allowed to follow the rules.
 */
const SCHEDULE_HOURS = [24, 72, 120];

export const naiveRetry: Policy = {
  name: 'naive-retry',
  usesLatentState: false,
  decide(input: PolicyInput): PolicyDecision {
    const { observation: obs, permitted } = input;
    const now = input.ctx.now;
    const allowed = new Set(permitted.permitted);

    const decide = (
      action: PolicyDecision['action'],
      rationale: string,
    ): PolicyDecision => ({ action, diagnosis: null, rationale, confidence: null, meta: NO_META });

    if (allowed.size === 1 && allowed.has('stop_terminal')) {
      return decide(
        { type: 'stop_terminal', rule_id: obs.stopped_reason ?? 'STOP_ON_ATTEMPTS_EXHAUSTED', disposition: 'written_off' },
        'gate permits nothing else',
      );
    }

    const firstFailed = obs.invoice.first_failed_at ?? obs.invoice.due_date;
    // Retries beyond the original presentment.
    const retriesMade = Math.max(0, obs.invoice.attempts.length - 1);

    if (retriesMade >= SCHEDULE_HOURS.length) {
      return decide(
        { type: 'stop_terminal', rule_id: 'STOP_ON_ATTEMPTS_EXHAUSTED', disposition: 'written_off' },
        `fixed schedule exhausted after ${retriesMade} retries`,
      );
    }

    const offset = SCHEDULE_HOURS[retriesMade] ?? 120;
    const target: Timestamp = addHours(firstFailed, offset);

    // E-mandate rails need notice served ahead of the presentment, so serve it
    // as soon as the window allows rather than discovering the block at retry
    // time and losing the slot.
    //
    // Serve only when the NOTICE is what is blocking. An earlier version served
    // whenever retry_debit was unavailable for any reason, so a case blocked by
    // RETRY_MIN_GAP got a fresh notice on every wake - 1,949 notices against
    // 787 retries. That inflated the baseline's cost and would have made the
    // agent look better by comparison for no reason of its own.
    const noticeIsBlocker = permitted.excluded.some(
      (e) => e.action_type === 'retry_debit' && e.rule_id === 'PREDEBIT_NOTICE',
    );
    const needsNotice = noticeIsBlocker && allowed.has('serve_predebit_notice');

    if (needsNotice) {
      return decide(
        { type: 'serve_predebit_notice', channel: 'email', for_debit_at: target },
        `serving advance notice for the scheduled retry at ${target}`,
      );
    }

    if (now >= target && allowed.has('retry_debit')) {
      return decide(
        { type: 'retry_debit', rail: obs.subscription.rail, at: now },
        `fixed schedule: retry ${retriesMade + 1} at +${offset}h`,
      );
    }

    if (now < target) {
      return decide({ type: 'wait', until: target }, `waiting for the +${offset}h slot`);
    }

    // Past the slot but still blocked - wait for whatever the gate is holding.
    return decide({ type: 'wait', until: addHours(now, 6) }, 'slot reached but gate still blocking');
  },
};
