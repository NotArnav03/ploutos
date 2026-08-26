import { paise, type Paise } from '../domain/money.js';
import type { Attempt, Contact, PromiseToPay } from '../domain/schemas.js';
import { CHAIN_ROOT } from '../domain/audit.js';
import type { Timestamp } from '../domain/time.js';

/**
 * Mutable per-case state for one run.
 *
 * Everything here is OBSERVABLE - it is what a merchant's own system would
 * record about a recovery in progress. Ground truth stays in the WorldCase and
 * is read only by the simulator and the oracle.
 *
 * `settled_out_of_band` deserves its own flag rather than being folded into
 * `settled_paise`: money arriving by another route is the single situation
 * where continuing to act causes real harm, and the audit trail needs to show
 * that the loop knew the difference.
 */
export type CaseStatus = 'open' | 'recovered' | 'stopped' | 'escalated';

export interface CaseRuntime {
  case_id: string;
  status: CaseStatus;

  attempts: Attempt[];
  contacts: Contact[];
  promises: PromiseToPay[];

  /** Highest rung reached, for LADDER_MONOTONIC. */
  ladder_rung: number;
  /** rule_id of the stop that fired, once one has. */
  stopped_reason: string | null;

  /** When the orchestrator should next consider this case. */
  next_wake: Timestamp;

  settled_paise: Paise;
  settled_out_of_band: boolean;
  /** Mechanical cost only. Goodwill is computed at report time. */
  cost_paise: Paise;

  /** Compliance preconditions carried between actions. */
  predebit_notice_served_at: Timestamp | null;
  afa_satisfied: boolean;
  grace_grants: number;

  /** Ledger chain position for this case. */
  seq: number;
  prev_hash: string;

  // Counters. Gate rejections and harm are deliberately separate: a refused
  // choice means the gate did its job, and counting it as harm would report a
  // working safety mechanism as a failure.
  /** Choices the gate refused before execution. Not harm: the system worked. */
  gate_rejections: number;
  /** Wakes where the policy neither acted nor scheduled anything. */
  stalled_steps: number;
  /** Harm rules actually breached in execution. Must be zero in a valid run. */
  harm_events: number;
  double_charge_attempts: number;
  fallbacks: number;

  /** Set when the world has told us something we could observe. */
  cancellation_seen_at: Timestamp | null;
  dispute_seen_at: Timestamp | null;
}

export function newRuntime(caseId: string, firstAttempt: Attempt, wake: Timestamp): CaseRuntime {
  return {
    case_id: caseId,
    status: 'open',
    attempts: [firstAttempt],
    contacts: [],
    promises: [],
    ladder_rung: 0,
    stopped_reason: null,
    next_wake: wake,
    settled_paise: paise(0),
    settled_out_of_band: false,
    cost_paise: paise(0),
    predebit_notice_served_at: null,
    afa_satisfied: false,
    grace_grants: 0,
    seq: 0,
    prev_hash: CHAIN_ROOT,
    double_charge_attempts: 0,
    gate_rejections: 0,
    stalled_steps: 0,
    harm_events: 0,
    fallbacks: 0,
    cancellation_seen_at: null,
    dispute_seen_at: null,
  };
}

export function isClosed(rt: CaseRuntime): boolean {
  return rt.status !== 'open';
}

/** Presentments made on this invoice, including the day-0 failure. */
export function attemptCount(rt: CaseRuntime): number {
  return rt.attempts.length;
}

export function lastAttempt(rt: CaseRuntime): Attempt | undefined {
  return rt.attempts[rt.attempts.length - 1];
}

export function contactsInWindow(
  rt: CaseRuntime,
  now: Timestamp,
  windowHours: number,
  channel?: string,
): number {
  const cutoffMs = Date.parse(now) - windowHours * 3_600_000;
  return rt.contacts.filter(
    (c) => Date.parse(c.ts) >= cutoffMs && (channel === undefined || c.channel === channel),
  ).length;
}
