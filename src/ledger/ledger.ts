import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { AuditEventSchema, CHAIN_ROOT, type AuditEvent } from '../domain/audit.js';
import type { CaseRuntime } from '../orchestrator/runtime.js';

/**
 * Append-only, hash-chained audit ledger.
 *
 * Each record carries the hash of the previous record for its case, so any
 * later edit to a committed line breaks every hash after it and `verifyChain`
 * reports exactly where. That is a Merkle-style integrity chain over a local
 * JSONL file - the same idea as a tamper-evident log. There is no chain, no
 * consensus, no token and no settlement layer anywhere in this project. See
 * docs/DECISIONS.md D-005.
 *
 * Chains are per case rather than per run, so a single case can be verified and
 * replayed on its own without reading the whole batch.
 */

export function hashEvent(e: Omit<AuditEvent, 'hash'>): string {
  // Field order is fixed here rather than taken from Object.keys, so the hash
  // does not depend on the order a caller happened to build the object in.
  const canonical = JSON.stringify([
    e.event_id,
    e.run_id,
    e.case_id,
    e.seq,
    e.ts_sim,
    e.actor,
    e.event_type,
    e.observation_hash,
    e.permitted,
    e.excluded,
    e.policy_checks,
    e.decision,
    e.outcome,
    e.violation,
    e.stop_reason,
    e.money_delta_paise,
    e.cost_paise,
    e.prev_hash,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export class Ledger {
  private readonly stream: WriteStream;
  private count = 0;

  constructor(
    private readonly path: string,
    private readonly run_id: string,
  ) {
    this.stream = createWriteStream(path, { encoding: 'utf8', flags: 'w' });
  }

  get written(): number {
    return this.count;
  }

  /**
   * Append one event, advancing the case's chain. Mutates `rt.seq` and
   * `rt.prev_hash`, which are the case's position in its own chain.
   */
  append(rt: CaseRuntime, event: Omit<AuditEvent, 'event_id' | 'seq' | 'prev_hash' | 'hash'>): AuditEvent {
    const seq = rt.seq + 1;
    const withChain = {
      ...event,
      event_id: `${event.case_id}#${seq}`,
      seq,
      prev_hash: rt.prev_hash,
    };
    const full: AuditEvent = { ...withChain, hash: hashEvent(withChain) };

    const parsed = AuditEventSchema.safeParse(full);
    if (!parsed.success) {
      throw new Error(
        `audit event failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    this.stream.write(JSON.stringify(parsed.data) + '\n');
    rt.seq = seq;
    rt.prev_hash = full.hash;
    this.count++;
    return parsed.data;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

export interface ChainBreak {
  case_id: string;
  seq: number;
  reason: 'bad_hash' | 'bad_link' | 'bad_seq';
}

/**
 * Re-derive every hash and check every link. Used by `npm run replay` and by
 * the metrics step, which refuses to report numbers from a ledger that does not
 * verify - a tampered trail is worse than no trail, because it looks credible.
 */
export function verifyChain(events: readonly AuditEvent[]): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  const byCase = new Map<string, AuditEvent[]>();

  for (const e of events) {
    let list = byCase.get(e.case_id);
    if (!list) {
      list = [];
      byCase.set(e.case_id, list);
    }
    list.push(e);
  }

  for (const [case_id, list] of byCase) {
    list.sort((a, b) => a.seq - b.seq);
    let expectedPrev = CHAIN_ROOT;
    let expectedSeq = 1;

    for (const e of list) {
      if (e.seq !== expectedSeq) breaks.push({ case_id, seq: e.seq, reason: 'bad_seq' });
      if (e.prev_hash !== expectedPrev) breaks.push({ case_id, seq: e.seq, reason: 'bad_link' });

      const { hash, ...rest } = e;
      if (hashEvent(rest) !== hash) breaks.push({ case_id, seq: e.seq, reason: 'bad_hash' });

      expectedPrev = e.hash;
      expectedSeq = e.seq + 1;
    }
  }
  return breaks;
}
