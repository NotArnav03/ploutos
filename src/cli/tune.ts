import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CostModel } from '../domain/costs.js';
import { formatINR, paise } from '../domain/money.js';
import { RuleRegistry } from '../domain/rules.js';
import { TaxonomyIndex } from '../domain/taxonomy.js';
import { makeStaticPolicy, STATIC_PARAMS, type StaticParams } from '../policy/static_policy.js';
import { runBatch } from '../eval/runner.js';
import { computeMetrics } from '../metrics/compute.js';
import { generateWorld } from '../world/generator.js';

/**
 * Grid search for the static-policy parameters.
 *
 * The point of this file is fairness, not performance. `static-policy` is the
 * ablation the agent gets compared against, so if it is left hand-tuned and
 * mediocre, any advantage the agent shows is partly just the advantage of
 * having been the thing I bothered to tune. Fitting it properly is the only way
 * the comparison means anything.
 *
 * TRAINING SEEDS ARE DISJOINT FROM THE EVALUATION SEED. Tuning on seed 42 and
 * then reporting seed 42 would be fitting the test set, and the resulting
 * number would be an overstatement of how the policy generalises.
 */

const TRAIN_SEEDS = [101, 102, 103];
const TRAIN_SIZE = 250;

const registry = new RuleRegistry();
const taxonomy = new TaxonomyIndex();
const costs = new CostModel();
const tmp = mkdtempSync(path.join(tmpdir(), 'ploutos-tune-'));

/**
 * Objective: net recovered after mechanical cost.
 *
 * Deliberately not gross recovery, which would reward a policy that contacts
 * everyone on every channel. Any candidate that trips a harm rule scores as
 * negative infinity rather than being ranked - harm is not a trade.
 */
async function score(params: StaticParams): Promise<number> {
  let total = 0;
  for (const seed of TRAIN_SEEDS) {
    const world = generateWorld({ seed, size: TRAIN_SIZE }).world;
    const run = await runBatch({
      world,
      policy: makeStaticPolicy(params),
      registry,
      taxonomy,
      costs,
      run_id: `tune-${seed}`,
      ledger_path: path.join(tmp, `tune-${seed}.jsonl`),
      seed,
    });
    const m = computeMetrics({ run, costs, registry, ltvByCase: new Map() });
    if (!m.harm.clean) return Number.NEGATIVE_INFINITY;
    total += m.net_recovered_paise;
  }
  return total / TRAIN_SEEDS.length;
}

const GRID = {
  funds_target_offset_days: [0, 1, 2],
  nudge_min_value_paise: [0, 20000, 100000],
  link_after_attempts: [2, 3, 4],
  handoff_min_value_paise: [500000, 2000000, 100000000],
} as const;

async function main(): Promise<void> {
  const base = STATIC_PARAMS;
  let best = { ...base };
  let bestScore = await score(best);

  console.log(`\ntuning static-policy on seeds ${TRAIN_SEEDS.join(', ')} (eval seed 42 excluded)`);
  console.log(`baseline net: ${formatINR(paise(Math.max(0, Math.round(bestScore))))}\n`);

  // Coordinate descent over the grid: cheap, and enough for four parameters
  // that interact weakly. A full product would be 81 combinations x 3 seeds.
  for (let pass = 0; pass < 2; pass++) {
    for (const key of Object.keys(GRID) as (keyof typeof GRID)[]) {
      for (const value of GRID[key]) {
        const candidate = { ...best, [key]: value } as StaticParams;
        if (candidate[key] === best[key]) continue;
        const s = await score(candidate);
        const better = s > bestScore;
        console.log(
          `  ${key.padEnd(28)} ${String(value).padStart(10)}  ` +
            `${formatINR(paise(Math.max(0, Math.round(s)))).padStart(14)}` +
            `${better ? '  <-- best' : ''}`,
        );
        if (better) {
          best = candidate;
          bestScore = s;
        }
      }
    }
  }

  console.log(`\nbest net: ${formatINR(paise(Math.max(0, Math.round(bestScore))))}`);
  console.log('\nwinning parameters — paste into STATIC_PARAMS:\n');
  console.log(
    JSON.stringify(
      {
        funds_target_offset_days: best.funds_target_offset_days,
        nudge_min_value_paise: best.nudge_min_value_paise,
        link_after_attempts: best.link_after_attempts,
        handoff_min_value_paise: best.handoff_min_value_paise,
      },
      null,
      2,
    ),
  );
  console.log('');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
