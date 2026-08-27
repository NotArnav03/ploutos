import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BATCH_DIR } from '../domain/paths.js';
import { formatINR, paise } from '../domain/money.js';
import { readLedgerFile } from '../ledger/ledger.js';
import type { WorldCase } from '../world/types.js';

/**
 * Behavioural counters for one or more runs, side by side.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE METRICS
 *
 * On a small batch, recovered value cannot separate two policy variants - the
 * paired intervals overlap almost entirely and the differences concentrate in a
 * handful of large invoices. These counters can: they are counts over hundreds
 * or thousands of decisions, so they move sharply and consistently where money
 * moves noisily.
 *
 * Every number in docs/EXPERIMENTS.md comes from this command, so a reader can
 * regenerate the table rather than take it on trust.
 */

function loadWorld(batch: string): Map<string, WorldCase> {
  return new Map(
    readFileSync(path.join(BATCH_DIR, `${batch}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const c = JSON.parse(l) as WorldCase;
        return [c.case_id, c] as const;
      }),
  );
}

interface Counters {
  label: string;
  actions: Map<string, number>;
  idle_retry: number;
  afa_request: number;
  afa_retry: number;
  decisions: number;
}

function counters(dir: string, policy: string, world: Map<string, WorldCase>): Counters {
  const events = readLedgerFile(path.join(dir, `audit.${policy}.jsonl.gz`));
  const actions = new Map<string, number>();
  let permitted: readonly string[] = [];
  let idleRetry = 0;
  let afaRequest = 0;
  let afaRetry = 0;
  let decisions = 0;

  for (const e of events) {
    if (e.event_type === 'eligibility') permitted = e.permitted ?? [];
    if (!e.decision) continue;
    const type = e.decision.action.type;
    actions.set(type, (actions.get(type) ?? 0) + 1);
    if (e.decision.model !== null) decisions++;

    // A wait taken while a presentment was on the menu. Not automatically
    // wrong - waiting for a salary credit is the whole point sometimes - but a
    // policy that does it far more than the tuned baseline is foregoing
    // retries, and that is where the day-6 agent lost its money.
    if (type === 'wait' && permitted.includes('retry_debit')) idleRetry++;

    const code = world.get(e.case_id)?.invoice.attempts[0]?.code;
    if (code === 'AFA_REQUIRED') {
      if (type === 'request_afa') afaRequest++;
      if (type === 'retry_debit') afaRetry++;
    }
  }
  return { label: `${path.basename(dir)}/${policy}`, actions, idle_retry: idleRetry, afa_request: afaRequest, afa_retry: afaRetry, decisions };
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const batch = arg(argv, '--batch') ?? 'main';
  const policy = arg(argv, '--policy') ?? 'agent';
  const dirs = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
  const runs = (arg(argv, '--runs') ?? dirs.join(',')).split(',').filter((d) => d.length > 0);
  if (runs.length === 0) {
    throw new Error(
      'usage: behaviour --runs <dir>[,<dir>...] [--batch main] [--policy agent]\n' +
        '       compare a policy across runs, or pass --policy static-policy for the baseline',
    );
  }

  const world = loadWorld(batch);
  const rows = runs.map((d) => counters(d, policy, world));
  const every = [...new Set(rows.flatMap((r) => [...r.actions.keys()]))].sort(
    (a, b) =>
      rows.reduce((s, r) => s + (r.actions.get(b) ?? 0), 0) -
      rows.reduce((s, r) => s + (r.actions.get(a) ?? 0), 0),
  );

  // widest action name is request_instrument_update, at 25.
  const w = 28;
  const col = (s: string) => s.padStart(14);
  console.log(`\nbatch ${batch} · policy ${policy}\n`);
  console.log('counter'.padEnd(w) + rows.map((r) => col(r.label.slice(-14))).join(''));
  console.log('-'.repeat(w + 14 * rows.length));
  for (const a of every) {
    console.log(a.padEnd(w) + rows.map((r) => col(String(r.actions.get(a) ?? 0))).join(''));
  }
  console.log('-'.repeat(w + 14 * rows.length));
  console.log('model decisions'.padEnd(w) + rows.map((r) => col(String(r.decisions))).join(''));
  console.log('idle retry (waited)'.padEnd(w) + rows.map((r) => col(String(r.idle_retry))).join(''));
  console.log('AFA: request_afa'.padEnd(w) + rows.map((r) => col(String(r.afa_request))).join(''));
  console.log('AFA: retry_debit'.padEnd(w) + rows.map((r) => col(String(r.afa_retry))).join(''));

  // recovered value, for context only - see the note at the top of this file
  console.log('');
  for (const d of runs) {
    const cases = readFileSync(path.join(d, `cases.${policy}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { recovered_paise: number });
    const total = cases.reduce((a, c) => a + c.recovered_paise, 0);
    console.log(`  ${path.basename(d).padEnd(28)} recovered ${formatINR(paise(total))}`);
  }
  console.log('\n  (recovered value is context. On a small batch it is noise; the counters are the signal.)\n');
}

main();
