import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { FailureClassSchema, RailSchema, RemedySchema } from './schemas.js';
import { MIX_PATH, TAXONOMY_PATH } from './paths.js';

export const FailureCodeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().min(1),
  class: FailureClassSchema,
  rails: z.array(RailSchema).min(1),
  retryable: z.boolean(),
  min_retry_gap_hours: z.number().nonnegative(),
  remedy: RemedySchema,
  modeled_on: z.string().min(1),
  description: z.string().min(1),
});
export type FailureCode = z.infer<typeof FailureCodeSchema>;

export const TaxonomySchema = z.object({
  version: z.number().int().positive(),
  codes: z.array(FailureCodeSchema).min(1),
});
export type Taxonomy = z.infer<typeof TaxonomySchema>;

export const MixSchema = z.object({
  label: z.string().min(1),
  rationale: z.string().min(1),
  hard_share_note: z.string().min(1),
  weights: z.record(z.string(), z.number().min(0).max(1)),
});
export type Mix = z.infer<typeof MixSchema>;

export const MixFileSchema = z.object({
  version: z.number().int().positive(),
  default_mix: z.string(),
  mixes: z.record(z.string(), MixSchema),
});
export type MixFile = z.infer<typeof MixFileSchema>;

function loadYaml<T>(file: string, schema: z.ZodType<T>): T {
  const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`${file} failed validation:\n${detail}`);
  }
  return parsed.data;
}

let cachedTaxonomy: Taxonomy | null = null;
let cachedMixes: MixFile | null = null;

export function loadTaxonomy(file = TAXONOMY_PATH): Taxonomy {
  if (file === TAXONOMY_PATH && cachedTaxonomy) return cachedTaxonomy;
  const t = loadYaml(file, TaxonomySchema);

  const seen = new Set<string>();
  for (const c of t.codes) {
    if (seen.has(c.code)) throw new Error(`duplicate failure code ${c.code}`);
    seen.add(c.code);
    // A hard failure that claims to be retryable would silently defeat every
    // stopping rule downstream, so refuse to load rather than warn.
    if (c.class === 'hard' && c.retryable) {
      throw new Error(`${c.code} is class hard but retryable: true`);
    }
    if (c.class === 'hard' && c.remedy !== 'none') {
      throw new Error(`${c.code} is class hard but claims remedy ${c.remedy}`);
    }
  }
  if (file === TAXONOMY_PATH) cachedTaxonomy = t;
  return t;
}

export function loadMixes(file = MIX_PATH): MixFile {
  if (file === MIX_PATH && cachedMixes) return cachedMixes;
  const m = loadYaml(file, MixFileSchema);
  if (!(m.default_mix in m.mixes)) {
    throw new Error(`default_mix ${m.default_mix} is not defined in mixes`);
  }
  if (file === MIX_PATH) cachedMixes = m;
  return m;
}

export class TaxonomyIndex {
  private readonly byCode: Map<string, FailureCode>;

  constructor(private readonly taxonomy: Taxonomy = loadTaxonomy()) {
    this.byCode = new Map(taxonomy.codes.map((c) => [c.code, c]));
  }

  all(): readonly FailureCode[] {
    return this.taxonomy.codes;
  }

  get(code: string): FailureCode {
    const c = this.byCode.get(code);
    if (!c) throw new Error(`unknown failure code ${code}`);
    return c;
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  isHard(code: string): boolean {
    return this.get(code).class === 'hard';
  }

  isRetryable(code: string): boolean {
    return this.get(code).retryable;
  }

  minGapHours(code: string): number {
    return this.get(code).min_retry_gap_hours;
  }

  forRail(rail: string): readonly FailureCode[] {
    return this.taxonomy.codes.filter((c) => (c.rails as readonly string[]).includes(rail));
  }
}
