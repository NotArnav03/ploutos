import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AuditEvent } from '../domain/audit.js';
import type { Exclusion } from '../domain/actions.js';
import { formatINR, paise, type Paise } from '../domain/money.js';
import { RESULTS_DIR } from '../domain/paths.js';
import { daysBetween, localParts, type Timestamp } from '../domain/time.js';
import { readLedgerFile, verifyChain } from '../ledger/ledger.js';

/**
 * `npm run replay -- --case CASE-00142`
 *
 * Renders one case's audit chain as a timeline a human can read.
 *
 * This is the part of the brief that says "audit trail". A JSONL file of
 * hash-chained records satisfies it on paper, but nobody - not a reviewer, not
 * a support agent handling an escalation, not me at 2am - can answer "why did
 * it do that" by reading 2.5KB of JSON per event. The trail is only worth
 * having if a single decision can be explained from it in seconds.
 *
 * Every line below comes from the ledger. Nothing is recomputed, re-simulated
 * or inferred: if it is on screen, it was recorded at the time, and the chain
 * verification above it says the record has not been edited since.
 */

const IST = 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function has(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

/** "Aug 01 14:00 IST" - the payer's clock, since every contact rule is in it. */
function ist(ts: Timestamp): string {
  const p = localParts(ts, IST);
  const mon = MONTHS[p.month - 1] ?? '???';
  const dd = String(p.day).padStart(2, '0');
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${mon} ${dd} ${hh}:${mm} IST`;
}

function short(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function latestRun(): string {
  if (!existsSync(RESULTS_DIR)) throw new Error(`no results directory at ${RESULTS_DIR}`);
  const dirs = readdirSync(RESULTS_DIR)
    .map((d) => path.join(RESULTS_DIR, d))
    .filter((d) => statSync(d).isDirectory())
    .filter((d) => ledgersIn(d).length > 0)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const first = dirs[0];
  if (!first) throw new Error(`no run directory under ${RESULTS_DIR} contains an audit ledger`);
  return first;
}

/** Ledger files in a run directory, as [policy, path] pairs. */
function ledgersIn(dir: string): [string, string][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('audit.') && (f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')))
    .map((f) => [f.replace(/^audit\./, '').replace(/\.jsonl(\.gz)?$/, ''), path.join(dir, f)]);
}

/** The action, rendered the way the policy expressed it. */
function describeAction(d: NonNullable<AuditEvent['decision']>): string {
  const a = d.action;
  switch (a.type) {
    case 'wait':
      return `wait until ${ist(a.until)}`;
    case 'retry_debit':
      return `retry_debit on ${a.rail}`;
    case 'switch_rail':
      return `switch_rail to ${a.to_rail}`;
    case 'serve_predebit_notice':
      return `serve_predebit_notice via ${a.channel} for a debit at ${ist(a.for_debit_at)}`;
    case 'request_afa':
      return `request_afa via ${a.channel}`;
    case 'notify_soft':
      return `notify_soft via ${a.channel} (${a.template_id}, ${a.language})`;
    case 'request_instrument_update':
      return `request_instrument_update via ${a.channel} (${a.template_id})`;
    case 'send_payment_link':
      return `send_payment_link via ${a.channel}, expires ${ist(a.expires_at)}`;
    case 'capture_promise_to_pay':
      return `capture_promise_to_pay for ${ist(a.promised_for)}`;
    case 'grant_grace':
      return `grant_grace to ${ist(a.new_due_date)}`;
    case 'handoff_human':
      return `handoff_human (${a.priority}): ${a.reason}`;
    case 'stop_terminal':
      return `stop_terminal (${a.disposition}) under ${a.rule_id}`;
  }
}

/**
 * Refusals, grouped by rule.
 *
 * The grouping matters: eleven separate lines saying CONSENT_REQUIRED is noise,
 * while "CONSENT_REQUIRED refused 6 actions" is the actual shape of the
 * situation. The rule that blocked the debit is what a reviewer is looking for.
 */
const GUTTER = ' '.repeat(18);

function renderExclusions(excluded: readonly Exclusion[], full: boolean): string[] {
  if (excluded.length === 0) return [];
  const byRule = new Map<string, Exclusion[]>();
  for (const e of excluded) {
    const list = byRule.get(e.rule_id);
    if (list) list.push(e);
    else byRule.set(e.rule_id, [e]);
  }

  // Debit-blocking rules first: that is almost always the question being asked.
  const order = [...byRule.entries()].sort((a, b) => {
    const debit = (xs: Exclusion[]): number =>
      xs.some((x) => x.action_type === 'retry_debit' || x.action_type === 'switch_rail') ? 0 : 1;
    return debit(a[1]) - debit(b[1]) || b[1].length - a[1].length;
  });

  const shown = full ? order : order.slice(0, 4);
  const lines: string[] = [];
  for (const [rule, xs] of shown) {
    const targets = xs
      .map((x) => (x.channel === null ? x.action_type : `${x.action_type}/${x.channel}`))
      .slice(0, full ? xs.length : 3);
    const more = xs.length > targets.length ? ` +${xs.length - targets.length}` : '';
    lines.push(`${GUTTER}${rule.padEnd(24)} ${targets.join(', ')}${more}`);
    lines.push(`${GUTTER}${' '.repeat(24)} ${xs[0]?.detail ?? ''}`);
  }
  if (!full && order.length > shown.length) {
    lines.push(`${GUTTER}… ${order.length - shown.length} more rule(s); pass --full to see them`);
  }
  return lines;
}

function money(p: Paise): string {
  return formatINR(p);
}

function main(): void {
  const argv = process.argv.slice(2);
  const runDir = arg(argv, '--run') ?? latestRun();
  const caseId = arg(argv, '--case');
  const full = has(argv, '--full');
  const verifyOnly = has(argv, '--verify');

  const ledgers = ledgersIn(runDir);
  if (ledgers.length === 0) throw new Error(`no audit ledger in ${runDir}`);

  console.log(`\nrun ${path.basename(runDir)}`);

  // ---- whole-ledger verification
  //
  // Offered on its own because "the trail verifies" is a claim about the batch,
  // not about one case, and it is the claim the metrics step depends on.
  if (verifyOnly) {
    let total = 0;
    let broken = 0;
    for (const [policy, file] of ledgers) {
      const events = readLedgerFile(file);
      const breaks = verifyChain(events);
      total += events.length;
      broken += breaks.length;
      const sizeMb = (statSync(file).size / 1_048_576).toFixed(2);
      console.log(
        `  ${policy.padEnd(16)} ${String(events.length).padStart(6)} events  ${sizeMb.padStart(6)} MB  ` +
          (breaks.length === 0
            ? 'chain VERIFIED'
            : `${breaks.length} BREAK(S), first at ${breaks[0]?.case_id} seq ${breaks[0]?.seq} (${breaks[0]?.reason})`),
      );
    }
    console.log(
      `\n${broken === 0 ? 'all chains verified' : `${broken} broken link(s)`} across ${total} events\n`,
    );
    if (broken > 0) process.exitCode = 1;
    return;
  }

  if (caseId === undefined) {
    throw new Error('pass --case CASE-00001, or --verify to check every chain in the run');
  }

  const requested = arg(argv, '--policy');
  const chosen =
    requested === 'all'
      ? ledgers
      : requested !== undefined
        ? ledgers.filter(([p]) => p === requested)
        : ledgers.filter(([p]) => p === 'static-policy').concat(ledgers).slice(0, 1);

  if (chosen.length === 0) {
    throw new Error(`no ledger for policy ${requested}; have ${ledgers.map((l) => l[0]).join(', ')}`);
  }

  for (const [policy, file] of chosen) {
    const events = readLedgerFile(file).filter((e) => e.case_id === caseId);
    if (events.length === 0) {
      console.log(`\n  ${caseId} does not appear in the ${policy} ledger`);
      continue;
    }
    renderCase(caseId, policy, events, full);
  }
}

function renderCase(caseId: string, policy: string, events: AuditEvent[], full: boolean): void {
  events.sort((a, b) => a.seq - b.seq);

  // ---- integrity first.
  //
  // Printed above the timeline rather than below it, because everything that
  // follows is only meaningful if the records have not been edited. A reader
  // who trusts the story and then discovers the chain was broken has been
  // misled by the layout.
  const breaks = verifyChain(events);
  const head = events[events.length - 1];
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`${caseId} · ${policy}`);
  console.log('─'.repeat(78));
  if (breaks.length === 0) {
    console.log(`chain    VERIFIED · ${events.length} events · seq 1..${head?.seq ?? 0}`);
    console.log(`         head ${short(head?.hash ?? '')}`);
  } else {
    console.log(`chain    ${breaks.length} BREAK(S) — this trail cannot be trusted`);
    for (const b of breaks.slice(0, 5)) console.log(`         seq ${b.seq}: ${b.reason}`);
    process.exitCode = 1;
  }

  const recovered = events.reduce((a, e) => a + e.money_delta_paise, 0);
  const cost = events.reduce((a, e) => a + e.cost_paise, 0);
  const attempts = events.filter((e) => e.outcome !== null && e.outcome.code !== undefined).length;
  // Collections messages and compliance notices are counted apart, the same way
  // the metrics count them. A mandatory pre-debit notice is not pressure on the
  // payer, and a summary that lumps the two together would make a policy that
  // followed the rules look pushier than one that skipped them (see C-008).
  const decisions = events.flatMap((e) => (e.decision ? [e.decision.action] : []));
  const notices = decisions.filter((a) => a.type === 'serve_predebit_notice').length;
  const messages = decisions.filter(
    (a) => a.type !== 'serve_predebit_notice' && 'channel' in a && a.channel !== null,
  ).length;
  const stop = events.find((e) => e.event_type === 'stop');
  const first = events[0];
  const span =
    first && head ? daysBetween(first.ts_sim, head.ts_sim) : 0;

  console.log(
    `outcome  ${recovered > 0 ? `RECOVERED ${money(paise(recovered))}` : 'not recovered'}` +
      ` over ${span.toFixed(1)} days` +
      (stop?.stop_reason ? ` · closed by ${stop.stop_reason}` : ''),
  );
  console.log(
    `cost     ${money(paise(cost))} · ${attempts} outcome(s), ` +
      `${messages} collections message(s), ${notices} compliance notice(s)\n`,
  );

  for (const e of events) {
    const seq = `#${e.seq}`.padStart(4);
    const when = ist(e.ts_sim);

    if (e.event_type === 'eligibility') {
      console.log(`${seq}  ${when}  gate`);
      console.log(`      permitted   ${(e.permitted ?? []).join(', ') || '(nothing)'}`);
      const lines = renderExclusions(e.excluded ?? [], full);
      // Only the first line carries the label; the rest align under it.
      for (const [i, l] of lines.entries()) {
        console.log(i === 0 ? `      refused     ${l.slice(GUTTER.length)}` : l);
      }
    } else if (e.event_type === 'decision' && e.decision) {
      const d = e.decision;
      const via = d.model ? ` · ${d.model}${d.cache_hit ? ' (cached)' : ''}` : '';
      console.log(`${seq}  ${when}  decision · ${d.policy}${via}`);
      console.log(`      ${describeAction(d)}`);
      if (d.diagnosis) console.log(`      diagnosis   ${d.diagnosis}`);
      console.log(`      because     "${d.rationale}"`);
      if (d.confidence !== null) console.log(`      confidence  ${d.confidence.toFixed(2)}`);
      if (d.fell_back) {
        console.log(`      !! the gate refused this policy's own choice; a fallback was substituted`);
      }
    } else if (e.event_type === 'outcome' && e.outcome) {
      const o = e.outcome;
      const settled = o.settled_paise !== null ? ` ${money(o.settled_paise)}` : '';
      console.log(
        `${seq}  ${when}  outcome     ${o.status.toUpperCase()}${o.code ? ` ${o.code}` : ''}${settled}` +
          (e.cost_paise > 0 ? `  (cost ${money(e.cost_paise)})` : ''),
      );
    } else if (e.event_type === 'violation' && e.violation) {
      const v = e.violation;
      console.log(`${seq}  ${when}  VIOLATION   ${v.rule_id} [${v.severity}]${v.harm ? ' HARM' : ''}`);
      console.log(`      attempted   ${v.attempted_action ?? '—'}`);
      console.log(`      ${v.detail}`);
    } else if (e.event_type === 'stop') {
      console.log(`${seq}  ${when}  STOP        ${e.stop_reason}`);
    } else {
      console.log(`${seq}  ${when}  ${e.event_type}`);
    }
  }
  console.log('');
}

try {
  main();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
