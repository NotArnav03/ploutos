import { paise, scalePaise, sumPaise, type Paise } from '../domain/money.js';
import type { CostModel } from '../domain/costs.js';
import type { RuleRegistry } from '../domain/rules.js';
import { Rng, STREAM } from '../world/rng.js';
import type { CaseResult, RunResult } from '../eval/runner.js';

/**
 * Metric computation.
 *
 * Two rules govern everything here. Nothing is estimated - every figure is a
 * sum or a quantile over recorded case outcomes. And harm is never traded off
 * against revenue: a run that recovers more money while tripping a harm rule is
 * reported as failed, not as a better result with a caveat.
 */

export interface HarmSummary {
  double_charge_attempts: number;
  contacts_after_stop: number;
  harm_events: number;
  /** Refused choices. Reported as a quality signal, never as harm. */
  gate_rejections: number;
  /** A run with any harm is not reportable as a success, whatever it recovered. */
  clean: boolean;
}

export interface Metrics {
  run_id: string;
  policy: string;
  seed: number;
  mix: string;
  n_cases: number;

  at_risk_paise: Paise;
  recovered_paise: Paise;
  /** Share of face value recovered. NOT the headline - see recovery_vs_ceiling. */
  recovery_rate_vs_at_risk: number;
  /**
   * Share of what was actually achievable, from the oracle run. Null until an
   * oracle run exists to compare against, rather than silently falling back to
   * face value, which would flatter every policy.
   */
  recovery_vs_ceiling: number | null;
  ceiling_paise: Paise | null;

  intervention_cost_paise: Paise;
  net_recovered_paise: number;
  goodwill_cost_paise: Paise;
  net_with_goodwill_paise: number;
  cost_per_100_recovered: number | null;

  attempts_total: number;
  notices_total: number;
  contacts_total: number;
  contacts_per_recovery: number | null;
  attempts_per_recovery: number | null;
  median_days_to_recovery: number | null;

  recovered_count: number;
  escalated_count: number;
  stopped_count: number;

  /** Value that no policy could have recovered, by the taxonomy's own classes. */
  hard_value_paise: Paise;
  soft_value_paise: Paise;
  recovered_from_hard_paise: Paise;
  recovered_from_soft_paise: Paise;

  harm: HarmSummary;
  stops_by_rule: Record<string, number>;
  fallback_rate: number;
  /**
   * Wakes where the policy neither acted nor scheduled anything and the harness
   * had to advance the clock for it. Not harm - a signal that a policy is
   * failing to make progress, which is how a stranded case hides.
   */
  stalled_steps: number;

  /** Bootstrap 95% interval on recovered value. */
  recovered_ci_low: Paise;
  recovered_ci_high: Paise;

  // ---- what it cost to run the model, as opposed to what it cost to act
  //
  // Zero for every deterministic policy, which is itself part of the
  // comparison: the agent has to earn its inference bill against a rules engine
  // that thinks for free.
  /** Decisions that came from the model rather than being forced moves. */
  model_decisions: number;
  inference_tokens_in: number;
  inference_tokens_out: number;
  /**
   * USD. Deliberately not converted into the rupee figures - see
   * config/costs.yaml. Recomputable from the committed audit trail.
   */
  inference_cost_usd: number;
  /**
   * Model spend, in USD, per Rs 1,00,000 of value recovered. Two currencies in
   * one ratio on purpose: both units are named, so it needs no exchange rate.
   */
  inference_usd_per_lakh_recovered: number | null;

  wall_ms: number;
  ledger_events: number;
}

export interface ComputeOptions {
  run: RunResult;
  costs: CostModel;
  registry: RuleRegistry;
  ltvByCase: Map<string, Paise>;
  /** Recovered value from the oracle run on the same batch, when available. */
  ceiling_paise?: Paise;
  bootstrap_samples?: number;
}

export function computeMetrics(opts: ComputeOptions): Metrics {
  const { run, costs, ltvByCase } = opts;
  const cases = run.cases;

  const atRisk = sumPaise(cases.map((c) => c.at_risk_paise));
  const recovered = sumPaise(cases.map((c) => c.recovered_paise));
  // Zero for every deterministic policy. The agent has to earn this against a
  // rules engine that thinks for free.
  const inferenceUsd = costs.inferenceCostUsd(run.tokens_in, run.tokens_out);
  const interventionCost = sumPaise(cases.map((c) => c.cost_paise));

  const goodwill = sumPaise(
    cases.map((c) =>
      costs.goodwillCost({
        contacts: c.contacts,
        ltv: ltvByCase.get(c.case_id) ?? paise(0),
        endedInCancellation: c.stopped_reason?.includes('STOP_ON_CANCELLATION') ?? false,
      }),
    ),
  );

  const recoveredCount = cases.filter((c) => c.status === 'recovered').length;
  const attemptsTotal = cases.reduce((a, c) => a + c.attempts, 0);
  const contactsTotal = cases.reduce((a, c) => a + c.contacts, 0);
  const noticesTotal = cases.reduce((a, c) => a + c.notices, 0);

  const days = cases
    .map((c) => c.days_to_recovery)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);

  const hardValue = sumPaise(cases.filter((c) => c.first_code_hard).map((c) => c.at_risk_paise));
  const softValue = sumPaise(cases.filter((c) => !c.first_code_hard).map((c) => c.at_risk_paise));

  const doubleCharges = cases.reduce((a, c) => a + c.double_charge_attempts, 0);
  const gateRejections = cases.reduce((a, c) => a + c.gate_rejections, 0);
  const harmEvents = cases.reduce((a, c) => a + c.harm_events, 0);
  const fallbacks = cases.reduce((a, c) => a + c.fallbacks, 0);
  const stalledSteps = cases.reduce((a, c) => a + c.stalled_steps, 0);

  const stopsByRule: Record<string, number> = {};
  for (const c of cases) {
    const rule = c.stopped_reason?.split(':')[0]?.trim() ?? 'OPEN';
    stopsByRule[rule] = (stopsByRule[rule] ?? 0) + 1;
  }

  const [ciLow, ciHigh] = bootstrapCI(cases, run.seed, opts.bootstrap_samples ?? 1000);
  const ceiling = opts.ceiling_paise ?? null;

  return {
    run_id: run.run_id,
    policy: run.policy,
    seed: run.seed,
    mix: run.mix,
    n_cases: cases.length,

    at_risk_paise: atRisk,
    recovered_paise: recovered,
    recovery_rate_vs_at_risk: atRisk === 0 ? 0 : recovered / atRisk,
    recovery_vs_ceiling: ceiling !== null && ceiling > 0 ? recovered / ceiling : null,
    ceiling_paise: ceiling,

    intervention_cost_paise: interventionCost,
    net_recovered_paise: recovered - interventionCost,
    goodwill_cost_paise: goodwill,
    net_with_goodwill_paise: recovered - interventionCost - goodwill,
    cost_per_100_recovered: recovered === 0 ? null : (interventionCost / recovered) * 100,

    attempts_total: attemptsTotal,
    notices_total: noticesTotal,
    contacts_total: contactsTotal,
    contacts_per_recovery: recoveredCount === 0 ? null : contactsTotal / recoveredCount,
    attempts_per_recovery: recoveredCount === 0 ? null : attemptsTotal / recoveredCount,
    median_days_to_recovery: median(days),

    recovered_count: recoveredCount,
    escalated_count: cases.filter((c) => c.status === 'escalated').length,
    stopped_count: cases.filter((c) => c.status === 'stopped').length,

    hard_value_paise: hardValue,
    soft_value_paise: softValue,
    recovered_from_hard_paise: sumPaise(
      cases.filter((c) => c.first_code_hard).map((c) => c.recovered_paise),
    ),
    recovered_from_soft_paise: sumPaise(
      cases.filter((c) => !c.first_code_hard).map((c) => c.recovered_paise),
    ),

    harm: {
      double_charge_attempts: doubleCharges,
      contacts_after_stop: 0,
      harm_events: harmEvents,
      gate_rejections: gateRejections,
      // A refused choice is not harm. Only breaches that actually reached the
      // world count against a run.
      clean: doubleCharges === 0 && harmEvents === 0,
    },
    stops_by_rule: stopsByRule,
    fallback_rate: cases.length === 0 ? 0 : fallbacks / cases.length,
    model_decisions: run.model_decisions,
    inference_tokens_in: run.tokens_in,
    inference_tokens_out: run.tokens_out,
    inference_cost_usd: inferenceUsd,
    inference_usd_per_lakh_recovered:
      recovered === 0 ? null : inferenceUsd / (recovered / 10_000_000),
    stalled_steps: stalledSteps,

    recovered_ci_low: ciLow,
    recovered_ci_high: ciHigh,

    wall_ms: run.wall_ms,
    ledger_events: run.ledger_events,
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Bootstrap 95% interval on recovered value: resample cases with replacement
 * and take the empirical percentiles.
 *
 * It answers the question a reviewer should ask of any single-batch number -
 * how much of this gap is real and how much is 500 draws of luck. Seeded from
 * the run seed so the interval is reproducible.
 */
function bootstrapCI(
  cases: readonly CaseResult[],
  seed: number,
  samples: number,
): [Paise, Paise] {
  if (cases.length === 0) return [paise(0), paise(0)];
  const rng = Rng.stream(seed, 'bootstrap', STREAM.outcome);
  const totals: number[] = [];

  for (let s = 0; s < samples; s++) {
    let total = 0;
    for (let i = 0; i < cases.length; i++) {
      total += cases[rng.int(0, cases.length - 1)]?.recovered_paise ?? 0;
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const lo = totals[Math.floor(samples * 0.025)] ?? 0;
  const hi = totals[Math.min(samples - 1, Math.floor(samples * 0.975))] ?? 0;
  return [paise(Math.round(lo)), paise(Math.round(hi))];
}

/** Uplift of one policy over another, with the baseline named explicitly. */
export function uplift(policy: Metrics, baseline: Metrics): {
  absolute_paise: number;
  relative: number | null;
} {
  const abs = policy.recovered_paise - baseline.recovered_paise;
  return {
    absolute_paise: abs,
    relative: baseline.recovered_paise === 0 ? null : abs / baseline.recovered_paise,
  };
}
