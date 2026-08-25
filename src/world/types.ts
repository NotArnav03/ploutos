import type { Customer, Invoice, Subscription } from '../domain/schemas.js';
import type { Timestamp } from '../domain/time.js';
import type { IssuerSchedule, LatentState } from './latent.js';

/**
 * A generated case: the observable records, plus the ground truth that explains
 * them. The adapter strips `latent` and `archetype` before anything in the
 * decision path sees it.
 */
export interface WorldCase {
  case_id: string;
  customer: Customer;
  subscription: Subscription;
  /** Carries the day-0 failed presentment already recorded. */
  invoice: Invoice;
  latent: LatentState;
  /** The root cause this case was drawn to exhibit. Ground truth. */
  archetype: ArchetypeId;
  /** Set when the case is one of the hand-shaped edge cases. */
  adversarial: AdversarialKind | null;
}

export interface World {
  meta: {
    seed: number;
    mix: string;
    size: number;
    /** Sim clock at batch start. Everything is relative to this. */
    start_ts: Timestamp;
    horizon_days: number;
    generator_version: string;
  };
  issuers: IssuerSchedule[];
  cases: WorldCase[];
}

/**
 * Root causes. Each maps to the failure code it produces on the first
 * presentment, but the mapping is not the mechanism: the generator builds
 * latent state consistent with the archetype, and the simulator then DERIVES
 * the code from that state at presentment time.
 *
 * The direction matters. Stamping a code onto a case and having the simulator
 * read it back would make the simulator a lookup table, and any apparent
 * diagnostic skill in the agent would be it recovering a label we planted. With
 * causal generation, a case drawn as INSUFFICIENT_FUNDS can fail its second
 * presentment with ISSUER_UNAVAILABLE if that issuer happens to be degraded
 * that day - which is both realistic and impossible to memorise.
 */
export const ARCHETYPES = [
  'salary_timing',
  'chronic_shortfall',
  'issuer_flaky',
  'switch_timeout',
  'limit_capped',
  'risk_flagged',
  'card_expired',
  'cap_breached',
  'notice_missing',
  'afa_needed',
  'psp_outage',
  'mandate_revoked',
  'account_closed',
  'card_blocked',
  'disputing',
] as const;
export type ArchetypeId = (typeof ARCHETYPES)[number];

/**
 * Which failure code each archetype is expected to produce on presentment one.
 * Used by the generator only as a consistency assertion, never by the
 * simulator: tests/world.test.ts checks that the simulator independently
 * derives this code from the latent state, which is what proves the causal
 * chain is real rather than decorative.
 */
export const ARCHETYPE_EXPECTED_CODE: Record<ArchetypeId, string> = {
  salary_timing: 'INSUFFICIENT_FUNDS',
  chronic_shortfall: 'INSUFFICIENT_FUNDS',
  issuer_flaky: 'ISSUER_UNAVAILABLE',
  switch_timeout: 'TXN_TIMEOUT',
  limit_capped: 'LIMIT_EXCEEDED',
  risk_flagged: 'RISK_HOLD',
  card_expired: 'INSTRUMENT_EXPIRED',
  cap_breached: 'MANDATE_CAP_EXCEEDED',
  notice_missing: 'PREDEBIT_NOTICE_MISSING',
  afa_needed: 'AFA_REQUIRED',
  psp_outage: 'PSP_DOWN',
  mandate_revoked: 'MANDATE_REVOKED',
  account_closed: 'ACCOUNT_CLOSED',
  card_blocked: 'INSTRUMENT_BLOCKED',
  disputing: 'CUSTOMER_DISPUTE',
};

/** Reverse map, for drawing an archetype from a failure-mix weight table. */
export const CODE_TO_ARCHETYPES: Record<string, ArchetypeId[]> = (() => {
  const out: Record<string, ArchetypeId[]> = {};
  for (const a of ARCHETYPES) {
    const code = ARCHETYPE_EXPECTED_CODE[a];
    (out[code] ??= []).push(a);
  }
  return out;
})();

/**
 * Hand-shaped edge cases. Roughly 5% of a batch, and worth more than the other
 * 95% put together: each one is a situation where a plausible recovery policy
 * does something a merchant would be embarrassed by.
 */
export const ADVERSARIAL_KINDS = [
  /** Payer settles by bank transfer mid-dunning. A retry here is a double charge. */
  'out_of_band_payment',
  /** Payer asks to cancel partway up the ladder. Everything must stop. */
  'cancellation_mid_ladder',
  /** DND on sms, consent on email. Channel choice is constrained, not blocked. */
  'dnd_split_consent',
  /** Invoice sits just above the AFA threshold. Cannot be silently re-presented. */
  'afa_threshold_edge',
  /** Mandate expires inside the retry window. Late retries are invalid. */
  'mandate_expiring',
  /** The same failure event arrives twice. Must not act twice. */
  'duplicate_event',
  /** High-LTV payer, fourth consecutive failure. Tests over-contact restraint. */
  'high_ltv_repeat_failure',
] as const;
export type AdversarialKind = (typeof ADVERSARIAL_KINDS)[number];
