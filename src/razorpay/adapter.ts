import type { Action } from '../domain/actions.js';
import { RazorpayClient, type RazorpayError } from './client.js';

/**
 * The bridge between an action this agent chose and a call on a real gateway.
 *
 * WHAT IS AND IS NOT DEMONSTRATED HERE
 *
 * `send_payment_link` maps onto Razorpay Payment Links exactly, and that path
 * is exercised live against test mode with the request and response committed
 * in `results/razorpay-transcript.json`.
 *
 * The mandate actions do NOT map to anything here, and the reason is worth
 * recording rather than hiding: Razorpay Subscriptions is a separately-enabled
 * product, and this test account does not have it. `POST /v1/plans` returns a
 * bare `{"error":"Unauthorized"}` rather than the structured envelope. So
 * `retry_debit` against a real e-mandate is not shown working, and this file
 * does not pretend otherwise.
 */

export interface PaymentLinkRequest {
  amount_paise: number;
  description: string;
  customer: { name: string; email: string; contact: string };
  reference_id: string;
  expires_at: Date;
}

export interface PaymentLink {
  id: string;
  short_url: string;
  status: string;
  amount: number;
  reference_id: string | null;
}

/**
 * Create the payment link an agent's `send_payment_link` action stands for.
 *
 * Notifications are switched off deliberately. The agent has already decided,
 * through the gate, whether this payer may be contacted at all and on which
 * channel — letting the gateway send its own SMS would put a contact outside
 * the ladder, uncounted by the goodwill model and unrecorded in the ledger.
 */
export async function createRecoveryLink(
  client: RazorpayClient,
  req: PaymentLinkRequest,
): Promise<PaymentLink> {
  return client.request<PaymentLink>('POST', '/payment_links', {
    amount: req.amount_paise,
    currency: 'INR',
    description: req.description,
    customer: req.customer,
    reference_id: req.reference_id,
    expire_by: Math.floor(req.expires_at.getTime() / 1000),
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { source: 'ploutos' },
  });
}

export async function fetchPaymentLink(
  client: RazorpayClient,
  id: string,
): Promise<PaymentLink & { amount_paid: number }> {
  return client.request('GET', `/payment_links/${id}`);
}

/** An order is the gateway-side record a presentment would be made against. */
export async function createOrder(
  client: RazorpayClient,
  args: { amount_paise: number; receipt: string },
): Promise<{ id: string; status: string; amount: number; receipt: string | null }> {
  return client.request('POST', '/orders', {
    amount: args.amount_paise,
    currency: 'INR',
    receipt: args.receipt,
    notes: { source: 'ploutos' },
  });
}

/**
 * What a Razorpay failure means in this project's vocabulary.
 *
 * WHY THIS RETURNS null SO OFTEN
 *
 * `config/failure_taxonomy.yaml` has fifteen codes. Razorpay's `reason` field
 * has many more, and the complete list is published only as a spreadsheet
 * linked from their docs — not as anything a build can consume or a reader can
 * check. Guessing the strings would produce a mapping table that looks
 * authoritative and is fiction.
 *
 * So this maps only what the error envelope states structurally — `step` and
 * `source` are documented and stable — and returns null for the rest, with the
 * raw reason preserved. An honest "unmapped, here is what the gateway said"
 * beats a confident wrong classification, and the same standard is applied to
 * the compliance parameters in `config/rules_registry.yaml`.
 */
export function classifyFailure(e: RazorpayError): {
  taxonomy_code: string | null;
  confidence: 'structural' | 'unmapped';
  raw_reason: string | null;
  note: string;
} {
  const reason = e.reason ?? null;

  // Documented and stable: a failure at the authentication step is the
  // additional-factor problem this project models as AFA_REQUIRED.
  if (e.step === 'payment_authentication') {
    return {
      taxonomy_code: 'AFA_REQUIRED',
      confidence: 'structural',
      raw_reason: reason,
      note: 'failed at the authentication step, which is what AFA_REQUIRED models',
    };
  }

  // Also documented: `source` identifies who failed. A gateway or issuer_bank
  // source is infrastructure rather than a decision about this payer.
  if (e.source === 'gateway' || e.source === 'issuer_bank') {
    return {
      taxonomy_code: e.source === 'gateway' ? 'PSP_DOWN' : 'ISSUER_UNAVAILABLE',
      confidence: 'structural',
      raw_reason: reason,
      note: `source=${e.source}, which is infrastructure rather than payer intent`,
    };
  }

  return {
    taxonomy_code: null,
    confidence: 'unmapped',
    raw_reason: reason,
    note:
      'no structural signal in the error envelope. Razorpay publishes the full ' +
      'reason list only as a spreadsheet, so mapping this string would be a guess.',
  };
}

/** Which of this project's actions have a real counterpart wired up. */
export function adapterCoverage(): Record<Action['type'], 'live' | 'unavailable' | 'not-applicable'> {
  return {
    send_payment_link: 'live',
    // Subscriptions is not enabled on the test account: POST /v1/plans is 401.
    retry_debit: 'unavailable',
    switch_rail: 'unavailable',
    serve_predebit_notice: 'unavailable',
    request_afa: 'unavailable',
    request_instrument_update: 'unavailable',
    grant_grace: 'unavailable',
    // These never leave the merchant's own systems.
    wait: 'not-applicable',
    notify_soft: 'not-applicable',
    capture_promise_to_pay: 'not-applicable',
    handoff_human: 'not-applicable',
    stop_terminal: 'not-applicable',
  };
}
