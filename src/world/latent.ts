import { z } from 'zod';
import { PaiseSchema } from '../domain/money.js';
import { RailSchema, TimestampSchema } from '../domain/schemas.js';

/**
 * GROUND TRUTH. The agent must never see any of this.
 *
 * These are the variables the simulator resolves outcomes from. A real merchant
 * cannot observe them: they cannot see the payer's salary date, cannot see that
 * a mandate was revoked at the bank until a debit is declined, cannot see
 * whether the payer intends to pay or has quietly churned.
 *
 * The whole evaluation rests on the agent inferring these from the observable
 * record. If it could read them, every number the project reports would be
 * meaningless. The separation is therefore structural, not a convention:
 *
 *   - `src/world/**` may import from `src/domain/**`
 *   - `src/agent/**`, `src/policy/**` and `src/domain/**` may NOT import from
 *     `src/world/**`
 *   - `src/eval/**` may, because it is harness code rather than decision code
 *
 * tests/boundary.test.ts fails the build if that is ever violated.
 *
 * The field set is driven by what the simulator needs to decide an outcome
 * mechanically. Every field below is read by src/world/simulator.ts; none is a
 * label the simulator reads back to itself.
 */

export const IntentSchema = z.enum([
  /** Will pay; the failure is mechanical. */
  'willing',
  /** Will pay but needs a nudge to act on a link or an update request. */
  'forgot',
  /** Contests the charge; collection pressure is inappropriate. */
  'disputing',
  /** Has decided to leave; may cancel at any point. */
  'churned',
  /** Cannot fund this invoice in this window at any timing. */
  'insolvent',
]);
export type Intent = z.infer<typeof IntentSchema>;

export const ResponsivenessSchema = z.object({
  /** P(acts on a message | delivered on this channel), before fatigue. */
  sms: z.number().min(0).max(1),
  email: z.number().min(0).max(1),
  whatsapp: z.number().min(0).max(1),
  inapp: z.number().min(0).max(1),
  /** Multiplier applied per prior contact, modelling nudge fatigue. */
  fatigue_decay: z.number().min(0).max(1),
});
export type Responsiveness = z.infer<typeof ResponsivenessSchema>;

export const LatentStateSchema = z.object({
  subscription_id: z.string(),
  issuer: z.string(),

  // ---------------------------------------------------------------- funding
  /** Day of month the account is reliably funded. Usually payday. */
  balance_refill_day: z.number().int().min(1).max(28),
  /** Balance available once refilled. Below the invoice, timing cannot help. */
  available_on_refill_paise: PaiseSchema,
  /** How many days the refilled balance survives before it is spent down. */
  funded_window_days: z.number().int().min(1).max(28),
  /** Balance outside the funded window. */
  residual_balance_paise: PaiseSchema,
  /** Per-transaction ceiling imposed by the rail or issuer. */
  per_txn_limit_paise: PaiseSchema,

  // -------------------------------------------------------- mandate truth
  /** The bank's view, which the merchant's stored view may lag. */
  true_mandate_status: z.enum(['active', 'revoked', 'expired', 'paused']),
  true_mandate_cap_paise: PaiseSchema,
  /** When revocation takes effect. Null if it never happens. */
  revoked_at: TimestampSchema.nullable(),
  /** The bank's expiry, which can differ from the merchant's record. */
  true_valid_till: TimestampSchema,

  // ------------------------------------------------------------ instrument
  instrument_validity: z.enum(['valid', 'expiring', 'expired', 'blocked']),
  instrument_expires_at: TimestampSchema.nullable(),

  // ----------------------------------------------------------------- rails
  /** Rails that would actually work for this payer, for switch_rail truth. */
  working_rails: z.array(RailSchema),
  /** Payer-side PSP availability per sim day. UPI only; 1.0 elsewhere. */
  psp_available_by_day: z.array(z.number().min(0).max(1)),

  // ------------------------------------------------- risk and flakiness
  /** Presentment count after which the issuer's velocity rules bite. Null = never. */
  risk_flag_after_attempts: z.number().int().positive().nullable(),
  /** P(switch-level timeout) on any presentment. */
  timeout_probability: z.number().min(0).max(1),

  // ------------------------------------------------------------ behaviour
  responsiveness: ResponsivenessSchema,
  intent: IntentSchema,

  // -------------------------------------------------------------- events
  /** When this payer settles by other means, bypassing us entirely. */
  out_of_band_payment_at: TimestampSchema.nullable(),
  /** When this payer asks to cancel. */
  cancellation_request_at: TimestampSchema.nullable(),
  /** When the underlying account closes or freezes. */
  account_closed_at: TimestampSchema.nullable(),
  /** When the payer formally disputes. */
  dispute_raised_at: TimestampSchema.nullable(),
});
export type LatentState = z.infer<typeof LatentStateSchema>;

/**
 * NOTE - there is deliberately no `recoverable` field here.
 *
 * An earlier draft carried `recoverable: boolean` plus a reason string, set by
 * the generator. That would have made the denominator of the headline metric a
 * number we typed: the report would say "recovered 68% of what was recoverable"
 * where "recoverable" meant "whatever the generator asserted". It is precisely
 * the grading-our-own-homework failure this project exists to avoid, and it is
 * invisible in the output.
 *
 * Recoverability is therefore DERIVED, not declared. The oracle policy searches
 * over permitted action sequences against this latent state, through the same
 * simulator every other policy runs against, and whatever it recovers is the
 * ceiling. That makes the denominator a reproducible search result.
 *
 * It also buys a real invariant: if any observation-only policy ever recovers
 * more than the oracle, the oracle's search is incomplete and the ceiling is
 * wrong, so the run is invalid and must not be reported. See
 * OracleViolationError in src/domain/policy.ts.
 */

/**
 * Per-issuer availability over sim time. Correlates ISSUER_UNAVAILABLE across
 * accounts at the same bank, which is what makes fleet-level issuer-health
 * detection a real signal rather than noise the agent pretends to read.
 *
 * Issuers are anonymised as ISSUER_01..ISSUER_NN with a size tier. Using real
 * bank names would add nothing the agent can reason about - it reasons about
 * observed health, not identity - and would risk reading as a claim about those
 * institutions' actual reliability.
 */
export const IssuerScheduleSchema = z.object({
  issuer: z.string(),
  tier: z.enum(['large', 'mid', 'small']),
  /** Availability per sim day, indexed from batch start. 1.0 = healthy. */
  availability: z.array(z.number().min(0).max(1)),
});
export type IssuerSchedule = z.infer<typeof IssuerScheduleSchema>;
