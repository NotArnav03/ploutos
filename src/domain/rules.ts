import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { RULES_PATH } from './paths.js';

/**
 * Loader for the rules registry.
 *
 * Two things matter here beyond parsing. First, `require()` throws on an
 * unknown rule_id, so a typo in the policy engine is a startup failure rather
 * than a silently skipped check. Second, `verification` is carried through in
 * full, so the report generator can print exactly which enforced bounds are
 * our own invented parameters and which are backed by a source. That list goes
 * in the README verbatim. It is the difference between "compliance-bounded by
 * a configurable registry" and an unsupportable claim of regulatory compliance.
 */

export const RuleKindSchema = z.enum([
  'eligibility',
  'compliance',
  'rate_limit',
  'stop',
  'authority',
]);
export type RuleKind = z.infer<typeof RuleKindSchema>;

export const SeveritySchema = z.enum(['critical', 'high', 'medium']);
export type Severity = z.infer<typeof SeveritySchema>;

export const VerificationSchema = z.object({
  status: z.enum(['verified', 'unverified']),
  source_url: z.string().url().nullable(),
  note: z.string().min(1),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const RuleSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: RuleKindSchema,
  severity: SeveritySchema,
  /** Counted in the harm metrics. A run that trips one of these is a failed run. */
  harm_metric: z.boolean(),
  summary: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  verification: VerificationSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

export const RulesFileSchema = z.object({
  version: z.number().int().positive(),
  defaults: z.object({ timezone: z.string() }),
  rules: z.array(RuleSchema).min(1),
});
export type RulesFile = z.infer<typeof RulesFileSchema>;

let cached: RulesFile | null = null;

export function loadRules(file = RULES_PATH): RulesFile {
  if (file === RULES_PATH && cached) return cached;

  const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
  const parsed = RulesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`${file} failed validation:\n${detail}`);
  }

  const seen = new Set<string>();
  for (const r of parsed.data.rules) {
    if (seen.has(r.id)) throw new Error(`duplicate rule id ${r.id}`);
    seen.add(r.id);
  }

  if (file === RULES_PATH) cached = parsed.data;
  return parsed.data;
}

export class RuleRegistry {
  private readonly byId: Map<string, Rule>;
  readonly timezone: string;

  constructor(private readonly file: RulesFile = loadRules()) {
    this.byId = new Map(file.rules.map((r) => [r.id, r]));
    this.timezone = file.defaults.timezone;
  }

  all(): readonly Rule[] {
    return this.file.rules;
  }

  /** Throws on an unknown id, so a typo fails loudly at startup. */
  require(id: string): Rule {
    const r = this.byId.get(id);
    if (!r) throw new Error(`unknown rule_id ${id}`);
    return r;
  }

  /** Typed parameter read. Throws if absent, for the same reason as above. */
  param<T>(id: string, key: string, schema: z.ZodType<T>): T {
    const rule = this.require(id);
    const value = rule.params[key];
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `rule ${id} param ${key} is invalid: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }
    return parsed.data;
  }

  byKind(kind: RuleKind): readonly Rule[] {
    return this.file.rules.filter((r) => r.kind === kind);
  }

  /** Rules whose breach is counted as harm rather than as lost revenue. */
  harmRules(): readonly Rule[] {
    return this.file.rules.filter((r) => r.harm_metric);
  }

  /** Enforced bounds whose parameter we invented. Printed in the README. */
  unverified(): readonly Rule[] {
    return this.file.rules.filter((r) => r.verification.status === 'unverified');
  }
}
