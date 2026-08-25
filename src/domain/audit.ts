import { z } from 'zod';
import { ActionSchema, ExclusionSchema, ACTION_TYPES } from './actions.js';
import { PaiseDeltaSchema, PaiseSchema } from './money.js';
import { TimestampSchema } from './time.js';

/**
 * The audit event schema.
 *
 * Defined on day 2 rather than day 5 on purpose: this is a contract between
 * four modules that are built on different days. The simulator writes outcome
 * events, the policy engine writes eligibility events, the agent writes
 * decision events, and the metrics layer reads all of them. Deferring the
 * schema until the ledger is implemented would mean days 2-3 inventing private
 * logging formats and then rewriting them.
 *
 * Two properties make this more than a log file.
 *
 * `excluded` records the actions the policy engine refused AND the rule_id that
 * refused each one. It costs almost nothing to capture and it converts the
 * trail from "what happened" into "what was considered, what was forbidden, and
 * by which clause". That is the actual answer to the brief's demand that any
 * single recovery decision be explainable.
 *
 * `prev_hash`/`hash` chain the records so tampering is detectable. This is a
 * Merkle-style integrity chain over a local JSONL file - the same idea as a
 * tamper-evident log. There is no chain, no consensus and no token anywhere in
 * this project. See docs/DECISIONS.md D-005.
 */

export const ActorSchema = z.enum([
  'policy_engine',
  'llm_agent',
  'simulator',
  'orchestrator',
  'human',
]);
export type Actor = z.infer<typeof ActorSchema>;

export const EventTypeSchema = z.enum([
  /** A case entered the loop, or its observable state was refreshed. */
  'observation',
  /** The policy engine computed the permitted and excluded sets. */
  'eligibility',
  /** A policy (deterministic or LLM) chose an action. */
  'decision',
  /** The chosen action was executed against the world. */
  'action',
  /** The world resolved an outcome. */
  'outcome',
  /** A stop rule fired; the case is closed. */
  'stop',
  /** A rule was breached, or an LLM choice fell outside the permitted set. */
  'violation',
  /** The case left the agent for a human. */
  'handoff',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const PolicyCheckSchema = z.object({
  rule_id: z.string(),
  verdict: z.enum(['pass', 'block', 'not_applicable']),
  detail: z.string(),
});
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const DecisionRecordSchema = z.object({
  action: ActionSchema,
  /** Root cause as the deciding policy understood it. Free text from the LLM. */
  diagnosis: z.string().nullable(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  /** Name of the policy that decided: naive-retry, static-policy, agent, oracle. */
  policy: z.string(),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  tokens_in: z.number().int().nonnegative().nullable(),
  tokens_out: z.number().int().nonnegative().nullable(),
  latency_ms: z.number().nonnegative().nullable(),
  cache_hit: z.boolean(),
  /**
   * True when the policy's own choice was rejected by the gate and a
   * deterministic fallback was substituted. Reported as a headline number,
   * because a gate that never fires is a gate nobody tested.
   */
  fell_back: z.boolean(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const OutcomeRecordSchema = z.object({
  status: z.enum(['success', 'failure', 'no_response', 'deferred']),
  code: z.string().nullable(),
  settled_paise: PaiseSchema.nullable(),
});
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

export const ViolationRecordSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(['critical', 'high', 'medium']),
  /** Whether this rule counts toward the harm metrics that invalidate a run. */
  harm: z.boolean(),
  attempted_action: z.enum(ACTION_TYPES).nullable(),
  detail: z.string(),
});
export type ViolationRecord = z.infer<typeof ViolationRecordSchema>;

export const AuditEventSchema = z.object({
  // ---- identity
  event_id: z.string(),
  run_id: z.string(),
  case_id: z.string(),
  /** Monotonic within a case, starting at 1. */
  seq: z.number().int().positive(),

  // ---- time
  /** Simulated clock. This is the one that matters for policy. */
  ts_sim: TimestampSchema,
  /** Real clock, for cost and latency reporting only. */
  ts_wall: TimestampSchema,

  // ---- what happened
  actor: ActorSchema,
  event_type: EventTypeSchema,

  /**
   * Hash of the CaseObservation the decision was made from. Two events with
   * the same observation_hash saw exactly the same world, which is what makes
   * the LLM decision cache sound and what lets a replay prove the agent was
   * not shown anything extra.
   */
  observation_hash: z.string().nullable(),

  // ---- the gate
  permitted: z.array(z.enum(ACTION_TYPES)).nullable(),
  excluded: z.array(ExclusionSchema).nullable(),
  policy_checks: z.array(PolicyCheckSchema).nullable(),

  // ---- the choice and its consequence
  decision: DecisionRecordSchema.nullable(),
  outcome: OutcomeRecordSchema.nullable(),
  violation: ViolationRecordSchema.nullable(),

  /** Set on a stop event. Always a rule_id from the registry. */
  stop_reason: z.string().nullable(),

  // ---- money
  /** Signed. Positive on recovery. */
  money_delta_paise: PaiseDeltaSchema,
  /** Cost of taking this action: message fees, gateway attempt fees. */
  cost_paise: PaiseSchema,

  // ---- integrity
  prev_hash: z.string(),
  hash: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Everything except the chain fields, which the ledger computes on append. */
export type AuditEventInput = Omit<AuditEvent, 'hash' | 'prev_hash' | 'event_id' | 'seq'>;

/** Genesis link for a case's chain. */
export const CHAIN_ROOT = '0'.repeat(64);
