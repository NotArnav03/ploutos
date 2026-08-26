import { describe, expect, it } from 'vitest';
import { IssuerHealthTracker } from '../src/adapter/issuer_health.js';
import { addHours, toTimestamp, type Timestamp } from '../src/domain/time.js';

const T0 = toTimestamp('2026-08-01T00:00:00.000Z');

/** `n` presentments on `issuer`, the first `failures` of them declined. */
function load(t: IssuerHealthTracker, issuer: string, n: number, failures: number, from: Timestamp) {
  for (let i = 0; i < n; i++) {
    t.record(issuer, addHours(from, (i % 5) * 0.5), i < failures);
  }
}

describe('issuer health', () => {
  it('says nothing until it has seen enough traffic', () => {
    const t = new IssuerHealthTracker();
    load(t, 'ISSUER_01', 7, 7, T0);
    expect(t.health('ISSUER_01', addHours(T0, 3))).toBeNull();
  });

  it('reports an unknown issuer as null rather than as healthy', () => {
    const t = new IssuerHealthTracker();
    load(t, 'ISSUER_01', 20, 20, T0);
    // The distinction matters: "no data" and "fine" lead to different actions,
    // and a tracker that conflates them tells the agent to re-present into a
    // bank it has never observed.
    expect(t.health('ISSUER_09', addHours(T0, 3))).toBeNull();
  });

  it('flags an issuer that is failing while its peers are not', () => {
    const t = new IssuerHealthTracker();
    load(t, 'ISSUER_01', 12, 12, T0); // the sick one
    load(t, 'ISSUER_02', 20, 4, T0);
    load(t, 'ISSUER_03', 20, 4, T0);

    const h = t.health('ISSUER_01', addHours(T0, 3));
    expect(h).not.toBeNull();
    expect(h!.failure_rate).toBe(1);
    expect(h!.baseline_failure_rate).toBeCloseTo(0.2, 5);
    expect(h!.degraded).toBe(true);

    // ...and its healthy peers are not swept up with it.
    expect(t.health('ISSUER_02', addHours(T0, 3))!.degraded).toBe(false);
  });

  it('cannot flag anything when every issuer is failing', () => {
    // This is the shape of a real recovery queue, and it is the reason the
    // prompt no longer renders a health clause by default. A queue built from
    // declines is 100% declines for every issuer in it, so there is no issuer
    // that stands out and `degraded` is correctly false for all of them.
    // Measured on the committed batches: 88,000 rendered prompts, every
    // reported failure_rate exactly 100%, zero degraded. See C-017.
    const t = new IssuerHealthTracker();
    for (const i of ['ISSUER_01', 'ISSUER_02', 'ISSUER_03']) load(t, i, 20, 20, T0);
    for (const i of ['ISSUER_01', 'ISSUER_02', 'ISSUER_03']) {
      const h = t.health(i, addHours(T0, 3))!;
      expect(h.failure_rate).toBe(1);
      expect(h.baseline_failure_rate).toBe(1);
      expect(h.degraded).toBe(false);
    }
  });

  it('will not call a degradation off a thin peer sample', () => {
    const t = new IssuerHealthTracker();
    load(t, 'ISSUER_01', 12, 12, T0);
    load(t, 'ISSUER_02', 3, 0, T0); // three data points is not a fleet
    const h = t.health('ISSUER_01', addHours(T0, 3))!;
    expect(h.degraded).toBe(false);
    expect(h.baseline_failure_rate).toBe(h.failure_rate);
  });

  it('never reads a presentment from the future', () => {
    const t = new IssuerHealthTracker();
    load(t, 'ISSUER_01', 20, 20, addHours(T0, 48));
    expect(t.health('ISSUER_01', addHours(T0, 3))).toBeNull();
  });
});
