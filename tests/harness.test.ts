import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '../src/domain/actions.js';
import { CostModel } from '../src/domain/costs.js';
import { RuleRegistry } from '../src/domain/rules.js';
import { TaxonomyIndex } from '../src/domain/taxonomy.js';
import type { AuditEvent } from '../src/domain/audit.js';
import { verifyChain } from '../src/ledger/ledger.js';
import { doNothing, naiveRetry } from '../src/policy/baselines.js';
import { ENFORCED_BY_VOCABULARY } from '../src/policy/gate.js';
import { runBatch, type RunResult } from '../src/eval/runner.js';
import { computeMetrics } from '../src/metrics/compute.js';
import { generateWorld } from '../src/world/generator.js';
import type { World } from '../src/world/types.js';

const registry = new RuleRegistry();
const taxonomy = new TaxonomyIndex();
const costs = new CostModel();
const tmp = mkdtempSync(path.join(tmpdir(), 'ploutos-'));

function world(size = 120, seed = 5): World {
  return generateWorld({ seed, size }).world;
}

async function run(policy: typeof doNothing, w: World, tag: string, seed = 5): Promise<RunResult> {
  return runBatch({
    world: w,
    policy,
    registry,
    taxonomy,
    costs,
    run_id: `test-${tag}`,
    ledger_path: path.join(tmp, `${tag}.jsonl`),
    seed,
  });
}

function readLedger(tag: string): AuditEvent[] {
  return readFileSync(path.join(tmp, `${tag}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditEvent);
}

describe('do-nothing baseline', () => {
  it('recovers nothing and establishes the denominator', async () => {
    const r = await run(doNothing, world(), 'nothing');
    const m = computeMetrics({ run: r, costs, registry, ltvByCase: new Map() });
    expect(m.recovered_paise).toBe(0);
    expect(m.recovered_count).toBe(0);
    expect(m.at_risk_paise).toBeGreaterThan(0);
  });

  it('never contacts anyone or presents a debit', async () => {
    const r = await run(doNothing, world(), 'nothing2');
    for (const c of r.cases) {
      expect(c.contacts).toBe(0);
      expect(c.attempts).toBe(1); // the day-0 failure it inherited
    }
  });
});

describe('naive-retry baseline', () => {
  it('recovers money without tripping a harm rule', async () => {
    const r = await run(naiveRetry, world(), 'naive');
    const m = computeMetrics({ run: r, costs, registry, ltvByCase: new Map() });
    expect(m.recovered_paise).toBeGreaterThan(0);
    expect(m.harm.clean).toBe(true);
    expect(m.harm.double_charge_attempts).toBe(0);
  });

  it('respects the per-rail retry cap on every case', async () => {
    const r = await run(naiveRetry, world(), 'naive-cap');
    for (const c of r.cases) {
      // 4 is the largest cap in the registry (upi_autopay).
      expect(c.attempts, c.case_id).toBeLessThanOrEqual(4);
    }
  });

  it('serves a notice only when the notice is what is blocking', async () => {
    // Regression guard. An earlier version served a fresh notice whenever
    // retry_debit was unavailable for any reason, including RETRY_MIN_GAP,
    // producing 1,949 notices against 787 retries and inflating the baseline's
    // cost for no reason of its own.
    const r = await run(naiveRetry, world(), 'naive-notice');
    const notices = r.cases.reduce((a, c) => a + c.notices, 0);
    const retries = r.cases.reduce((a, c) => a + c.attempts - 1, 0);
    expect(notices).toBeLessThan(retries);
  });

  it('never recovers a structurally hard case', async () => {
    // If this ever fails, the recoverable ceiling is wrong and every
    // percentage in the report is an overstatement.
    const r = await run(naiveRetry, world(), 'naive-hard');
    for (const c of r.cases) {
      if (c.first_code_hard) expect(c.recovered_paise, c.case_id).toBe(0);
    }
  });
});

describe('determinism', () => {
  it('produces identical results for the same seed and world', async () => {
    const a = await run(naiveRetry, world(), 'det-a');
    const b = await run(naiveRetry, world(), 'det-b');
    expect(JSON.stringify(a.cases)).toBe(JSON.stringify(b.cases));
  });

  it('is not accidentally invariant to the seed', async () => {
    const a = await run(naiveRetry, world(200, 1), 'seed-a', 1);
    const b = await run(naiveRetry, world(200, 2), 'seed-b', 2);
    expect(JSON.stringify(a.cases)).not.toBe(JSON.stringify(b.cases));
    // Two 200-case runs with a full ledger write apiece: real work, not a hang.
  }, 30_000);
});

describe('audit ledger', () => {
  it('writes a chain that verifies end to end', async () => {
    await run(naiveRetry, world(), 'chain');
    expect(verifyChain(readLedger('chain'))).toEqual([]);
  });

  it('records the excluded actions with the rule that excluded each', async () => {
    // The "why not" record is what turns the trail from a log into an
    // explanation, so it is asserted rather than assumed.
    await run(naiveRetry, world(), 'chain-x');
    const events = readLedger('chain-x');
    const gates = events.filter((e) => e.event_type === 'eligibility' && e.excluded !== null);
    expect(gates.length).toBeGreaterThan(0);

    const withReasons = gates.filter((e) => (e.excluded ?? []).length > 0);
    expect(withReasons.length).toBeGreaterThan(0);
    for (const e of withReasons.slice(0, 50)) {
      for (const x of e.excluded ?? []) {
        expect(x.rule_id.length).toBeGreaterThan(0);
        expect(x.detail.length).toBeGreaterThan(0);
        // Every exclusion names a rule that actually exists.
        if (x.rule_id !== 'UNPERMITTED_ACTION') {
          expect(() => registry.require(x.rule_id)).not.toThrow();
        }
      }
    }
  });

  it('detects a tampered record', async () => {
    await run(naiveRetry, world(), 'tamper');
    const events = readLedger('tamper');
    const target = events.findIndex((e) => e.event_type === 'outcome');
    expect(target).toBeGreaterThanOrEqual(0);

    // Rewrite history: claim a failed recovery actually settled.
    const forged = events.map((e, i) =>
      i === target ? { ...e, money_delta_paise: 999999 } : e,
    ) as AuditEvent[];

    const breaks = verifyChain(forged);
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[0]?.reason).toBe('bad_hash');
  });

  it('links every case chain from the genesis root', async () => {
    await run(naiveRetry, world(), 'chain-root');
    const events = readLedger('chain-root');
    const firsts = new Map<string, AuditEvent>();
    for (const e of events) if (e.seq === 1) firsts.set(e.case_id, e);
    expect(firsts.size).toBeGreaterThan(0);
    for (const e of firsts.values()) expect(e.prev_hash).toBe('0'.repeat(64));
  });
});

describe('gate', () => {
  it('names only real rules among those enforced by the vocabulary', () => {
    for (const id of ENFORCED_BY_VOCABULARY) {
      expect(() => registry.require(id), id).not.toThrow();
    }
  });

  it('has no action that could express a forbidden authority', () => {
    // The authority bounds are enforced by construction rather than by a check:
    // there is no refund, discount, mandate-increase, voice or third-party
    // action in the vocabulary. This asserts that directly, so the claim in the
    // README is verified rather than asserted.
    const forbidden = ['refund', 'discount', 'reversal', 'voice', 'call', 'increase_mandate'];
    for (const t of ACTION_TYPES) {
      for (const word of forbidden) {
        expect(t.includes(word), `${t} looks like a forbidden authority`).toBe(false);
      }
    }
  });

  it('has a backlog that matches the rules not yet enforced', () => {
    const enforced = new Set([
      'MANDATE_ACTIVE_REQUIRED',
      'MANDATE_VALIDITY_WINDOW',
      'MANDATE_CAP_RESPECTED',
      'PREDEBIT_NOTICE',
      'AFA_THRESHOLD',
      'RETRY_CAP_PER_INVOICE',
      'RETRY_MIN_GAP',
      'RISK_COOLOFF',
      'IDEMPOTENT_ATTEMPT',
      'STOP_ON_SETTLED',
      'STOP_ON_HARD_DECLINE',
      'STOP_ON_DISPUTE',
      'STOP_ON_CANCELLATION',
      'STOP_ON_INVOICE_AGE',
      'STOP_ON_ATTEMPTS_EXHAUSTED',
    ]);
    for (const id of [
      'CONSENT_REQUIRED',
      'DND_SUPPRESSION',
      'CONTACT_HOURS',
      'CONTACT_CHANNEL_RATE',
      'CONTACT_LIFETIME_CAP',
      'LADDER_MONOTONIC',
      'P2P_SINGLE',
      'GRACE_CAP',
    ]) {
      enforced.add(id);
    }

    // Every rule in the registry is now either enforced at runtime or enforced
    // by the action vocabulary. Nothing is merely aspirational.
    const all = registry.all().map((r) => r.id);
    const unaccounted = all.filter(
      (id) => !enforced.has(id) && !ENFORCED_BY_VOCABULARY.includes(id),
    );
    expect(unaccounted).toEqual([]);
  });
});

describe('metrics', () => {
  it('reports no ceiling until an oracle run supplies one', async () => {
    // Falling back to face value would flatter every policy, since face value
    // includes money that was never recoverable.
    const r = await run(naiveRetry, world(), 'ceiling');
    const m = computeMetrics({ run: r, costs, registry, ltvByCase: new Map() });
    expect(m.recovery_vs_ceiling).toBeNull();
    expect(m.ceiling_paise).toBeNull();
  });

  it('produces a bootstrap interval that brackets the point estimate', async () => {
    const r = await run(naiveRetry, world(), 'ci');
    const m = computeMetrics({ run: r, costs, registry, ltvByCase: new Map() });
    expect(m.recovered_ci_low).toBeLessThanOrEqual(m.recovered_paise);
    expect(m.recovered_ci_high).toBeGreaterThanOrEqual(m.recovered_paise);
  });

  it('separates compliance notices from collections contacts', async () => {
    const r = await run(naiveRetry, world(), 'notices');
    const m = computeMetrics({ run: r, costs, registry, ltvByCase: new Map() });
    expect(m.notices_total).toBeGreaterThan(0);
    expect(m.contacts_total).toBe(0); // naive-retry sends no collections messages
  });
});
