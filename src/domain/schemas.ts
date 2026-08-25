import { z } from 'zod';
import { PaiseSchema } from './money.js';
import { TimestampSchema } from './time.js';

export { TimestampSchema } from './time.js';
export type { Timestamp } from './time.js';

/**
 * The OBSERVABLE domain: everything a real merchant could see about a failing
 * subscription, and nothing else.
 *
 * The boundary this file draws is the central honesty claim of the project.
 * Ground truth about whether a debit can succeed lives in `src/world/latent.ts`
 * and is never imported here. If the agent could see a latent field, the
 * evaluation would be meaningless, so the separation is structural rather than
 * a matter of discipline: `src/agent` and `src/policy` may import this module;
 * neither may import `src/world`. Enforced by tests/boundary.test.ts.
 *
 * Nullable is preferred over optional throughout, so that records survive a
 * JSONL round-trip with the same shape they had in memory.
 */

// ---------------------------------------------------------------- primitives

export const RailSchema = z.enum(['upi_autopay', 'enach', 'card_on_file']);
export type Rail = z.infer<typeof RailSchema>;

export const ChannelSchema = z.enum(['sms', 'email', 'whatsapp', 'inapp']);
export type Channel = z.infer<typeof ChannelSchema>;

export const FailureClassSchema = z.enum(['soft', 'soft_action', 'soft_compliance', 'hard']);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const RemedySchema = z.enum([
  'retime',
  'cool_off',
  'update_instrument',
  'amend_mandate',
  'serve_notice',
  'request_afa',
  'switch_rail',
  'none',
]);
export type Remedy = z.infer<typeof RemedySchema>;

export const SegmentSchema = z.enum(['b2c', 'smb']);
export type Segment = z.infer<typeof SegmentSchema>;

export const LanguageSchema = z.enum(['en', 'hinglish', 'hi']);
export type Language = z.infer<typeof LanguageSchema>;

// ----------------------------------------------------------------- customer

export const ChannelStateSchema = z.object({
  reachable: z.boolean(),
  /** Recorded consent to be contacted on this channel for billing matters. */
  consent: z.boolean(),
  /** Do-not-disturb registration, suppressing collection messaging. */
  dnd: z.boolean(),
});
export type ChannelState = z.infer<typeof ChannelStateSchema>;

/**
 * All four channels, always present.
 *
 * Deliberately an explicit object rather than `z.record(ChannelSchema, ...)`.
 * A record with enum keys parses happily when keys are missing, so a generator
 * bug would model a customer as silently unreachable on email rather than
 * failing loudly — and "we never contacted them" would then read as a policy
 * decision in the audit trail instead of a defect.
 */
export const ChannelMapSchema = z.object({
  sms: ChannelStateSchema,
  email: ChannelStateSchema,
  whatsapp: ChannelStateSchema,
  inapp: ChannelStateSchema,
});
export type ChannelMap = z.infer<typeof ChannelMapSchema>;

export const CustomerSchema = z.object({
  id: z.string(),
  segment: SegmentSchema,
  tenure_months: z.number().int().nonnegative(),
  ltv_paise: PaiseSchema,
  /** Failures and recoveries on prior invoices. Observable payment history. */
  prior_failures: z.number().int().nonnegative(),
  prior_recoveries: z.number().int().nonnegative(),
  state: z.string(),
  language_pref: LanguageSchema,
  channels: ChannelMapSchema,
});
export type Customer = z.infer<typeof CustomerSchema>;

// ----------------------------------------------------------------- mandate

export const MandateStatusSchema = z.enum(['active', 'paused', 'revoked', 'expired']);
export type MandateStatus = z.infer<typeof MandateStatusSchema>;

/**
 * What the merchant knows about the mandate. Note this can be STALE: a payer
 * may revoke at their bank and the merchant only learns of it from a decline.
 * That staleness is deliberate and is what makes MANDATE_ACTIVE_REQUIRED a
 * meaningful rule rather than a tautology.
 */
export const MandateSchema = z.object({
  ref: z.string(),
  status: MandateStatusSchema,
  max_amount_paise: PaiseSchema,
  valid_till: TimestampSchema,
  created_at: TimestampSchema,
  /** Whether this mandate requires per-debit authentication above threshold. */
  afa_required: z.boolean(),
  /** When advance notice was last served for an upcoming debit, if ever. */
  last_predebit_notice_at: TimestampSchema.nullable(),
});
export type Mandate = z.infer<typeof MandateSchema>;

// -------------------------------------------------------------- subscription

export const PlanSchema = z.object({
  amount_paise: PaiseSchema,
  interval: z.enum(['monthly', 'quarterly', 'annual']),
});
export type Plan = z.infer<typeof PlanSchema>;

export const SubscriptionSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  plan: PlanSchema,
  rail: RailSchema,
  mandate: MandateSchema,
  started_at: TimestampSchema,
  cycles_completed: z.number().int().nonnegative(),
  /** Rails the payer has an alternate instrument on, for switch_rail. */
  alternate_rails: z.array(RailSchema),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

// ------------------------------------------------------------------ attempts

export const AttemptSchema = z.object({
  id: z.string(),
  invoice_id: z.string(),
  seq: z.number().int().positive(),
  ts: TimestampSchema,
  rail: RailSchema,
  amount_paise: PaiseSchema,
  /** null on a successful presentment. */
  code: z.string().nullable(),
  class: FailureClassSchema.nullable(),
  remedy: RemedySchema.nullable(),
  succeeded: z.boolean(),
  /** Earliest time this code permits another presentment. */
  retry_allowed_after: TimestampSchema.nullable(),
  description: z.string(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const ContactSchema = z.object({
  id: z.string(),
  invoice_id: z.string(),
  ts: TimestampSchema,
  channel: ChannelSchema,
  template_id: z.string(),
  language: LanguageSchema,
  /** Whether the customer demonstrably acted on it (clicked, paid, replied). */
  acted_on: z.boolean(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const PromiseToPaySchema = z.object({
  id: z.string(),
  invoice_id: z.string(),
  captured_at: TimestampSchema,
  promised_for: TimestampSchema,
  status: z.enum(['open', 'kept', 'broken']),
});
export type PromiseToPay = z.infer<typeof PromiseToPaySchema>;

// ------------------------------------------------------------------- invoice

export const InvoiceStatusSchema = z.enum([
  'due',
  'failed',
  'in_recovery',
  'recovered',
  'settled_out_of_band',
  'written_off',
  'cancelled',
  'disputed',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const InvoiceSchema = z.object({
  id: z.string(),
  subscription_id: z.string(),
  customer_id: z.string(),
  amount_paise: PaiseSchema,
  due_date: TimestampSchema,
  status: InvoiceStatusSchema,
  first_failed_at: TimestampSchema.nullable(),
  attempts: z.array(AttemptSchema),
  contacts: z.array(ContactSchema),
  promises: z.array(PromiseToPaySchema),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

// ------------------------------------------------------- fleet-level signals

/**
 * Issuer health, aggregated across the batch. This is the "payment degradation
 * root cause" example direction folded in as an INPUT to recovery timing rather
 * than as a standalone deliverable. It is observable because a real merchant
 * can compute it from their own decline stream.
 */
export const IssuerHealthSchema = z.object({
  issuer: z.string(),
  window_hours: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  failure_rate: z.number().min(0).max(1),
  /** Failure rate over the trailing baseline, for degradation detection. */
  baseline_failure_rate: z.number().min(0).max(1),
  degraded: z.boolean(),
});
export type IssuerHealth = z.infer<typeof IssuerHealthSchema>;

// --------------------------------------------------------------- observation

/**
 * The exact bundle handed to the policy engine and, downstream of it, to the
 * agent. If a field is not on this object, no decision in this system can
 * depend on it. Hashed into the audit trail as `observation_hash`.
 */
export const CaseObservationSchema = z.object({
  case_id: z.string(),
  now: TimestampSchema,
  invoice: InvoiceSchema,
  subscription: SubscriptionSchema,
  customer: CustomerSchema,
  issuer: z.string(),
  issuer_health: IssuerHealthSchema.nullable(),
  /** Highest ladder rung reached so far, for LADDER_MONOTONIC. */
  ladder_rung: z.number().int().min(0).max(7),
  /** Set once a stop rule has fired; no further action may be taken. */
  stopped_reason: z.string().nullable(),
});
export type CaseObservation = z.infer<typeof CaseObservationSchema>;
