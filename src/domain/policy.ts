import type { Action, PermittedSet } from './actions.js';
import type { CaseObservation } from './schemas.js';
import type { RuleRegistry } from './rules.js';
import type { TaxonomyIndex } from './taxonomy.js';
import type { Timestamp } from './time.js';

/**
 * The seam every policy plugs into, and the reason the oracle does not break
 * the world boundary.
 *
 * Four of the five policies decide from the observable record alone. The oracle
 * legitimately needs ground truth - that is its entire job, since it exists to
 * establish what was actually achievable. Without an explicit seam, day 4
 * arrives, the oracle needs `LatentState`, and the tempting fix is to weaken
 * tests/boundary.test.ts - the one test holding the credibility argument up.
 *
 * So truth-awareness is expressed in the type system instead. `Policy` cannot
 * see truth. `TruthAwarePolicy<TTruth>` receives it as a second argument, and
 * is generic so that this module never imports the latent schema. The world
 * supplies the concrete type; the runner in src/eval - which is harness code,
 * not decision code, and is therefore permitted to import src/world - selects
 * between them.
 *
 * The `usesLatentState` literal is the discriminant. It is impossible to write
 * a policy that reads truth while advertising that it does not.
 */

export interface PolicyContext {
  readonly registry: RuleRegistry;
  readonly taxonomy: TaxonomyIndex;
  /** Simulated clock. Policies must never read the real one. */
  readonly now: Timestamp;
  /** Identifies the run, for cache keys and audit records. */
  readonly run_id: string;
}

export interface PolicyInput {
  readonly observation: CaseObservation;
  /** What the gate allows right now, and what it refused with which rule. */
  readonly permitted: PermittedSet;
  readonly ctx: PolicyContext;
}

export interface DecisionMeta {
  readonly model: string | null;
  readonly prompt_version: string | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly latency_ms: number | null;
  readonly cache_hit: boolean;
}

export const NO_META: DecisionMeta = {
  model: null,
  prompt_version: null,
  tokens_in: null,
  tokens_out: null,
  latency_ms: null,
  cache_hit: false,
};

export interface PolicyDecision {
  readonly action: Action;
  /** Root cause as this policy understood it. Null for policies that do not reason. */
  readonly diagnosis: string | null;
  readonly rationale: string;
  readonly confidence: number | null;
  readonly meta: DecisionMeta;
}

/** A policy that decides from the observable record alone. */
export interface Policy {
  readonly name: string;
  readonly usesLatentState: false;
  decide(input: PolicyInput): PolicyDecision | Promise<PolicyDecision>;
}

/**
 * A policy that is allowed to see ground truth. Only the oracle implements
 * this, and it is not a competitor - it establishes the recoverable ceiling.
 * Generic in the truth type so this module stays free of world imports.
 */
export interface TruthAwarePolicy<TTruth> {
  readonly name: string;
  readonly usesLatentState: true;
  decide(input: PolicyInput, truth: TTruth): PolicyDecision | Promise<PolicyDecision>;
}

export type AnyPolicy<TTruth> = Policy | TruthAwarePolicy<TTruth>;

export function isTruthAware<TTruth>(p: AnyPolicy<TTruth>): p is TruthAwarePolicy<TTruth> {
  return p.usesLatentState;
}

/**
 * Invariant the harness enforces on every run: no observation-only policy may
 * recover more than the truth-aware oracle. If one does, the oracle's search is
 * incomplete and the ceiling it reported is wrong - which would make every
 * "percent of recoverable" figure in the report an overstatement.
 *
 * The correct response is to fail the run, not to publish the higher number.
 */
export class OracleViolationError extends Error {
  constructor(
    readonly policyName: string,
    readonly policyRecovered: number,
    readonly oracleRecovered: number,
  ) {
    super(
      `${policyName} recovered ${policyRecovered} paise, above the oracle ceiling of ` +
        `${oracleRecovered}. The oracle search is incomplete, so the ceiling is invalid ` +
        `and this run must not be reported.`,
    );
    this.name = 'OracleViolationError';
  }
}
