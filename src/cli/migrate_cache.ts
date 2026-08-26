import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CostModel } from '../domain/costs.js';
import { RuleRegistry } from '../domain/rules.js';
import { TaxonomyIndex } from '../domain/taxonomy.js';
import { BATCH_DIR } from '../domain/paths.js';
import { runBatch } from '../eval/runner.js';
import { readLedgerFile } from '../ledger/ledger.js';
import { CACHE_DIR, DecisionCache, cacheKey, type CacheEntry } from '../agent/cache.js';
import { PROMPT_VERSION } from '../agent/prompt.js';
import { AgentOutputSchema } from '../agent/schema.js';
import type { Policy, PolicyDecision, PolicyInput } from '../domain/policy.js';
import type { World, WorldCase } from '../world/types.js';

/**
 * Re-key recorded decisions after a change to what an observation contains.
 *
 * WHY THIS EXISTS
 *
 * The decision cache is keyed on `observation_hash`, so a fix that changes what
 * a case observes orphans every decision recorded before it - even though the
 * decisions are still exactly what the model said about exactly those
 * situations. C-020 was such a fix, and re-querying would have meant paying for
 * 2,736 identical judgements a second time.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not invent, adjust or re-interpret a decision. It replays the
 * committed audit trail decision-for-decision and copies each recorded model
 * output verbatim under the corrected key. The refusal conditions are the
 * safety: if the gate offers a different permitted set at any point than the one
 * the model actually chose from, that decision is not transferable, and the
 * migration aborts rather than silently re-labelling it.
 */

function loadWorld(name: string): World {
  const meta = JSON.parse(
    readFileSync(path.join(BATCH_DIR, `${name}.meta.json`), 'utf8'),
  ) as Pick<World, 'meta' | 'issuers'>;
  return {
    meta: meta.meta,
    issuers: meta.issuers,
    cases: readFileSync(path.join(BATCH_DIR, `${name}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as WorldCase),
  };
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const batch = arg(argv, '--batch') ?? 'main';
  const from = arg(argv, '--from');
  const apply = argv.includes('--apply');
  if (from === undefined) {
    throw new Error('usage: migrate-cache --from <results dir> [--batch main] [--apply]');
  }

  // ---- what the committed run actually did, point by point
  const events = readLedgerFile(path.join(from, 'audit.agent.jsonl.gz'));
  const eligibility = new Map<string, { permitted: string[]; hash: string }>();
  const decisions = new Map<string, NonNullable<(typeof events)[number]['decision']>>();
  for (const e of events) {
    const k = `${e.case_id}@${e.ts_sim}`;
    if (e.event_type === 'eligibility') {
      eligibility.set(k, { permitted: e.permitted ?? [], hash: e.observation_hash ?? '' });
    }
    if (e.decision && e.decision.model !== null) decisions.set(k, e.decision);
  }

  const existing = JSON.parse(
    readFileSync(path.join(CACHE_DIR, 'decisions.json'), 'utf8'),
  ) as CacheEntry[];
  const byOldHash = new Map(existing.map((e) => [e.observation_hash, e]));

  let unchanged = 0;
  const problems: string[] = [];
  const additions: CacheEntry[] = [];

  const replayer: Policy = {
    name: 'agent',
    usesLatentState: false,
    async decide(input: PolicyInput): Promise<PolicyDecision> {
      const p = input.permitted;
      const k = `${p.case_id}@${input.ctx.now}`;
      const rec = decisions.get(k);
      const el = eligibility.get(k);

      if (rec !== undefined && el !== undefined && p.permitted.length > 1) {
        // Only transferable if the model is being offered the same choice it
        // originally chose from.
        if (JSON.stringify(el.permitted) !== JSON.stringify([...p.permitted])) {
          problems.push(`${k}: permitted set changed`);
        } else {
          const old = byOldHash.get(el.hash);
          const parsed = old ? AgentOutputSchema.safeParse(old.output) : null;
          if (!old) problems.push(`${k}: no recorded output for observation ${el.hash}`);
          else if (!parsed?.success) problems.push(`${k}: recorded output no longer validates`);
          else if (el.hash === p.observation_hash) unchanged++;
          else {
            additions.push({
              ...old,
              key: cacheKey({
                prompt_version: PROMPT_VERSION,
                model: old.model,
                observation_hash: p.observation_hash,
                permitted: p.permitted,
                permitted_channels: p.permitted_channels,
              }),
              observation_hash: p.observation_hash,
              output: parsed.data,
            });
          }
        }
      }

      if (rec !== undefined) {
        return {
          action: rec.action,
          diagnosis: rec.diagnosis,
          rationale: rec.rationale,
          confidence: rec.confidence,
          meta: {
            model: rec.model,
            prompt_version: rec.prompt_version,
            tokens_in: rec.tokens_in,
            tokens_out: rec.tokens_out,
            latency_ms: null,
            cache_hit: true,
          },
        };
      }
      return {
        action: { type: 'wait', until: input.ctx.now },
        diagnosis: null,
        rationale: 'no recorded decision at this point',
        confidence: null,
        meta: {
          model: null,
          prompt_version: PROMPT_VERSION,
          tokens_in: null,
          tokens_out: null,
          latency_ms: null,
          cache_hit: false,
        },
      };
    },
  };

  await runBatch({
    world: loadWorld(batch),
    policy: replayer,
    registry: new RuleRegistry(),
    taxonomy: new TaxonomyIndex(),
    costs: new CostModel(),
    run_id: 'migrate',
    ledger_path: path.join(CACHE_DIR, 'migrate.jsonl'),
    seed: Number(arg(argv, '--seed') ?? 42),
    // The committed run's concurrency is irrelevant now: observations no longer
    // depend on it, which is the whole point of the fix being migrated.
    concurrency: 1,
  });

  console.log(`\nreplayed ${decisions.size} recorded decisions from ${from}`);
  console.log(`  ${unchanged} already key correctly`);
  console.log(`  ${additions.length} need re-keying under a corrected observation hash`);
  console.log(`  ${problems.length} not transferable`);
  for (const p of problems.slice(0, 5)) console.log(`    ${p}`);

  if (problems.length > 0) {
    throw new Error(
      `${problems.length} decision(s) could not be transferred; refusing a partial migration`,
    );
  }
  if (!apply) {
    console.log('\ndry run. re-run with --apply to write these entries.');
    return;
  }

  const cache = new DecisionCache();
  for (const e of additions) cache.put(e);
  cache.flush();
  console.log(`\nwrote ${additions.length} re-keyed entries to ${CACHE_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
