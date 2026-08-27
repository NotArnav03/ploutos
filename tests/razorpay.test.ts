import { describe, expect, it } from 'vitest';
import { redact, type RazorpayCredentials } from '../src/razorpay/client.js';
import { adapterCoverage, classifyFailure } from '../src/razorpay/adapter.js';
import { ACTION_TYPES } from '../src/domain/actions.js';

/**
 * Assembled from fragments rather than written as a literal.
 *
 * A key-shaped string in source trips GitHub push protection and every other
 * secret scanner, and the moment to discover that is not while pushing a
 * submission. Nothing here is or ever was a real credential.
 */
const creds: RazorpayCredentials = {
  key_id: ['rzp', 'test', 'FIXTURE_NOT_A_KEY'].join('_'),
  key_secret: ['fixture', 'not', 'a', 'real', 'secret'].join('-'),
};

describe('transcript redaction', () => {
  it('removes the secret wherever it appears, including nested', () => {
    // The transcript is committed to the repository, so "the gateway probably
    // never echoes a key back" is not a good enough reason to skip this.
    const dirty = {
      request: { auth: `Basic ${Buffer.from('x:y').toString('base64')}` },
      nested: [{ leaked: creds.key_secret }],
      id: creds.key_id,
    };
    const clean = JSON.stringify(redact(dirty, creds));
    expect(clean).not.toContain(creds.key_secret);
    expect(clean).not.toContain(creds.key_id);
    expect(clean).toContain('<REDACTED_KEY_SECRET>');
  });

  it('leaves ordinary object ids alone', () => {
    // plink_ and order_ ids are test-mode object references, not credentials,
    // and redacting them would make the transcript useless as evidence.
    const clean = redact({ id: 'plink_TESTLINK123', order: 'order_TESTORDER1' }, creds);
    expect(clean.id).toBe('plink_TESTLINK123');
    expect(clean.order).toBe('order_TESTORDER1');
  });
});

describe('failure classification', () => {
  it('maps what the error envelope states structurally', () => {
    expect(
      classifyFailure({
        code: 'BAD_REQUEST_ERROR',
        description: 'x',
        source: 'customer',
        step: 'payment_authentication',
        reason: 'incorrect_otp',
      }).taxonomy_code,
    ).toBe('AFA_REQUIRED');

    expect(
      classifyFailure({
        code: 'GATEWAY_ERROR',
        description: 'x',
        source: 'gateway',
        step: 'payment_authorization',
        reason: 'payment_failed',
      }).taxonomy_code,
    ).toBe('PSP_DOWN');
  });

  it('returns null rather than guessing at an unpublished reason string', () => {
    // Razorpay publishes the complete reason list only as a spreadsheet linked
    // from its docs. A mapping table built by guessing at those strings would
    // look authoritative and be fiction, so an unmapped reason stays unmapped
    // and carries the raw value through.
    const r = classifyFailure({
      code: 'BAD_REQUEST_ERROR',
      description: 'Payment failed',
      source: 'customer',
      step: 'payment_authorization',
      reason: 'some_reason_we_did_not_verify',
    });
    expect(r.taxonomy_code).toBeNull();
    expect(r.confidence).toBe('unmapped');
    expect(r.raw_reason).toBe('some_reason_we_did_not_verify');
  });
});

describe('adapter coverage', () => {
  it('accounts for every action type, so nothing is silently unmapped', () => {
    const coverage = adapterCoverage();
    for (const t of ACTION_TYPES) {
      expect(coverage[t], `${t} has no coverage entry`).toBeDefined();
    }
    expect(Object.keys(coverage).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('claims live coverage only for the action that was actually exercised', () => {
    const live = Object.entries(adapterCoverage())
      .filter(([, v]) => v === 'live')
      .map(([k]) => k);
    // Subscriptions is not enabled on the test account, so the mandate actions
    // have no live counterpart. Marking them unavailable is the honest state;
    // mocking them would be a demo of nothing.
    expect(live).toEqual(['send_payment_link']);
  });
});
