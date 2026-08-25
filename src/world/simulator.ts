import type { Paise } from '../domain/money.js';
import { paise } from '../domain/money.js';
import type { Channel, Rail } from '../domain/schemas.js';
import type { Timestamp } from '../domain/time.js';
import { daysBetween, hoursBetween, localDayOfMonth } from '../domain/time.js';
import type { IssuerSchedule, LatentState } from './latent.js';
import type { Rng } from './rng.js';

/**
 * THE WORLD MODEL.
 *
 * Hand-written, deterministic, seeded. Every outcome in this project is decided
 * here, from latent state the agent cannot see. There is no learned component
 * and no randomness that is not drawn from an addressed substream.
 *
 * This module is FROZEN once day 2 is signed off. Changing it after the agent
 * exists invalidates every baseline, because the baselines would no longer have
 * been measured in the same world. Git history is the evidence for that
 * ordering: this file is committed before src/agent exists.
 *
 * Design rule that matters more than any single line below: the simulator never
 * reads an archetype, a label, or any field that says what the answer should
 * be. It reads mechanism - balances, dates, availability, caps - and derives
 * the code. If it read a planted label, any apparent diagnostic skill in the
 * agent would just be it recovering something we wrote down.
 */

export interface PresentmentInput {
  latent: LatentState;
  issuer: IssuerSchedule;
  /** Sim clock at batch start; day indices are relative to this. */
  start_ts: Timestamp;
  at: Timestamp;
  rail: Rail;
  amount: Paise;
  /** Which presentment this is on the invoice, 1-based. Drives velocity rules. */
  attempt_seq: number;
  /** True once the invoice has been settled by any means. */
  invoice_settled: boolean;
  /** Merchant's mandate record says this needs per-debit authentication. */
  mandate_afa_required: boolean;
  afa_threshold_paise: Paise;
  /** Whether authentication was obtained for this presentment. */
  afa_satisfied: boolean;
  /** When advance notice was last served, if ever. */
  predebit_notice_served_at: Timestamp | null;
  predebit_notice_hours: number;
  timezone: string;
  rng: Rng;
}

export interface PresentmentResult {
  success: boolean;
  /** Null on success. */
  code: string | null;
  settled_paise: Paise;
  /**
   * True when this presentment landed on an already-settled invoice. The money
   * moves - a real gateway would take it - and the caller records the harm.
   * Modelling it as a refusal would understate the worst outcome this system
   * can produce.
   */
  double_charge: boolean;
}

/** Sim day index, 0-based from batch start. */
export function simDay(start: Timestamp, at: Timestamp): number {
  return Math.floor(daysBetween(start, at));
}

function availabilityOn(schedule: readonly number[], day: number): number {
  if (day < 0) return 1;
  const v = schedule[Math.min(day, schedule.length - 1)];
  return v ?? 1;
}

/**
 * Balance available at an instant.
 *
 * Simplification, stated plainly: the account is funded from `balance_refill_day`
 * for `funded_window_days`, and holds `residual_balance_paise` otherwise. Month
 * length is treated as 30 days for the wrap calculation, and refill days are
 * capped at 28 by the schema so the window is always well defined.
 *
 * This is the mechanism that makes retry TIMING the dominant lever for the
 * largest failure category, which is the point of the whole exercise.
 */
export function availableAt(latent: LatentState, at: Timestamp, timezone: string): Paise {
  const day = localDayOfMonth(at, timezone);
  const start = latent.balance_refill_day;
  const end = start + latent.funded_window_days;

  const inWindow = (day >= start && day <= end) || (end > 30 && day <= end - 30);
  return inWindow ? latent.available_on_refill_paise : latent.residual_balance_paise;
}

/**
 * Resolve one presentment.
 *
 * The order of these checks is the world model's central claim and is fixed:
 * a rail rejects on authorisation before it rejects on funds, and rejects on
 * funds before it reports a technical timeout. Reordering changes which code a
 * case exhibits and therefore changes the world.
 */
export function present(input: PresentmentInput): PresentmentResult {
  const { latent, at, amount, rail } = input;
  const fail = (code: string): PresentmentResult => ({
    success: false,
    code,
    settled_paise: paise(0),
    double_charge: false,
  });

  // 0. Already settled. The debit still goes through; that is the harm.
  if (input.invoice_settled) {
    return { success: true, code: null, settled_paise: amount, double_charge: true };
  }

  // 1. Account-level terminal states.
  if (latent.account_closed_at !== null && at >= latent.account_closed_at) {
    return fail('ACCOUNT_CLOSED');
  }
  if (latent.dispute_raised_at !== null && at >= latent.dispute_raised_at) {
    return fail('CUSTOMER_DISPUTE');
  }

  // 2. Authorisation: is there a live mandate covering this debit?
  if (
    latent.true_mandate_status === 'revoked' &&
    (latent.revoked_at === null || at >= latent.revoked_at)
  ) {
    return fail('MANDATE_REVOKED');
  }
  if (latent.true_mandate_status === 'expired' || at > latent.true_valid_till) {
    return fail('MANDATE_EXPIRED');
  }

  // 3. Instrument validity. Card rails only; a UPI mandate has no expiry date
  //    of its own beyond the mandate's.
  if (rail === 'card_on_file') {
    if (latent.instrument_validity === 'blocked') return fail('INSTRUMENT_BLOCKED');
    if (
      latent.instrument_validity === 'expired' ||
      (latent.instrument_expires_at !== null && at > latent.instrument_expires_at)
    ) {
      return fail('INSTRUMENT_EXPIRED');
    }
  }

  // 4. Is the debit within what was authorised?
  if (amount > latent.true_mandate_cap_paise) return fail('MANDATE_CAP_EXCEEDED');

  // 5. Per-debit authentication above the threshold.
  if (
    input.mandate_afa_required &&
    amount >= input.afa_threshold_paise &&
    !input.afa_satisfied
  ) {
    return fail('AFA_REQUIRED');
  }

  // 6. Advance notice, for e-mandate rails.
  if (rail === 'upi_autopay' || rail === 'enach') {
    const served = input.predebit_notice_served_at;
    if (served === null || hoursBetween(served, at) < input.predebit_notice_hours) {
      return fail('PREDEBIT_NOTICE_MISSING');
    }
  }

  const day = simDay(input.start_ts, at);

  // 7. Payer-side PSP availability. UPI only - an alternate rail on the same
  //    account can still work, which is what makes switch_rail meaningful.
  if (rail === 'upi_autopay') {
    const psp = availabilityOn(latent.psp_available_by_day, day);
    if (input.rng.next() > psp) return fail('PSP_DOWN');
  }

  // 8. Issuer health. Correlated across every account at this bank, which is
  //    what makes fleet-level degradation a real signal rather than noise.
  if (input.rng.next() > availabilityOn(input.issuer.availability, day)) {
    return fail('ISSUER_UNAVAILABLE');
  }

  // 9. Velocity rules. Re-presenting into a flag makes later attempts worse,
  //    which is why RISK_COOLOFF exists in the rules registry.
  if (
    latent.risk_flag_after_attempts !== null &&
    input.attempt_seq >= latent.risk_flag_after_attempts
  ) {
    return fail('RISK_HOLD');
  }

  // 10. Rail or issuer per-transaction ceiling.
  if (amount > latent.per_txn_limit_paise) return fail('LIMIT_EXCEEDED');

  // 11. Funds. The dominant category, and a pure timing problem.
  if (availableAt(latent, at, input.timezone) < amount) return fail('INSUFFICIENT_FUNDS');

  // 12. Switch-level flakiness, last because it is the least specific.
  if (input.rng.bool(latent.timeout_probability)) return fail('TXN_TIMEOUT');

  return { success: true, code: null, settled_paise: amount, double_charge: false };
}

// --------------------------------------------------------------- messaging

export interface DeliveryInput {
  latent: LatentState;
  channel: Channel;
  /** Contacts already made on this invoice, for fatigue. */
  prior_contacts: number;
  /**
   * Whether the message asks the payer to do something that moves money
   * (pay a link, update an instrument) as opposed to a notice.
   */
  actionable: boolean;
  rng: Rng;
}

export interface DeliveryResult {
  /** Whether the payer acted: clicked, paid, updated, replied. */
  acted: boolean;
  /** Probability used, recorded so a replay can show why a nudge failed. */
  p_acted: number;
}

/**
 * Whether a message lands.
 *
 * Intent gates hard. A payer who is disputing or has churned does not respond
 * to a payment nudge however well written it is, which is what stops "send more
 * messages" from being a winning strategy and makes the contact caps bite.
 */
export function deliver(input: DeliveryInput): DeliveryResult {
  const { latent, channel } = input;

  let p = latent.responsiveness[channel];
  p *= Math.pow(latent.responsiveness.fatigue_decay, input.prior_contacts);

  if (input.actionable) {
    switch (latent.intent) {
      case 'disputing':
      case 'churned':
        p = 0;
        break;
      case 'insolvent':
        // Willing to engage, unable to fund. They may respond; it will not pay.
        p *= 0.3;
        break;
      case 'forgot':
        p *= 1.25;
        break;
      case 'willing':
        break;
    }
  }

  p = Math.min(1, Math.max(0, p));
  return { acted: input.rng.bool(p), p_acted: p };
}
