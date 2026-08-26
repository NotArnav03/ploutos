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
/** Below this many attempts in the window, we report nothing rather than noise. */
const MIN_ATTEMPTS = 8;
/** Failure rate must exceed the peer baseline by this much to count as degraded. */
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
   *
   * WHY THE BASELINE IS OTHER ISSUERS AND NOT THIS ISSUER'S OWN HISTORY
   *
   * The first version compared an issuer's failure rate in the last 6 hours
   * against its own rate over the trailing fortnight, which is the textbook
   * construction and is wrong here. The only presentments this tracker ever
   * sees are the ones in a RECOVERY queue, and a recovery queue is made
   * entirely of failures by definition. So the trailing baseline sat at ~100%
   * for every issuer, no issuer could ever exceed it, and `degraded` was a flag
   * that could not fire. Measured on the 500-case main batch: 62 observations
   * with enough traffic to report, zero degraded, ever.
   *
   * Comparing against the other issuers in the same window fixes it, and is
   * also the comparison a merchant actually makes. "Everything is failing right
   * now" is a queue; "ISSUER_04 is failing while the other nine are not" is a
   * bank having a bad afternoon, and that is the one worth waiting out.
   */
  health(issuer: string, now: Timestamp, windowHours = DEFAULT_WINDOW_HOURS): IssuerHealth | null {
    if (!this.byIssuer.has(issuer)) return null;

    const nowMs = epochMs(now);
    const windowStart = nowMs - windowHours * 3_600_000;

    let attempts = 0;
    let failures = 0;
    let peerAttempts = 0;
    let peerFailures = 0;

    for (const [name, list] of this.byIssuer) {
      const own = name === issuer;
      for (const o of list) {
        // Never read the future. `record` is called with simulation time from
        // cases that wake in a different order than they are stored, so the
        // lists are not sorted and this cannot be a break.
        if (o.ts_ms > nowMs || o.ts_ms < windowStart) continue;
        if (own) {
          attempts++;
          if (o.failed) failures++;
        } else {
          peerAttempts++;
          if (o.failed) peerFailures++;
        }
      }
    }

    if (attempts < MIN_ATTEMPTS) return null;

    const rate = failures / attempts;
    // With too few peer presentments there is no comparison to make, so the
    // baseline collapses to this issuer's own rate and `degraded` stays false.
    // Reporting a degradation off a two-attempt peer sample would be noise
    // dressed up as a signal.
    const havePeers = peerAttempts >= MIN_ATTEMPTS;
    const baseline = havePeers ? peerFailures / peerAttempts : rate;

    return {
      issuer,
      window_hours: windowHours,
      attempts,
      failures,
      failure_rate: rate,
      baseline_failure_rate: baseline,
      degraded: havePeers && rate - baseline > DEGRADED_MARGIN && rate > 0.4,
    };
  }
}
