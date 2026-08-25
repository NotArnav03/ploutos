import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatINR, paise, sumPaise, type Paise } from '../domain/money.js';
import { BATCH_DIR } from '../domain/paths.js';
import { TaxonomyIndex } from '../domain/taxonomy.js';
import { generateWorld } from '../world/generator.js';

interface Args {
  seed: number;
  size: number;
  mix: string | undefined;
  name: string;
  adversarial: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const size = Number(get('--size') ?? 500);
  const seed = Number(get('--seed') ?? 42);
  const adversarial = Number(get('--adversarial') ?? 0.05);
  if (!Number.isInteger(size) || size <= 0) throw new Error('--size must be a positive integer');
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');

  return {
    seed,
    size,
    mix: get('--mix'),
    name: get('--name') ?? 'main',
    adversarial,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const taxonomy = new TaxonomyIndex();

  const started = Date.now();
  const { world, target_mix, realised_mix, relabelled } = generateWorld({
    seed: args.seed,
    size: args.size,
    ...(args.mix !== undefined ? { mix: args.mix } : {}),
    adversarial_share: args.adversarial,
  });
  const elapsed = Date.now() - started;

  mkdirSync(BATCH_DIR, { recursive: true });
  const casesPath = path.join(BATCH_DIR, `${args.name}.jsonl`);
  const metaPath = path.join(BATCH_DIR, `${args.name}.meta.json`);

  writeFileSync(casesPath, world.cases.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
  writeFileSync(
    metaPath,
    JSON.stringify({ meta: world.meta, issuers: world.issuers }, null, 2) + '\n',
    'utf8',
  );

  // ---- summary
  const atRisk = sumPaise(world.cases.map((c) => c.invoice.amount_paise));
  const hardValue = sumPaise(
    world.cases
      .filter((c) => taxonomy.isHard(c.invoice.attempts[0]?.code ?? ''))
      .map((c) => c.invoice.amount_paise),
  );

  console.log(`\ngenerated ${world.cases.length} cases in ${elapsed}ms`);
  console.log(`  seed ${world.meta.seed} · mix ${world.meta.mix} · horizon ${world.meta.horizon_days}d`);
  console.log(`  ${casesPath}`);
  console.log(`  ${metaPath}`);

  console.log(`\nvalue at risk        ${formatINR(atRisk)}`);
  console.log(
    `structurally hard    ${formatINR(hardValue)}  (${pct(hardValue / atRisk)} of value)`,
  );
  console.log(
    `relabelled           ${relabelled}/${world.cases.length} (${pct(relabelled / world.cases.length)}) ` +
      `— cases where the mechanism produced a different code than drawn`,
  );

  console.log('\ncode                       target   realised    drift');
  console.log('  ' + '-'.repeat(52));
  const codes = taxonomy.all().map((c) => c.code);
  for (const code of codes) {
    const t = target_mix[code] ?? 0;
    const r = realised_mix[code] ?? 0;
    if (t === 0 && r === 0) continue;
    const drift = r - t;
    const flag = Math.abs(drift) > 0.04 ? '  <-- check' : '';
    console.log(
      `  ${code.padEnd(24)} ${pct(t).padStart(6)}  ${pct(r).padStart(8)}  ${(drift >= 0 ? '+' : '') + pct(drift).padStart(6)}${flag}`,
    );
  }

  const advCount = world.cases.filter((c) => c.adversarial !== null).length;
  console.log(`\nadversarial cases    ${advCount} (${pct(advCount / world.cases.length)})`);
  const byKind = new Map<string, number>();
  for (const c of world.cases) {
    if (c.adversarial) byKind.set(c.adversarial, (byKind.get(c.adversarial) ?? 0) + 1);
  }
  for (const [kind, n] of [...byKind].sort()) console.log(`  ${kind.padEnd(28)} ${n}`);

  const rails = new Map<string, Paise>();
  for (const c of world.cases) {
    rails.set(
      c.subscription.rail,
      paise((rails.get(c.subscription.rail) ?? 0) + c.invoice.amount_paise),
    );
  }
  console.log('\nvalue by rail');
  for (const [rail, v] of [...rails].sort()) {
    console.log(`  ${rail.padEnd(28)} ${formatINR(v).padStart(14)}`);
  }
  console.log('');
}

main();
