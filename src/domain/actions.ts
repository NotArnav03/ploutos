import { z } from 'zod';
import { ChannelSchema, LanguageSchema, RailSchema, TimestampSchema } from './schemas.js';

/**
 * The complete action vocabulary. Nothing outside this union can be executed,
 * which is what makes "the agent chose an action" a bounded statement.
 *
 * The policy engine turns a CaseObservation into the subset of these that is
 * permitted right now, plus a reason for every one it excluded. The agent then
 * picks from the permitted subset. An agent choice outside that subset is
 * rejected and recorded as a violation rather than executed.
 */

// ---- rung-neutral: preconditions and non-escalations -----------------------

export const WaitSchema = z.object({
  type: z.literal('wait'),
  /** When to reconsider this case. */
  until: TimestampSchema,
});

/** Serve the advance notice an e-mandate debit requires. Not an escalation. */
export const ServePredebitNoticeSchema = z.object({
  type: z.literal('serve_predebit_notice'),
  channel: ChannelSchema,
  /** The presentment this notice is for. */
  for_debit_at: TimestampSchema,
});

/** Ask the payer to authenticate a single high-value debit. */
export const RequestAfaSchema = z.object({
  type: z.literal('request_afa'),
  channel: ChannelSchema,
  language: LanguageSchema,
});

// ---- rung 0: silent retry --------------------------------------------------

export const RetryDebitSchema = z.object({
  type: z.literal('retry_debit'),
  rail: RailSchema,
  at: TimestampSchema,
});

// ---- rung 1: retry with a soft notification --------------------------------

export const NotifySoftSchema = z.object({
  type: z.literal('notify_soft'),
  channel: ChannelSchema,
  template_id: z.string(),
  language: LanguageSchema,
});

// ---- rung 2: fix the instrument or move rail -------------------------------

export const RequestInstrumentUpdateSchema = z.object({
  type: z.literal('request_instrument_update'),
  channel: ChannelSchema,
  template_id: z.string(),
  language: LanguageSchema,
});

export const SwitchRailSchema = z.object({
  type: z.literal('switch_rail'),
  to_rail: RailSchema,
  at: TimestampSchema,
});

// ---- rung 3: hand them a way to pay manually -------------------------------

export const SendPaymentLinkSchema = z.object({
  type: z.literal('send_payment_link'),
  channel: ChannelSchema,
  template_id: z.string(),
  language: LanguageSchema,
  expires_at: TimestampSchema,
});

// ---- rung 4: promise to pay ------------------------------------------------

export const CapturePromiseToPaySchema = z.object({
  type: z.literal('capture_promise_to_pay'),
  channel: ChannelSchema,
  language: LanguageSchema,
  /** Date the payer commits to; a retry is scheduled against it. */
  promised_for: TimestampSchema,
});

// ---- rung 5: bounded concession --------------------------------------------

/**
 * Deliberately the ONLY concession in the vocabulary. There is no discount
 * action and no write-down action, so "the agent cannot offer a discount" is a
 * property of the type system rather than a promise in a prompt.
 */
export const GrantGraceSchema = z.object({
  type: z.literal('grant_grace'),
  cycles: z.literal(1),
  new_due_date: TimestampSchema,
});

// ---- rung 6: human ---------------------------------------------------------

export const HandoffHumanSchema = z.object({
  type: z.literal('handoff_human'),
  reason: z.string(),
  /** Written by the agent; the one place free text is the deliverable. */
  case_summary: z.string(),
  priority: z.enum(['low', 'normal', 'high']),
});

// ---- rung 7: terminal ------------------------------------------------------

export const StopTerminalSchema = z.object({
  type: z.literal('stop_terminal'),
  /** Must be a rule_id from the rules registry. */
  rule_id: z.string(),
  disposition: z.enum(['written_off', 'suspended', 'closed_unrecoverable']),
});

// ---- the union -------------------------------------------------------------

export const ActionSchema = z.discriminatedUnion('type', [
  WaitSchema,
  ServePredebitNoticeSchema,
  RequestAfaSchema,
  RetryDebitSchema,
  NotifySoftSchema,
  RequestInstrumentUpdateSchema,
  SwitchRailSchema,
  SendPaymentLinkSchema,
  CapturePromiseToPaySchema,
  GrantGraceSchema,
  HandoffHumanSchema,
  StopTerminalSchema,
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];

export const ACTION_TYPES = [
  'wait',
  'serve_predebit_notice',
  'request_afa',
  'retry_debit',
  'notify_soft',
  'request_instrument_update',
  'switch_rail',
  'send_payment_link',
  'capture_promise_to_pay',
  'grant_grace',
  'handoff_human',
  'stop_terminal',
] as const satisfies readonly ActionType[];

/**
 * Ladder rung per action. `null` means rung-neutral: the action is a
 * precondition or a hold, and taking it does not count as escalating. Serving a
 * pre-debit notice should not consume an escalation step, or compliance would
 * cost the customer a rung.
 */
export const LADDER_RUNG: Record<ActionType, number | null> = {
  wait: null,
  serve_predebit_notice: null,
  request_afa: null,
  retry_debit: 0,
  notify_soft: 1,
  request_instrument_update: 2,
  switch_rail: 2,
  send_payment_link: 3,
  capture_promise_to_pay: 4,
  grant_grace: 5,
  handoff_human: 6,
  stop_terminal: 7,
};

/** Actions that put a message in front of the customer, for contact caps. */
export const CONTACTING_ACTIONS = new Set<ActionType>([
  'serve_predebit_notice',
  'request_afa',
  'notify_soft',
  'request_instrument_update',
  'send_payment_link',
  'capture_promise_to_pay',
]);

/** Actions that present a debit, for retry caps and double-charge checks. */
export const DEBITING_ACTIONS = new Set<ActionType>(['retry_debit', 'switch_rail']);

/**
 * An action the policy engine refused, with the clause that refused it. Carried
 * into the audit trail so a replay can show what was considered and rejected,
 * not merely what was done.
 */
export const ExclusionSchema = z.object({
  action_type: z.enum(ACTION_TYPES),
  rule_id: z.string(),
  detail: z.string(),
});
export type Exclusion = z.infer<typeof ExclusionSchema>;

export const PermittedSetSchema = z.object({
  case_id: z.string(),
  observation_hash: z.string(),
  permitted: z.array(z.enum(ACTION_TYPES)),
  excluded: z.array(ExclusionSchema),
});
export type PermittedSet = z.infer<typeof PermittedSetSchema>;
