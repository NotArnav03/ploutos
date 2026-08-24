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
 *   - `src/agent/**` and `src/policy/**` may NOT import from `src/world/**`
 *
 * tests/boundary.test.ts fails the build if that is ever violated.
 *
 * This module is frozen once the world model is signed off on day 2. Changing
 * it after the agent exists means re-running every baseline, because the world
 * would no longer be the same world the baselines were measured in.
 */

export const IntentSchema = z.enum([
  /** Will pay; the failure is mechanical. */
  'willing',
  /** Will pay but needs a nudge to act. */
  'forgot',
  /** Contests the charge; collection pressure is inappropriate. */
  'disputing',
  /** Has decided to leave; may cancel at any point. */
  'churned',
  /** Cannot pay in this window at any amount. */
  'insolvent',
]);
export type Intent = z.infer<typeof IntentSchema>;

export const ResponsivenessSchema = z.object({
  /** P(acts on a message | delivered on this channel). Per channel. */
  sms: z.number().min(0).max(1),
  email: z.number().min(0).max(1),
  whatsapp: z.number().min(0).max(1),
  inapp: z.number().min(0).max(1),
  /** Multiplier applied per additional contact, modelling nudge fatigue. */
  fatigue_decay: z.number().min(0).max(1),
});
export type Responsiveness = z.infer<typeof ResponsivenessSchema>;

export const LatentStateSchema = z.object({
  subscription_id: z.string(),

  /** Day of month the account is reliably funded. Drives INSUFFICIENT_FUNDS. */
  balance_refill_day: z.number().int().min(1).max(31),
  /** Headroom on refill day. Below the invoice amount, timing cannot save it. */
  available_on_refill_paise: PaiseSchema,

  /** The bank's view, which may differ from the merchant's stored view. */
  true_mandate_status: z.enum(['active', 'revoked', 'expired', 'paused']),
  true_mandate_cap_paise: PaiseSchema,
  /** When a revocation happens, in sim time. Null if it never does. */
  revoked_at: TimestampSchema.nullable(),

  instrument_validity: z.enum(['valid', 'expiring', 'expired', 'blocked']),
  instrument_expires_at: TimestampSchema.nullable(),

  issuer: z.string(),

  /** Rails that would actually work for this payer, for switch_rail truth. */
  working_rails: z.array(RailSchema),

  responsiveness: ResponsivenessSchema,
  intent: IntentSchema,

  /** Sim day this payer pays by other means, bypassing us entirely. */
  out_of_band_payment_at: TimestampSchema.nullable(),
  /** Sim day this payer asks to cancel. */
  cancellation_request_at: TimestampSchema.nullable(),

  /**
   * Whether ANY sequence of permitted actions could have recovered this
   * invoice. Computed by the world, used only by the oracle baseline and by
   * the reporting layer to state the recoverable ceiling honestly. Never
   * exposed through the adapter.
   */
  recoverable: z.boolean(),
  /** Why not, when recoverable is false. Quoted in the report. */
  unrecoverable_reason: z.string().nullable(),
});
export type LatentState = z.infer<typeof LatentStateSchema>;

/**
 * Per-issuer availability over sim time. Correlates ISSUER_UNAVAILABLE across
 * accounts at the same bank, which is what makes fleet-level issuer-health
 * detection a real signal rather than noise the agent pretends to read.
 */
export const IssuerScheduleSchema = z.object({
  issuer: z.string(),
  /** Availability per sim day, indexed from batch start. 1.0 = healthy. */
  availability: z.array(z.number().min(0).max(1)),
});
export type IssuerSchedule = z.infer<typeof IssuerScheduleSchema>;
