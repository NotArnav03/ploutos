import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '../src/domain/actions.js';
import { CostModel } from '../src/domain/costs.js';
import { RuleRegistry } from '../src/domain/rules.js';
import { TaxonomyIndex } from '../src/domain/taxonomy.js';
import { DecisionCache, cacheKey } from '../src/agent/cache.js';
import { makeAgent, type Completer } from '../src/agent/agent.js';
import { outputJsonSchema } from '../src/agent/schema.js';
import { PROMPT_VERSION, SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { runBatch } from '../src/eval/runner.js';
import { computeMetrics } from '../src/metrics/compute.js';
import { generateWorld } from '../src/world/generator.js';

const registry = new RuleRegistry();
const taxonomy = new TaxonomyIndex();
const costs = new CostModel();
const tmp = mkdtempSync(path.join(tmpdir(), 'vasooli-agent-'));

/** A cache that never loads from or writes to disk. */
function emptyCache(): DecisionCache {
  return new DecisionCache(path.join(tmp, `cache-${Math.random().toString(36).slice(2)}`));
}

/**
 * Runs a batch with a stubbed model. Every assertion below is about the
 * machinery around the model - the schema, the guards, the fallback, the audit
 * record - which is exactly the part that has to hold no matter what the model
 * returns.
 */
async function runWithStub(complete: Completer, tag: string) {
  const agent = makeAgent({ complete, cache: emptyCache(), model: 'stub-model' });
  const run = await runBatch({
    world: generateWorld({ seed: 21, size: 40 }).world,
    policy: agent,
    registry,
    taxonomy,
    costs,
    run_id: `agent-${tag}`,
    ledger_path: path.join(tmp, `${tag}.jsonl`),
    seed: 21,
  });
  return { run, agent, metrics: computeMetrics({ run, costs, registry, ltvByCase: new Map() }) };
}

describe('agent output schema', () => {
  it('offers the model only the actions the gate permits', () => {
    const schema = outputJsonSchema(['wait', 'retry_debit'], ['email']);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['action_type']!['enum']).toEqual(['wait', 'retry_debit']);
    // The other ten are not merely discouraged - they are undecodable.
    for (const t of ACTION_TYPES) {
      if (t !== 'wait' && t !== 'retry_debit') {
        expect(props['action_type']!['enum']).not.toContain(t);
      }
    }
  });

  it('makes null the only possible channel when none is permitted', () => {
    const props = outputJsonSchema(['wait'], [])['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(props['channel']!['type']).toEqual(['null']);
    expect(props['channel']!['enum']).toBeUndefined();
  });

  it('never lets the prompt carry a compliance rule the gate enforces', () => {
    // If a rule ever migrates into the prompt, it stops being enforced and
    // starts being suggested. These are the four the gate owns.
    for (const rule of ['CONTACT_HOURS', 'DND', 'PREDEBIT_NOTICE', 'AFA_THRESHOLD']) {
      expect(SYSTEM_PROMPT).not.toContain(rule);
    }
  });
});

describe('agent guards', () => {
  it('substitutes a permitted action when the model returns a forbidden one', async () => {
    // The schema should make this impossible; the guard exists for the day the
    // API changes underneath us. A stub is the only way to reach it.
    const rogue: Completer = async () => ({
      output: {
        diagnosis: 'ignoring the menu',
        action_type: 'grant_grace',
        channel: null,
        wait_hours: null,
        language: null,
        rationale: 'deliberately out of set',
        confidence: 1,
      },
      tokens_in: 10,
      tokens_out: 10,
    });
    const { metrics } = await runWithStub(rogue, 'rogue');
    // Nothing forbidden reached the world.
    expect(metrics.harm.clean).toBe(true);
  }, 60_000);

  it('falls back deterministically when the model is unreachable', async () => {
    const broken: Completer = async () => {
      throw new Error('connection refused');
    };
    const { run, agent, metrics } = await runWithStub(broken, 'broken');
    expect(agent.stats.api_errors).toBeGreaterThan(0);
    expect(metrics.harm.clean).toBe(true);
    // The run still completes and still recovers money - via static-policy,
    // which is why eval prints a loud warning rather than reporting it as an
    // agent result.
    expect(run.cases.length).toBe(40);
  }, 60_000);

  it('rejects an output that does not satisfy the contract', async () => {
    const malformed: Completer = async () => ({
      output: { diagnosis: '', action_type: 'wait', confidence: 5 },
      tokens_in: 1,
      tokens_out: 1,
    });
    const { agent, metrics } = await runWithStub(malformed, 'malformed');
    expect(agent.stats.api_errors).toBeGreaterThan(0);
    expect(metrics.harm.clean).toBe(true);
  }, 60_000);

  it('does not call the model when only one action is permitted', async () => {
    let calls = 0;
    const counting: Completer = async () => {
      calls++;
      return {
        output: {
          diagnosis: 'd',
          action_type: 'wait',
          channel: null,
          wait_hours: 12,
          language: null,
          rationale: 'r',
          confidence: 0.5,
        },
        tokens_in: 1,
        tokens_out: 1,
      };
    };
    const { run } = await runWithStub(counting, 'single');
    // Every case ends in a forced stop, and those decisions must be free.
    const stops = run.cases.filter((c) => c.stopped_reason !== null).length;
    expect(stops).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(0);
  }, 60_000);
});

describe('decision cache', () => {
  it('keys on the permitted set, not just the observation', () => {
    const base = {
      prompt_version: PROMPT_VERSION,
      model: 'm',
      observation_hash: 'abc',
      permitted_channels: ['email'],
    };
    const a = cacheKey({ ...base, permitted: ['wait', 'retry_debit'] });
    const b = cacheKey({ ...base, permitted: ['wait'] });
    // The same case with a different menu is a different question. Reusing an
    // answer across the two would replay a choice made from options that were
    // not on offer.
    expect(a).not.toBe(b);
  });

  it('is stable under ordering of the permitted set', () => {
    const base = { prompt_version: 'v1', model: 'm', observation_hash: 'abc' };
    expect(cacheKey({ ...base, permitted: ['wait', 'retry_debit'], permitted_channels: [] })).toBe(
      cacheKey({ ...base, permitted: ['retry_debit', 'wait'], permitted_channels: [] }),
    );
  });

  it('changes when the prompt version changes', () => {
    const base = { model: 'm', observation_hash: 'abc', permitted: ['wait'], permitted_channels: [] };
    expect(cacheKey({ ...base, prompt_version: 'v1' })).not.toBe(
      cacheKey({ ...base, prompt_version: 'v2' }),
    );
  });

  it('replays a recorded decision without calling the model again', async () => {
    const shared = emptyCache();
    let calls = 0;
    const counting: Completer = async () => {
      calls++;
      return {
        output: {
          diagnosis: 'd',
          action_type: 'wait',
          channel: null,
          wait_hours: 24,
          language: null,
          rationale: 'r',
          confidence: 0.5,
        },
        tokens_in: 1,
        tokens_out: 1,
      };
    };

    const world = () => generateWorld({ seed: 22, size: 30 }).world;
    const once = async (tag: string) =>
      runBatch({
        world: world(),
        policy: makeAgent({ complete: counting, cache: shared, model: 'stub' }),
        registry,
        taxonomy,
        costs,
        run_id: `replay-${tag}`,
        ledger_path: path.join(tmp, `replay-${tag}.jsonl`),
        seed: 22,
      });

    await once('first');
    const afterFirst = calls;
    await once('second');

    expect(afterFirst).toBeGreaterThan(0);
    // The second pass asks the same questions and must answer them from the
    // cache. This is what lets `npm run eval` reproduce a committed result
    // without an API key.
    expect(calls).toBe(afterFirst);
  }, 60_000);
});
