import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CostModel } from '../src/domain/costs.js';
import { RuleRegistry } from '../src/domain/rules.js';
import { TaxonomyIndex } from '../src/domain/taxonomy.js';
import { DecisionCache } from '../src/agent/cache.js';
import { makeAgent, type Completer } from '../src/agent/agent.js';
import { runBatch } from '../src/eval/runner.js';
import { computeMetrics } from '../src/metrics/compute.js';
import { generateWorld } from '../src/world/generator.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'vasooli-conc-'));

/**
 * A stub that answers deterministically from the case text but at varying
 * speeds. The variable delay is the point: without it, every call would resolve
 * in the same tick and the concurrent path would never actually interleave, so
 * the test would prove nothing.
 */
function jitteryStub(): Completer {
  return async (req) => {
    const enum_ = (
      (req.schema['properties'] as Record<string, Record<string, unknown>>)['action_type'] as {
        enum: string[];
      }
    ).enum;
    let h = 0;
    for (let i = 0; i < req.user.length; i++) h = (h * 31 + req.user.charCodeAt(i)) >>> 0;
    await new Promise((r) => setTimeout(r, h % 7));
    return {
      output: {
        diagnosis: 'stub',
        action_type: enum_[h % enum_.length],
        channel: null,
        wait_hours: (h % 48) + 1,
        language: null,
        rationale: 'stub',
        confidence: 0.5,
      },
      tokens_in: 1,
      tokens_out: 1,
    };
  };
}

async function runAt(concurrency: number) {
  const run = await runBatch({
    world: generateWorld({ seed: 31, size: 50 }).world,
    policy: makeAgent({
      complete: jitteryStub(),
      cache: new DecisionCache(path.join(tmp, `c-${concurrency}`)),
      model: 'stub-model',
    }),
    registry: new RuleRegistry(),
    taxonomy: new TaxonomyIndex(),
    costs: new CostModel(),
    run_id: 'conc',
    ledger_path: path.join(tmp, `conc-${concurrency}.jsonl`),
    seed: 31,
  concurrency,
  });
  const metrics = computeMetrics({
    run,
    costs: new CostModel(),
    registry: new RuleRegistry(),
    ltvByCase: new Map(),
  });
  // wall_ms is how long the run took, not a property of the run.
  const { wall_ms: _w, ...rest } = metrics;
  return { cases: run.cases, metrics: rest };
}

describe('concurrency', () => {
  it('produces identical results at 1 and at 8', async () => {
    // The agent's decisions are network round-trips of seconds each; at one at
    // a time a 500-case batch is roughly twelve hours of waiting on a socket.
    // Raising it is only legitimate if it changes nothing about the answer.
    const [one, eight] = await Promise.all([runAt(1), runAt(8)]);

    expect(eight.cases).toEqual(one.cases);
    expect(eight.metrics).toEqual(one.metrics);
  }, 120_000);
});
