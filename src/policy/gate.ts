import { z } from 'zod';
import type { ActionType, Exclusion } from '../domain/actions.js';
import { ACTION_TYPES } from '../domain/actions.js';
import type { PolicyCheck } from '../domain/audit.js';
import type { CaseObservation, Rail } from '../domain/schemas.js';
import type { RuleRegistry } from '../domain/rules.js';
import type { TaxonomyIndex } from '../domain/taxonomy.js';
import { epochMs, hoursBetween, daysBetween, type Timestamp } from '../domain/time.js';
import type { CaseRuntime } from '../orchestrator/runtime.js';

/**
 * The eligibility gate. Pure functions over the observable record.
 *
 * No LLM reaches this file and none ever will. The gate produces the set of
 * actions that are permitted right now and, for everything it refuses, the
 * rule_id that refused it. Downstream, a policy - deterministic or otherwise -
 * chooses only from `permitted`. A choice outside that set is rejected and
 * recorded as a violation rather than executed.
 *
 * SCOPE, DAY 3: this implements the rules the recovery loop needs in order to
 * terminate correctly and to re-present a debit legitimately. The contact
 * discipline rules (CONSENT_REQUIRED, DND_SUPPRESSION, CONTACT_HOURS,
 * CONTACT_CHANNEL_RATE, CONTACT_LIFETIME_CAP), the ladder rules and the
 * authority bounds land on day 4, when the policies that can send messages
 * arrive. Until then no implemented policy can contact anyone, so the gap
 * changes no result. The list is tracked in DAY4_PENDING below and asserted in
 * tests, so it cannot be quietly forgotten.
 */

export const DAY4_PENDING: readonly string[] = [
  'CONSENT_REQUIRED',
  'DND_SUPPRESSION',
  'CONTACT_HOURS',
  'CONTACT_CHANNEL_RATE',
  'CONTACT_LIFETIME_CAP',
  'LADDER_MONOTONIC',
  'P2P_SINGLE',
  'GRACE_CAP',
  'NO_REFUND',
  'NO_MANDATE_INCREASE',
  'NO_DISCOUNT',
  'NO_VOICE',
  'NO_THIRD_PARTY_CONTACT',
];

export interface GateInput {
  observation: CaseObservation;
  runtime: CaseRuntime;
  registry: RuleRegistry;
  taxonomy: TaxonomyIndex;
  now: Timestamp;
}

export interface GateResult {
  permitted: ActionType[];
  excluded: Exclusion[];
  checks: PolicyCheck[];
  /** Non-null when a stop rule fired. The case must close. */
  stop: { rule_id: string; detail: string } | null;
}

export function computePermitted(input: GateInput): GateResult {
  const { observation: obs, runtime: rt, registry, taxonomy, now } = input;

  const excluded: Exclusion[] = [];
  const checks: PolicyCheck[] = [];
  const blocked = new Set<ActionType>();

  const block = (action: ActionType, rule_id: string, detail: string): void => {
    if (!blocked.has(action)) {
      blocked.add(action);
      excluded.push({ action_type: action, rule_id, detail });
    }
  };
  const pass = (rule_id: string, detail: string): void => {
    checks.push({ rule_id, verdict: 'pass', detail });
  };

  // ------------------------------------------------------------- stop rules
  // Checked first and in this order: settlement outranks everything, because
  // acting after it is the only outcome here that takes money it should not.
  const stop = firstStop(input);
  if (stop !== null) {
    checks.push({ rule_id: stop.rule_id, verdict: 'block', detail: stop.detail });
    return {
      permitted: ['stop_terminal'],
      excluded: ACTION_TYPES.filter((a) => a !== 'stop_terminal').map((a) => ({
        action_type: a,
        rule_id: stop.rule_id,
        detail: stop.detail,
      })),
      checks,
      stop,
    };
  }

  const rail = obs.subscription.rail;
  const amount = obs.invoice.amount_paise;
  const mandate = obs.subscription.mandate;

  // ------------------------------------------------- authorisation to debit
  if (mandate.status !== 'active') {
    block('retry_debit', 'MANDATE_ACTIVE_REQUIRED', `mandate is ${mandate.status}`);
    block('switch_rail', 'MANDATE_ACTIVE_REQUIRED', `mandate is ${mandate.status}`);
  } else {
    pass('MANDATE_ACTIVE_REQUIRED', 'mandate active on the merchant record');
  }

  if (now > mandate.valid_till) {
    const detail = `mandate valid_till ${mandate.valid_till} has passed`;
    block('retry_debit', 'MANDATE_VALIDITY_WINDOW', detail);
    block('switch_rail', 'MANDATE_VALIDITY_WINDOW', detail);
  } else {
    pass('MANDATE_VALIDITY_WINDOW', `valid until ${mandate.valid_till}`);
  }

  if (amount > mandate.max_amount_paise) {
    // Re-presenting the same amount is guaranteed to fail, and raising the cap
    // is a customer re-authorisation that leaves the agent's authority.
    const detail = `invoice ${amount} exceeds mandate cap ${mandate.max_amount_paise}`;
    block('retry_debit', 'MANDATE_CAP_RESPECTED', detail);
    block('switch_rail', 'MANDATE_CAP_RESPECTED', detail);
  } else {
    pass('MANDATE_CAP_RESPECTED', `within cap ${mandate.max_amount_paise}`);
  }

  // ------------------------------------------------------- retry discipline
  const railCaps = registry.require('RETRY_CAP_PER_INVOICE').params as Record<string, unknown>;
  const cap = z.number().int().positive().parse(railCaps[rail]);
  const used = rt.attempts.length;
  if (used >= cap) {
    block('retry_debit', 'RETRY_CAP_PER_INVOICE', `${used} of ${cap} presentments used on ${rail}`);
    block('switch_rail', 'RETRY_CAP_PER_INVOICE', `${used} of ${cap} presentments used`);
  } else {
    pass('RETRY_CAP_PER_INVOICE', `${used} of ${cap} presentments used`);
  }

  const last = rt.attempts[rt.attempts.length - 1];
  if (last?.code) {
    const gapNeeded = taxonomy.minGapHours(last.code);
    const elapsed = hoursBetween(last.ts, now);
    if (elapsed < gapNeeded) {
      const detail = `${elapsed.toFixed(1)}h since ${last.code}, needs ${gapNeeded}h`;
      block('retry_debit', 'RETRY_MIN_GAP', detail);
      block('switch_rail', 'RETRY_MIN_GAP', detail);
    } else {
      pass('RETRY_MIN_GAP', `${elapsed.toFixed(1)}h elapsed, needs ${gapNeeded}h`);
    }

    // Re-presenting into a velocity block reinforces the flag and makes later
    // attempts worse, so the cooling-off is longer than the code's own gap.
    if (last.code === 'RISK_HOLD') {
      const cool = registry.param('RISK_COOLOFF', 'hours', z.number().positive());
      if (elapsed < cool) {
        const detail = `risk hold ${elapsed.toFixed(1)}h ago, cooling off for ${cool}h`;
        block('retry_debit', 'RISK_COOLOFF', detail);
        block('switch_rail', 'RISK_COOLOFF', detail);
      }
    }
  }

  // ------------------------------------------------- compliance preconditions
  if (rail === 'upi_autopay' || rail === 'enach') {
    const noticeHours = registry.param('PREDEBIT_NOTICE', 'notice_hours', z.number().nonnegative());
    const served = rt.predebit_notice_served_at;
    const ok = served !== null && hoursBetween(served, now) >= noticeHours;
    if (!ok) {
      block(
        'retry_debit',
        'PREDEBIT_NOTICE',
        served === null
          ? `no advance notice served; ${noticeHours}h required before an e-mandate debit`
          : `notice served ${hoursBetween(served, now).toFixed(1)}h ago, needs ${noticeHours}h`,
      );
    } else {
      pass('PREDEBIT_NOTICE', `notice served ${hoursBetween(served, now).toFixed(1)}h ago`);
    }
  }

  const afaThreshold = registry.param(
    'AFA_THRESHOLD',
    'threshold_paise',
    z.number().int().nonnegative(),
  );
  if (mandate.afa_required && amount >= afaThreshold && !rt.afa_satisfied) {
    block(
      'retry_debit',
      'AFA_THRESHOLD',
      `${amount} is at or above the ${afaThreshold} threshold and is not authenticated`,
    );
  }

  // --------------------------------------------------------------- idempotency
  // A duplicate failure event must not produce a second action. Two presentments
  // at the same instant on the same invoice is the observable signature.
  if (last && epochMs(last.ts) === epochMs(now)) {
    block('retry_debit', 'IDEMPOTENT_ATTEMPT', `an attempt is already recorded at ${now}`);
  }

  // ---------------------------------------------------- rail switch feasibility
  if (obs.subscription.alternate_rails.length === 0) {
    block('switch_rail', 'MANDATE_ACTIVE_REQUIRED', 'no alternate rail on file for this payer');
  }

  const permitted = ACTION_TYPES.filter((a) => !blocked.has(a));
  return { permitted, excluded, checks, stop: null };
}

/**
 * The first stop rule that applies, in priority order. Settlement is checked
 * before everything else: continuing after money has arrived is the one failure
 * mode here that actively harms a payer rather than merely wasting effort.
 */
function firstStop(input: GateInput): { rule_id: string; detail: string } | null {
  const { observation: obs, runtime: rt, registry, taxonomy, now } = input;

  if (rt.settled_out_of_band) {
    return {
      rule_id: 'STOP_ON_SETTLED',
      detail: 'invoice settled outside our flow; any presentment now is a double charge',
    };
  }
  if (rt.status === 'recovered' || rt.settled_paise > 0) {
    return { rule_id: 'STOP_ON_SETTLED', detail: 'invoice already settled' };
  }
  if (rt.dispute_seen_at !== null) {
    return { rule_id: 'STOP_ON_DISPUTE', detail: `payer disputed at ${rt.dispute_seen_at}` };
  }
  if (rt.cancellation_seen_at !== null) {
    return {
      rule_id: 'STOP_ON_CANCELLATION',
      detail: `payer requested cancellation at ${rt.cancellation_seen_at}`,
    };
  }

  const last = rt.attempts[rt.attempts.length - 1];
  if (last?.code && taxonomy.isHard(last.code)) {
    return {
      rule_id: 'STOP_ON_HARD_DECLINE',
      detail: `${last.code} is terminal; no presentment can succeed`,
    };
  }

  const maxAge = registry.param('STOP_ON_INVOICE_AGE', 'max_age_days', z.number().positive());
  const age = daysBetween(obs.invoice.due_date, now);
  if (age > maxAge) {
    return {
      rule_id: 'STOP_ON_INVOICE_AGE',
      detail: `invoice is ${age.toFixed(1)} days old, limit ${maxAge}`,
    };
  }

  const railCaps = registry.require('RETRY_CAP_PER_INVOICE').params as Record<string, unknown>;
  const cap = z.number().int().positive().parse(railCaps[obs.subscription.rail as Rail]);
  if (rt.attempts.length >= cap && !canStillContact(rt)) {
    return {
      rule_id: 'STOP_ON_ATTEMPTS_EXHAUSTED',
      detail: `${rt.attempts.length} of ${cap} presentments used and no contact budget left`,
    };
  }

  return null;
}

/**
 * Placeholder until the contact rules land on day 4. Today no implemented
 * policy sends messages, so this is always false and STOP_ON_ATTEMPTS_EXHAUSTED
 * fires purely on the retry cap.
 */
function canStillContact(_rt: CaseRuntime): boolean {
  return false;
}
