import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CostModel } from '../src/domain/costs.js';
import type { AnyPolicy } from '../src/domain/policy.js';
import { RuleRegistry } from '../src/domain/rules.js';
import { TaxonomyIndex } from '../src/domain/taxonomy.js';
import { doNothing, naiveRetry } from '../src/policy/baselines.js';
import { staticPolicy } from '../src/policy/static_policy.js';
import { runBatch } from '../src/eval/runner.js';
import { computeMetrics } from '../src/metrics/compute.js';
import { generateWorld } from '../src/world/generator.js';
import type { LatentState } from '../src/world/latent.js';
import { makeOracle } from '../src/world/oracle.js';

const registry = new RuleRegistry();
const taxonomy = new TaxonomyIndex();
const costs = new CostModel();
const tmp = mkdtempSync(path.join(tmpdir(), 'vasooli-oracle-'));

/**
 * Every policy gets its OWN world, because latent state mutates when a payer
 * engages. Sharing one would let a nudge from the previous policy silently fund
 * the account the next policy presents into.
 */
async function recovered(
  make: (w: ReturnType<typeof generateWorld>['world']) => AnyPolicy<LatentState>,
  tag: string,
  seed: number,
  size: number,
  mix?: string,
): Promise<number> {
  const world = generateWorld(mix === undefined ? { seed, size } : { seed, size, mix }).world;
  const run = await runBatch({
    world,
    policy: make(world),
    registry,
    taxonomy,
    costs,
    run_id: `oracle-test-${tag}`,
    ledger_path: path.join(tmp, `${tag}.jsonl`),
    seed,
  });
  const m = computeMetrics({ run, costs, registry, ltvByCase: new Map() });
  expect(m.harm.clean, `${tag} tripped a harm rule`).toBe(true);
  return m.recovered_paise;
}

/**
 * THE INVARIANT THIS WHOLE FILE EXISTS FOR.
 *
 * The oracle's recovered total is the denominator of every "percent of
 * recoverable" figure in the report. If an observation-only policy beats it,
 * the oracle's search was incomplete and the ceiling is too low - which means
 * every percentage published against it is an overstatement. The runner throws
 * OracleViolationError when that happens at eval time; these tests are the
 * cheap version that runs on every commit.
 */
async function ceilingHolds(seed: number, size: number, mix?: string): Promise<void> {
  const tag = `${mix ?? 'default'}-s${seed}`;
  const ceiling = await recovered(
    (w) => makeOracle(w, seed, registry, staticPolicy),
    `oracle-${tag}`,
    seed,
    size,
    mix,
  );
  expect(ceiling, 'the oracle recovered nothing, so the ceiling is not being derived').toBeGreaterThan(0);

  for (const [name, policy] of [
    ['do-nothing', doNothing],
    ['naive-retry', naiveRetry],
    ['static-policy', staticPolicy],
  ] as const) {
    const got = await recovered(() => policy, `${name}-${tag}`, seed, size, mix);
    expect(got, `${name} beat the ceiling on ${tag}`).toBeLessThanOrEqual(ceiling);
  }
}

describe('oracle', () => {
  it('declares that it reads latent state', () => {
    const o = makeOracle(generateWorld({ seed: 7, size: 5 }).world, 7, registry, staticPolicy);
    expect(o.usesLatentState).toBe(true);
    // The graded policies must not, or the comparison is meaningless.
    expect(doNothing.usesLatentState).toBe(false);
    expect(naiveRetry.usesLatentState).toBe(false);
    expect(staticPolicy.usesLatentState).toBe(false);
  });

  it('bounds every observation-only policy on the default mix', async () => {
    await ceilingHolds(7, 120);
  }, 120_000);

  it('bounds them on a mandate-decay mix, where the hard share triples', async () => {
    // mix_c is the adversarial direction for the search: more of the batch is
    // blocked by mandate state rather than by timing, so an oracle that only
    // knew how to move presentments around would fall behind here first.
    await ceilingHolds(8, 120, 'mix_c');
  }, 120_000);

  it('never recovers a structurally hard case', async () => {
    // Truth-aware or not, no policy can collect from a closed account. If this
    // fails, the simulator is leaking recoveries the world model forbids.
    const seed = 9;
    const world = generateWorld({ seed, size: 150 }).world;
    const run = await runBatch({
      world,
      policy: makeOracle(world, seed, registry, staticPolicy),
      registry,
      taxonomy,
      costs,
      run_id: 'oracle-test-hard',
      ledger_path: path.join(tmp, 'oracle-hard.jsonl'),
      seed,
    });
    for (const c of run.cases) {
      if (c.first_code_hard) expect(c.recovered_paise, c.case_id).toBe(0);
    }
  }, 120_000);
});
