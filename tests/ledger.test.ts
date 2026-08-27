import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { toTimestamp } from '../src/domain/time.js';
import { CostModel } from '../src/domain/costs.js';
import { RuleRegistry } from '../src/domain/rules.js';
import { TaxonomyIndex } from '../src/domain/taxonomy.js';
import type { AuditEvent } from '../src/domain/audit.js';
import { readLedgerFile, verifyChain, hashEvent } from '../src/ledger/ledger.js';
import { naiveRetry } from '../src/policy/baselines.js';
import { runBatch } from '../src/eval/runner.js';
import { generateWorld } from '../src/world/generator.js';

const registry = new RuleRegistry();
const taxonomy = new TaxonomyIndex();
const costs = new CostModel();
const tmp = mkdtempSync(path.join(tmpdir(), 'ploutos-ledger-'));

async function run(tag: string, ext: string, run_id = 'ledger-fixed'): Promise<string> {
  const ledger_path = path.join(tmp, `${tag}.jsonl${ext}`);
  await runBatch({
    world: generateWorld({ seed: 11, size: 60 }).world,
    policy: naiveRetry,
    registry,
    taxonomy,
    costs,
    run_id,
    ledger_path,
    seed: 11,
  });
  return ledger_path;
}

describe('compressed ledger', () => {
  /**
   * The failure this guards against is silent truncation. Ending a gzip stream
   * is not the same as the file being flushed to disk, and a ledger cut short
   * fails verification in a way that looks exactly like tampering - which would
   * send a reviewer hunting for a security problem that was really a missing
   * await.
   */
  it('writes every event through the gzip stream', async () => {
    const plain = readLedgerFile(await run('plain', ''));
    const gz = readLedgerFile(await run('gz', '.gz'));

    expect(gz.length).toBe(plain.length);
    expect(gz.length).toBeGreaterThan(100);
    // ts_wall is the real clock and is deliberately outside the hash, so the
    // two runs differ there and nowhere else.
    expect(gz.map((e) => e.hash)).toEqual(plain.map((e) => e.hash));
  }, 60_000);

  it('hashes the simulated clock and not the wall clock', async () => {
    // Asserted directly rather than inferred from two runs agreeing. ts_wall is
    // reporting metadata - when a record was written - and ts_sim is what the
    // decision was made against. Hashing the first would make the trail
    // unreproducible for a reason that has nothing to do with integrity;
    // failing to hash the second would let a decision be re-dated silently.
    const events = readLedgerFile(await run('ts-fields', '.gz'));
    const e = events[10]!;
    const { hash, ...rest } = e;

    expect(hashEvent({ ...rest, ts_wall: toTimestamp('2001-01-01T00:00:00.000Z') })).toBe(hash);
    expect(hashEvent({ ...rest, ts_sim: toTimestamp('2001-01-01T00:00:00.000Z') })).not.toBe(hash);
  }, 60_000);

  it('produces a chain that still verifies after the round trip', async () => {
    const events = readLedgerFile(await run('gz-verify', '.gz'));
    expect(verifyChain(events)).toEqual([]);
  }, 60_000);

  it('is small enough to commit', async () => {
    const gzPath = await run('gz-size', '.gz');
    const plainPath = await run('plain-size', '');
    const ratio = statSync(plainPath).size / statSync(gzPath).size;
    // Measured around 20:1. Asserting a floor of 5 keeps this a real check
    // without making it brittle to zlib version changes.
    expect(ratio).toBeGreaterThan(5);
  }, 60_000);

  it('detects tampering through the compressed form', async () => {
    // The compression must not become a place to hide an edit: decompress,
    // change one recorded amount, recompress, and verification should still
    // point at the exact record.
    const p = await run('gz-tamper', '.gz');
    const lines = gunzipSync(readFileSync(p)).toString('utf8').trim().split('\n');
    const idx = lines.findIndex((l) => l.includes('"event_type":"decision"'));
    expect(idx).toBeGreaterThanOrEqual(0);

    const forged = JSON.parse(lines[idx]!) as AuditEvent;
    forged.money_delta_paise = 999_999 as AuditEvent['money_delta_paise'];
    lines[idx] = JSON.stringify(forged);
    writeFileSync(p, gzipSync(Buffer.from(lines.join('\n') + '\n')));

    const breaks = verifyChain(readLedgerFile(p));
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[0]?.case_id).toBe(forged.case_id);
    expect(breaks.some((b) => b.reason === 'bad_hash')).toBe(true);
  }, 60_000);

  it('reads a plain ledger and a compressed one identically', async () => {
    const p = await run('both', '');
    const raw = readFileSync(p);
    const gzPath = path.join(tmp, 'both-copy.jsonl.gz');
    writeFileSync(gzPath, gzipSync(raw));
    expect(readLedgerFile(gzPath)).toEqual(readLedgerFile(p));
  }, 60_000);
});
