import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditEvent } from '../domain/audit.js';
import { verifyChain } from '../ledger/ledger.js';
import { CostModel } from '../domain/costs.js';
import { formatINR, paise, type Paise } from '../domain/money.js';
import { BATCH_DIR, RESULTS_DIR } from '../domain/paths.js';
import type { AnyPolicy } from '../domain/policy.js';
import { RuleRegistry } from '../domain/rules.js';
import { TaxonomyIndex } from '../domain/taxonomy.js';
import { doNothing, naiveRetry } from '../policy/baselines.js';
import { runBatch, type RunResult } from '../eval/runner.js';
import { computeMetrics, uplift, type Metrics } from '../metrics/compute.js';
import type { LatentState } from '../world/latent.js';
import type { World, WorldCase } from '../world/types.js';

const POLICIES: Record<string, AnyPolicy<LatentState>> = {
  'do-nothing': doNothing,
  'naive-retry': naiveRetry,
};

function loadWorld(name: string): World {
  const meta = JSON.parse(
    readFileSync(path.join(BATCH_DIR, `${name}.meta.json`), 'utf8'),
  ) as Pick<World, 'meta' | 'issuers'>;
  const cases = readFileSync(path.join(BATCH_DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as WorldCase);
  return { meta: meta.meta, issuers: meta.issuers, cases };
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function pct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const batch = arg(argv, '--batch') ?? 'main';
  const seed = Number(arg(argv, '--seed') ?? 42);
  const requested = (arg(argv, '--policy') ?? 'do-nothing,naive-retry').split(',');

  const registry = new RuleRegistry();
  const taxonomy = new TaxonomyIndex();
  const costs = new CostModel();
  const world = loadWorld(batch);

  const runId = `${batch}-s${seed}-${Date.now().toString(36)}`;
  const outDir = path.join(RESULTS_DIR, runId);
  mkdirSync(outDir, { recursive: true });

  const ltvByCase = new Map<string, Paise>(
    world.cases.map((c) => [c.case_id, c.customer.ltv_paise]),
  );

  console.log(`\nbatch ${batch} · ${world.cases.length} cases · mix ${world.meta.mix} · seed ${seed}`);
  console.log(`run ${runId}\n`);

  const runs: RunResult[] = [];
  const metrics: Metrics[] = [];

  for (const name of requested) {
    const policy = POLICIES[name];
    if (!policy) {
      throw new Error(`unknown policy ${name}; have ${Object.keys(POLICIES).join(', ')}`);
    }
    // Each policy runs against a FRESH copy of the world. Latent state mutates
    // when a payer engages, so sharing it between policies would let one
    // policy's nudges silently help the next one.
    const fresh = loadWorld(batch);
    const result = await runBatch({
      world: fresh,
      policy,
      registry,
      taxonomy,
      costs,
      run_id: `${runId}-${name}`,
      ledger_path: path.join(outDir, `audit.${name}.jsonl`),
      seed,
    });
    // A tampered or broken trail is worse than no trail, because it still looks
    // credible. Refuse to report numbers derived from one.
    const events = readFileSync(result.ledger_path, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditEvent);
    const breaks = verifyChain(events);
    if (breaks.length > 0) {
      throw new Error(
        `audit chain for ${name} failed verification at ` +
          `${breaks[0]?.case_id} seq ${breaks[0]?.seq} (${breaks[0]?.reason}); refusing to report metrics`,
      );
    }

    runs.push(result);
    metrics.push(computeMetrics({ run: result, costs, registry, ltvByCase }));
    process.stdout.write(
      `  ran ${name.padEnd(14)} ${result.wall_ms.toString().padStart(6)}ms  ` +
        `${result.ledger_events} ledger events\n`,
    );
  }

  writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  for (const r of runs) {
    writeFileSync(
      path.join(outDir, `cases.${r.policy}.jsonl`),
      r.cases.map((c) => JSON.stringify(c)).join('\n') + '\n',
    );
  }

  // ---- comparison table
  const atRisk = metrics[0]?.at_risk_paise ?? paise(0);
  const hardValue = metrics[0]?.hard_value_paise ?? paise(0);

  console.log(`\nvalue at risk              ${formatINR(atRisk)}`);
  console.log(
    `structurally unrecoverable ${formatINR(hardValue)}  (${pct(hardValue / atRisk)})`,
  );
  console.log(
    `\n  NOTE: the recoverable ceiling requires the oracle policy, which lands on\n` +
      `  day 4. Until then percentages are against FACE VALUE, which no policy can\n` +
      `  reach, and are reported that way rather than dressed up as a ceiling.\n`,
  );

  const head = [
    'policy'.padEnd(14),
    'recovered'.padStart(15),
    'of face'.padStart(9),
    'net'.padStart(15),
    'cases'.padStart(7),
    'atts'.padStart(6),
    'msgs'.padStart(6),
    'notices'.padStart(7),
    'harm'.padStart(6),
  ].join(' ');
  console.log(head);
  console.log('-'.repeat(head.length));

  for (const m of metrics) {
    console.log(
      [
        m.policy.padEnd(14),
        formatINR(m.recovered_paise).padStart(15),
        pct(m.recovery_rate_vs_at_risk).padStart(9),
        formatINR(paise(Math.max(0, m.net_recovered_paise))).padStart(15),
        `${m.recovered_count}`.padStart(7),
        `${m.attempts_total}`.padStart(6),
        `${m.contacts_total}`.padStart(6),
        `${m.notices_total}`.padStart(7),
        (m.harm.clean ? 'clean' : `${m.harm.total_violations}`).padStart(6),
      ].join(' '),
    );
  }

  const base = metrics.find((m) => m.policy === 'do-nothing');
  const naive = metrics.find((m) => m.policy === 'naive-retry');
  if (base && naive) {
    const u = uplift(naive, base);
    console.log(
      `\nnaive-retry over do-nothing: +${formatINR(paise(Math.max(0, u.absolute_paise)))}`,
    );
    console.log(
      `  95% CI on naive-retry recovery: ` +
        `${formatINR(naive.recovered_ci_low)} .. ${formatINR(naive.recovered_ci_high)}`,
    );
    console.log(`  median days to recovery: ${naive.median_days_to_recovery?.toFixed(1) ?? '—'}`);
    console.log(`  cost per Rs 100 recovered: ${naive.cost_per_100_recovered?.toFixed(2) ?? '—'}`);
  }

  for (const m of metrics) {
    if (!m.harm.clean) {
      console.log(
        `\n  !! ${m.policy} tripped ${m.harm.total_violations} violation(s), ` +
          `including ${m.harm.double_charge_attempts} double charge(s).`,
      );
    }
  }

  console.log(`\nwrote ${outDir}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
