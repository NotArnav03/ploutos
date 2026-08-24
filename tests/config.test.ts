import { describe, expect, it } from 'vitest';
import { loadMixes, loadTaxonomy, TaxonomyIndex } from '../src/domain/taxonomy.js';
import { loadRules, RuleRegistry } from '../src/domain/rules.js';

describe('failure taxonomy', () => {
  const tax = loadTaxonomy();
  const idx = new TaxonomyIndex(tax);

  it('parses and has unique codes', () => {
    expect(tax.codes.length).toBeGreaterThan(0);
    const codes = tax.codes.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('never marks a hard failure retryable', () => {
    // The stopping rules all key off class === 'hard'. A hard code that is
    // also retryable would defeat them silently, so this is load-bearing.
    for (const c of tax.codes) {
      if (c.class === 'hard') {
        expect(c.retryable, `${c.code}`).toBe(false);
        expect(c.remedy, `${c.code}`).toBe('none');
      }
    }
  });

  it('gives every code at least one rail that can produce it', () => {
    for (const c of tax.codes) expect(c.rails.length, c.code).toBeGreaterThan(0);
  });

  it('gives every rail at least one hard and one soft code', () => {
    for (const rail of ['upi_autopay', 'enach', 'card_on_file'] as const) {
      const forRail = idx.forRail(rail);
      expect(forRail.some((c) => c.class === 'hard'), rail).toBe(true);
      expect(forRail.some((c) => c.class === 'soft'), rail).toBe(true);
    }
  });

  it('documents what each code is modeled on', () => {
    // Guards the honesty note: these codes are ours, and every one of them has
    // to say which real-world category it is imitating.
    for (const c of tax.codes) expect(c.modeled_on.length, c.code).toBeGreaterThan(3);
  });
});

describe('failure mixes', () => {
  const mixes = loadMixes();
  const tax = loadTaxonomy();
  const codes = new Set(tax.codes.map((c) => c.code));

  it('has a default that exists', () => {
    expect(mixes.mixes[mixes.default_mix]).toBeDefined();
  });

  it('has at least three mixes, so sensitivity is reportable', () => {
    expect(Object.keys(mixes.mixes).length).toBeGreaterThanOrEqual(3);
  });

  for (const [name, mix] of Object.entries(mixes.mixes)) {
    describe(name, () => {
      it('sums to exactly 1', () => {
        const total = Object.values(mix.weights).reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(1, 9);
      });

      it('covers every taxonomy code and invents none', () => {
        const keys = new Set(Object.keys(mix.weights));
        expect([...codes].filter((c) => !keys.has(c))).toEqual([]);
        expect([...keys].filter((k) => !codes.has(k))).toEqual([]);
      });

      it('leaves some value structurally unrecoverable', () => {
        // A mix with no hard failures would let any policy approach 100% and
        // would make the recoverable-ceiling number meaningless.
        const hardShare = tax.codes
          .filter((c) => c.class === 'hard')
          .reduce((a, c) => a + (mix.weights[c.code] ?? 0), 0);
        expect(hardShare).toBeGreaterThan(0.02);
      });
    });
  }
});

describe('rules registry', () => {
  const registry = new RuleRegistry(loadRules());

  it('parses with unique ids', () => {
    const ids = registry.all().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('throws on an unknown rule id', () => {
    expect(() => registry.require('NO_SUCH_RULE')).toThrow(/unknown rule_id/);
  });

  it('explains every rule whose parameter we invented', () => {
    for (const r of registry.unverified()) {
      expect(r.verification.note.length, r.id).toBeGreaterThan(20);
    }
  });

  it('backs every verified rule with a source or an explicit definitional note', () => {
    for (const r of registry.all()) {
      if (r.verification.status !== 'verified') continue;
      const hasSource = r.verification.source_url !== null;
      const isDefinitional = /definitional|follows from|design decision|scope decision/i.test(
        r.verification.note,
      );
      expect(hasSource || isDefinitional, `${r.id}: ${r.verification.note}`).toBe(true);
    }
  });

  it('covers every rule kind', () => {
    for (const kind of ['eligibility', 'compliance', 'rate_limit', 'stop', 'authority'] as const) {
      expect(registry.byKind(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('names the stops the demo depends on', () => {
    // These four are the ones the video walks through. If any is renamed, the
    // policy engine and the script go out of sync, so pin them here.
    for (const id of [
      'STOP_ON_SETTLED',
      'STOP_ON_HARD_DECLINE',
      'STOP_ON_DISPUTE',
      'STOP_ON_CANCELLATION',
    ]) {
      expect(registry.require(id).kind).toBe('stop');
      expect(registry.require(id).harm_metric, id).toBe(true);
    }
  });

  it('treats every authority bound as critical or high', () => {
    for (const r of registry.byKind('authority')) {
      expect(['critical', 'high'], r.id).toContain(r.severity);
    }
  });
});
