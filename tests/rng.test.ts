import { describe, expect, it } from 'vitest';
import { Rng, STREAM } from '../src/world/rng.js';

describe('seeded rng', () => {
  it('is reproducible for the same stream address', () => {
    const a = Rng.stream(42, 'SUB-0001', STREAM.latent);
    const b = Rng.stream(42, 'SUB-0001', STREAM.latent);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('diverges on a different seed', () => {
    const a = Rng.stream(42, 'SUB-0001', STREAM.latent).next();
    const b = Rng.stream(43, 'SUB-0001', STREAM.latent).next();
    expect(a).not.toBe(b);
  });

  it('diverges across entities and across purposes', () => {
    const e1 = Rng.stream(42, 'SUB-0001', STREAM.latent).next();
    const e2 = Rng.stream(42, 'SUB-0002', STREAM.latent).next();
    const p1 = Rng.stream(42, 'SUB-0001', STREAM.invoice).next();
    expect(new Set([e1, e2, p1]).size).toBe(3);
  });

  it('does not collide when id parts are concatenated differently', () => {
    const a = Rng.stream(1, 'a', 'bc').next();
    const b = Rng.stream(1, 'ab', 'c').next();
    expect(a).not.toBe(b);
  });
});

describe('substream independence', () => {
  it('keeps one stream stable when another takes more draws', () => {
    // This is the reason this module exists. With a single global generator,
    // adding one draw on day 7 shifts every later draw, so introducing a new
    // customer attribute silently reshuffles all 500 cases and invalidates
    // every comparison made on days 3-6. The seed is unchanged and the run is
    // still deterministic - it is simply a different world, which is worse
    // than an obvious break.
    const before = Rng.stream(7, 'SUB-0400', STREAM.outcome);
    const baseline = Array.from({ length: 5 }, () => before.next());

    // Simulate a later change: some other stream now takes 100 extra draws.
    const unrelated = Rng.stream(7, 'SUB-0399', STREAM.latent);
    for (let i = 0; i < 100; i++) unrelated.next();

    const after = Rng.stream(7, 'SUB-0400', STREAM.outcome);
    const recomputed = Array.from({ length: 5 }, () => after.next());

    expect(recomputed).toEqual(baseline);
  });

  it('lets a single case be regenerated in isolation', () => {
    const full = Array.from({ length: 10 }, (_, i) =>
      Rng.stream(9, `SUB-${i}`, STREAM.latent).int(1, 28),
    );
    const justCase5 = Rng.stream(9, 'SUB-5', STREAM.latent).int(1, 28);
    expect(justCase5).toBe(full[5]);
  });
});

describe('distributions', () => {
  it('produces integers inside the requested range', () => {
    const r = Rng.stream(1, 'x', STREAM.customer);
    for (let i = 0; i < 2000; i++) {
      const v = r.int(1, 28);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(28);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('covers both ends of an inclusive range', () => {
    const r = Rng.stream(2, 'x', STREAM.customer);
    const seen = new Set(Array.from({ length: 500 }, () => r.int(1, 5)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects an inverted range instead of returning nonsense', () => {
    expect(() => Rng.stream(1, 'x', STREAM.customer).int(5, 1)).toThrow(/empty range/);
  });

  it('respects weights within sampling error', () => {
    const r = Rng.stream(3, 'x', STREAM.failureCode);
    const counts = { a: 0, b: 0, c: 0 };
    const n = 30_000;
    for (let i = 0; i < n; i++) {
      counts[
        r.weighted([
          ['a', 0.6],
          ['b', 0.3],
          ['c', 0.1],
        ] as const)
      ]++;
    }
    expect(counts.a / n).toBeCloseTo(0.6, 1);
    expect(counts.b / n).toBeCloseTo(0.3, 1);
    expect(counts.c / n).toBeCloseTo(0.1, 1);
  });

  it('normalises weights that do not sum to one', () => {
    // The generator drops rail-incompatible failure codes and reuses the
    // remaining mix weights, so this path is load-bearing.
    const r = Rng.stream(4, 'x', STREAM.failureCode);
    let a = 0;
    for (let i = 0; i < 10_000; i++) {
      if (r.weighted([['a', 3] as const, ['b', 1] as const]) === 'a') a++;
    }
    expect(a / 10_000).toBeCloseTo(0.75, 1);
  });

  it('shuffles deterministically without mutating the input', () => {
    const input = [1, 2, 3, 4, 5];
    const out1 = Rng.stream(5, 'x', STREAM.invoice).shuffled(input);
    const out2 = Rng.stream(5, 'x', STREAM.invoice).shuffled(input);
    expect(out1).toEqual(out2);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...out1].sort()).toEqual(input);
  });

  it('clamps a normal draw into range', () => {
    const r = Rng.stream(6, 'x', STREAM.responsiveness);
    for (let i = 0; i < 1000; i++) {
      const v = r.normalInt(500, 400, 1, 1000);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });
});
