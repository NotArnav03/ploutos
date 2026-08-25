import type { IssuerHealth } from '../domain/schemas.js';
import { epochMs, type Timestamp } from '../domain/time.js';

/**
 * Fleet-level issuer degradation, computed from the merchant's OWN decline
 * stream. This is the "payment degradation to root cause" example direction,
 * folded in as an input to retry timing rather than shipped as a standalone
 * deliverable that diagnoses without recovering anything.
 *
 * It is observable by construction: every data point is a presentment this
 * merchant made and a response they received. No latent schedule is read. The
 * agent sees a bank looking unwell exactly when a real merchant would - after
 * enough of their own debits have failed to make it visible.
 *
 * That "after enough" is the interesting part. A single failure carries almost
 * no information; the same failure across nineteen unrelated accounts at one
 * bank within an hour is a strong signal to wait rather than re-present.
 */

interface Observation {
  ts_ms: number;
  failed: boolean;
}

const DEFAULT_WINDOW_HOURS = 6;
const BASELINE_WINDOW_HOURS = 24 * 14;
/** Below this many attempts in the window, we report nothing rather than noise. */
const MIN_ATTEMPTS = 8;
/** Failure rate must exceed baseline by this much to count as degraded. */
const DEGRADED_MARGIN = 0.25;

export class IssuerHealthTracker {
  private readonly byIssuer = new Map<string, Observation[]>();

  record(issuer: string, ts: Timestamp, failed: boolean): void {
    let list = this.byIssuer.get(issuer);
    if (!list) {
      list = [];
      this.byIssuer.set(issuer, list);
    }
    list.push({ ts_ms: epochMs(ts), failed });
  }

  /**
   * Health for one issuer as of `now`. Returns null when there is too little
   * evidence, which the agent is expected to treat as "no signal" rather than
   * "healthy" - the distinction matters for a small issuer with few accounts.
   */
  health(issuer: string, now: Timestamp, windowHours = DEFAULT_WINDOW_HOURS): IssuerHealth | null {
    const list = this.byIssuer.get(issuer);
    if (!list) return null;

    const nowMs = epochMs(now);
    const windowStart = nowMs - windowHours * 3_600_000;
    const baselineStart = nowMs - BASELINE_WINDOW_HOURS * 3_600_000;

    let attempts = 0;
    let failures = 0;
    let baseAttempts = 0;
    let baseFailures = 0;

    for (const o of list) {
      if (o.ts_ms > nowMs) continue; // never read the future
      if (o.ts_ms >= baselineStart) {
        baseAttempts++;
        if (o.failed) baseFailures++;
      }
      if (o.ts_ms >= windowStart) {
        attempts++;
        if (o.failed) failures++;
      }
    }

    if (attempts < MIN_ATTEMPTS) return null;

    const rate = failures / attempts;
    const baseline = baseAttempts > 0 ? baseFailures / baseAttempts : rate;

    return {
      issuer,
      window_hours: windowHours,
      attempts,
      failures,
      failure_rate: rate,
      baseline_failure_rate: baseline,
      degraded: rate - baseline > DEGRADED_MARGIN && rate > 0.4,
    };
  }
}
