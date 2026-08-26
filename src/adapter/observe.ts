import { createHash } from 'node:crypto';
import { canonicalJson } from '../domain/canonical.js';
import type { CaseObservation, IssuerHealth, Invoice, InvoiceStatus } from '../domain/schemas.js';
import { CaseObservationSchema } from '../domain/schemas.js';
import type { Timestamp } from '../domain/time.js';
import type { CaseRuntime } from '../orchestrator/runtime.js';

/**
 * The adapter. This is where ground truth stops.
 *
 * It takes a case's world record plus the runtime state accumulated so far and
 * emits a CaseObservation - the exact bundle any policy downstream is allowed
 * to see. `latent` and `archetype` are simply never read here.
 *
 * The seam is also where a real payment provider would plug in: a Razorpay
 * test-mode adapter satisfies the same signature, which is how the project uses
 * their API without the evaluation depending on it being up.
 */

/** Structural subset of a WorldCase, so this module needs no world import. */
export interface ObservableCase {
  case_id: string;
  customer: CaseObservation['customer'];
  subscription: CaseObservation['subscription'];
  invoice: Invoice;
}

export function observe(args: {
  source: ObservableCase;
  runtime: CaseRuntime;
  now: Timestamp;
  issuer: string;
  issuer_health: IssuerHealth | null;
}): CaseObservation {
  const { source, runtime, now } = args;

  const status: InvoiceStatus = runtime.settled_out_of_band
    ? 'settled_out_of_band'
    : runtime.status === 'recovered'
      ? 'recovered'
      : runtime.dispute_seen_at !== null
        ? 'disputed'
        : runtime.cancellation_seen_at !== null
          ? 'cancelled'
          : runtime.attempts.length > 1
            ? 'in_recovery'
            : 'failed';

  return CaseObservationSchema.parse({
    case_id: source.case_id,
    now,
    invoice: {
      ...source.invoice,
      status,
      attempts: runtime.attempts,
      contacts: runtime.contacts,
      promises: runtime.promises,
    },
    subscription: source.subscription,
    customer: source.customer,
    issuer: args.issuer,
    issuer_health: args.issuer_health,
    ladder_rung: runtime.ladder_rung,
    stopped_reason: runtime.stopped_reason,
  });
}

/**
 * Stable hash of everything a decision could have depended on.
 *
 * Two uses. It keys the LLM decision cache, so a repeated run is free and
 * byte-identical. And it lets a replay prove the agent was shown exactly this
 * and nothing more - if the hash in the audit trail matches a re-derived
 * observation, no extra field leaked in.
 */
export function observationHash(obs: CaseObservation): string {
  return createHash('sha256').update(canonicalJson(obs)).digest('hex').slice(0, 32);
}

