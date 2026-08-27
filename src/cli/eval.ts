import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../domain/env.js';
import { readLedgerFile, verifyChain } from '../ledger/ledger.js';
import { CostModel } from '../domain/costs.js';
import { formatINR, paise, type Paise } from '../domain/money.js';
import { BATCH_DIR, RESULTS_DIR } from '../domain/paths.js';
import { OracleViolationError, type AnyPolicy } from '../domain/policy.js';
import { RuleRegistry } from '../domain/rules.js';
import { TaxonomyIndex, loadMixes } from '../domain/taxonomy.js';
import { doNothing, naiveRetry } from '../policy/baselines.js';
import { staticPolicy } from '../policy/static_policy.js';
import { makeOracle } from '../world/oracle.js';
import { makeAgent } from '../agent/agent.js';
import { runBatch, type RunResult } from '../eval/runner.js';
import { computeMetrics, pairedComparison, uplift, type Metrics } from '../metrics/compute.js';
import type { LatentState } from '../world/latent.js';
import type { World, WorldCase } from '../world/types.js';

const POLICIES: Record<string, AnyPolicy<LatentState>> = {
  'do-nothing': doNothing,
  'naive-retry': naiveRetry,
  'static-policy': staticPolicy,
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
  loadEnv();
  const argv = process.argv.slice(2);
  const batch = arg(argv, '--batch') ?? 'main';
  const seed = Number(arg(argv, '--seed') ?? 42);
  const requested = (arg(argv, '--policy') ?? 'do-nothing,naive-retry,static-policy,agent,oracle').split(',');
  // Pinned in source by default so a committed result replays; an explicit flag
  // is the only way to change it, which is the only time changing it is
  // meaningful. The cache is keyed on the model, so two models never mix.
  const model = arg(argv, '--model');

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

  // A diagnostic mix is a probe, not a benchmark. Saying so once, loudly, at
  // the top of the output is what stops a number measured on one from being
  // quoted later as a recovery result.
  if (loadMixes().mixes[world.meta.mix]?.diagnostic === true) {
    console.log(
      `  !! ${world.meta.mix} is a DIAGNOSTIC mix. It over-weights specific failure` +
        `\n     modes to exercise a defect and is not a claim about reality.` +
        `\n     Nothing measured here is a recovery result. Use it to read the` +
        `\n     behavioural counters, never the rupees.\n`,
    );
  }

  const runs: RunResult[] = [];
  const metrics: Metrics[] = [];

  const noCache = argv.includes('--no-cache');
  // Applied to the agent alone. Every deterministic policy stays on the
  // sequential path that produced the committed baselines.
  const concurrency = Number(arg(argv, '--concurrency') ?? 8);
  let agent: ReturnType<typeof makeAgent> | null = null;

  for (const name of requested) {
    if (name === 'agent') agent ??= makeAgent({ noCache, ...(model ? { model } : {}) });
    const policy =
      name === 'oracle'
        ? makeOracle(world, seed, registry, staticPolicy)
        : name === 'agent'
          ? agent
          : POLICIES[name];
    if (!policy) {
      throw new Error(
        `unknown policy ${name}; have ${Object.keys(POLICIES).join(', ')}, agent, oracle`,
      );
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
      ledger_path: path.join(outDir, `audit.${name}.jsonl.gz`),
      seed,
      concurrency: name === 'agent' ? concurrency : 1,
    });
    // A tampered or broken trail is worse than no trail, because it still looks
    // credible. Refuse to report numbers derived from one.
    const events = readLedgerFile(result.ledger_path);
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

    if (name === 'agent' && agent) {
      // Written to disk as soon as the run finishes, so a crash later in the
      // batch does not throw away decisions that were already paid for.
      agent.flush();
      const s = agent.stats;
      const perCall = s.calls > 0 ? result.wall_ms / s.calls : 0;
      process.stdout.write(
        `    ${s.cache_hits} cached, ${s.calls} live call(s) at concurrency ${concurrency}, ` +
          `${s.retries} retried, ${s.api_errors} error(s)\n` +
          `    ${s.tokens_in.toLocaleString()} in / ${s.tokens_out.toLocaleString()} out tokens` +
          (s.calls > 0 ? `, ${perCall.toFixed(0)}ms per decision` : '') +
          `\n`,
      );
      // What the thinking cost, beside what the acting cost. An agent that
      // spends more on inference than it recovers is not a recovery system.
      const m = metrics[metrics.length - 1];
      if (m) {
        process.stdout.write(
          (m.inference_cost_usd === null
            ? `    model spend unknown: no published price for ${m.model} in config/costs.yaml\n`
            : `    $${m.inference_cost_usd.toFixed(2)} of model spend over ${m.model_decisions} decisions` +
              (m.inference_usd_per_lakh_recovered === null
                ? `\n`
                : `, $${m.inference_usd_per_lakh_recovered.toFixed(2)} per Rs 1,00,000 recovered\n`)),
        );
      }
      if (s.api_errors > 0) {
        process.stdout.write(
          `    !! ${s.api_errors} decision(s) fell back to static-policy; this run is NOT a clean agent result\n` +
            `       last error: ${s.last_error ?? 'unknown'}\n`,
        );
      }
    }
  }

  // ---- the ceiling, and the invariant that guards it
  //
  // If any observation-only policy recovered more than the truth-aware oracle,
  // the oracle's search was incomplete and the ceiling it reported is wrong.
  // Every "percent of recoverable" figure downstream would then be an
  // overstatement, so the correct response is to fail the run rather than to
  // publish the higher number.
  const oracleMetrics = metrics.find((m) => m.policy === 'oracle');
  if (oracleMetrics) {
    for (const m of metrics) {
      if (m.policy === 'oracle') continue;
      if (m.recovered_paise > oracleMetrics.recovered_paise) {
        throw new OracleViolationError(m.policy, m.recovered_paise, oracleMetrics.recovered_paise);
      }
    }
    for (const m of metrics) {
      m.ceiling_paise = oracleMetrics.recovered_paise;
      m.recovery_vs_ceiling =
        oracleMetrics.recovered_paise === 0 ? null : m.recovered_paise / oracleMetrics.recovered_paise;
    }
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
  if (!oracleMetrics) {
    console.log(
      `\n  NOTE: this run did not include the oracle, so there is no derived\n` +
        `  ceiling. "of ceil" is blank and "of face" is measured against FACE\n` +
        `  VALUE, which no policy can reach.\n`,
    );
  } else {
    console.log(
      `recoverable ceiling        ${formatINR(oracleMetrics.recovered_paise)}` +
        `  (${pct(oracleMetrics.recovery_rate_vs_at_risk)} of face, derived by oracle search)\n`,
    );
  }

  const head = [
    'policy'.padEnd(14),
    'recovered'.padStart(15),
    'of face'.padStart(9),
    'of ceil'.padStart(9),
    'net'.padStart(15),
    'cases'.padStart(7),
    'atts'.padStart(6),
    'msgs'.padStart(6),
    'notices'.padStart(7),
    'refused'.padStart(7),
    'esc'.padStart(5),
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
        pct(m.recovery_vs_ceiling).padStart(9),
        formatINR(paise(Math.max(0, m.net_recovered_paise))).padStart(15),
        `${m.recovered_count}`.padStart(7),
        `${m.attempts_total}`.padStart(6),
        `${m.contacts_total}`.padStart(6),
        `${m.notices_total}`.padStart(7),
        `${m.harm.gate_rejections}`.padStart(7),
        `${m.escalated_count}`.padStart(5),
        (m.harm.clean ? 'clean' : `${m.harm.harm_events}`).padStart(6),
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

  // ---- paired comparison against the tuned rules engine
  //
  // Both policies ran the same cases, so the comparison is paired and the
  // per-case difference is the right thing to resample. Their independent
  // intervals overlap almost entirely and say nothing.
  const agentRun = runs.find((r) => r.policy === 'agent');
  const staticRun = runs.find((r) => r.policy === 'static-policy');
  if (agentRun && staticRun) {
    const cmp = pairedComparison(agentRun, staticRun);
    if (cmp) {
      const signed = (x: number) =>
        (x < 0 ? '-' : '+') + formatINR(paise(Math.abs(Math.round(x))));
      console.log(
        `\nagent vs static-policy, paired over ${cmp.n_cases} cases ` +
          `(${cmp.n_differing} of them reached different outcomes)`,
      );
      console.log(
        `  gross ${signed(cmp.gross_diff_paise)}  95% CI ${signed(cmp.gross_ci_low)} .. ${signed(cmp.gross_ci_high)}`,
      );
      console.log(
        `  net   ${signed(cmp.net_diff_paise)}  95% CI ${signed(cmp.net_ci_low)} .. ${signed(cmp.net_ci_high)}`,
      );
      const pct = (cmp.p_behind * 100).toFixed(1);
      console.log(
        `  the agent came out behind in ${pct}% of resamples` +
          (cmp.p_behind > 0.05 && cmp.p_behind < 0.95
            ? '  <- inside sampling noise; not a result either way'
            : ''),
      );
    }
  }

  for (const m of metrics) {
    if (!m.harm.clean) {
      console.log(
        `\n  !! ${m.policy} tripped ${m.harm.harm_events} violation(s), ` +
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
