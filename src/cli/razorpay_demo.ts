import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../domain/env.js';
import { formatINR, paise } from '../domain/money.js';
import { RESULTS_DIR } from '../domain/paths.js';
import {
  RazorpayApiError,
  RazorpayClient,
  loadCredentials,
  redact,
} from '../razorpay/client.js';
import {
  adapterCoverage,
  classifyFailure,
  createOrder,
  createRecoveryLink,
  fetchPaymentLink,
} from '../razorpay/adapter.js';

/**
 * Run the agent's gateway-facing actions against Razorpay test mode, once, and
 * commit the transcript.
 *
 * Nothing in `npm run eval` touches this. The point is to show that
 * `send_payment_link` is a real call with a real response, and to be specific
 * about which other actions could not be demonstrated and why.
 */

async function main(): Promise<void> {
  loadEnv();
  const creds = loadCredentials();
  const client = new RazorpayClient(creds);
  const notes: string[] = [];

  console.log(`\nRazorpay test-mode adapter demo`);
  console.log(`key ${creds.key_id.slice(0, 13)}...\n`);

  // ---- 1. the action the agent actually chose 260 times on the main batch
  const amount = paise(1_936_913);
  const link = await createRecoveryLink(client, {
    amount_paise: amount,
    description: 'Recovery of failed invoice INV-00005',
    customer: { name: 'Asha Menon', email: 'asha.menon@example.com', contact: '+919812345678' },
    reference_id: `ploutos-INV-00005-${Date.now()}`,
    expires_at: new Date(Date.now() + 7 * 86_400_000),
  });
  console.log(`  send_payment_link  -> ${link.id}  ${formatINR(amount)}  status=${link.status}`);
  console.log(`                        ${link.short_url}`);

  const fetched = await fetchPaymentLink(client, link.id);
  console.log(`  fetch link         -> status=${fetched.status}  amount_paid=${fetched.amount_paid}`);

  // ---- 2. the gateway-side record a presentment is made against
  const order = await createOrder(client, {
    amount_paise: amount,
    receipt: `ploutos-INV-00005-${Date.now()}`,
  });
  console.log(`  create order       -> ${order.id}  status=${order.status}`);

  // ---- 3. the part that could not be demonstrated, recorded as a failure
  try {
    await client.request('POST', '/plans', {
      period: 'monthly',
      interval: 1,
      item: { name: 'Ploutos mandate probe', amount: 14900, currency: 'INR' },
    });
    notes.push('Subscriptions IS enabled on this account; the mandate path can be wired up.');
  } catch (err) {
    if (err instanceof RazorpayApiError) {
      console.log(`  create plan        -> ${err.status}  ${err.message}`);
      notes.push(
        `POST /v1/plans returned ${err.status} (${err.message}). Razorpay Subscriptions is ` +
          'a separately-enabled product and this test account does not have it, so the ' +
          'mandate actions (retry_debit, request_afa, serve_predebit_notice) have no ' +
          'live counterpart here. They are marked unavailable rather than mocked.',
      );
    } else throw err;
  }

  // ---- what maps to what
  const coverage = adapterCoverage();
  const live = Object.entries(coverage).filter(([, v]) => v === 'live').map(([k]) => k);
  const unavailable = Object.entries(coverage).filter(([, v]) => v === 'unavailable').map(([k]) => k);
  console.log(`\n  live: ${live.join(', ')}`);
  console.log(`  unavailable on this account: ${unavailable.join(', ')}`);

  const out = {
    recorded_at: new Date().toISOString(),
    mode: 'test',
    note:
      'Every request and response below is real, against Razorpay test mode. ' +
      'Credentials are redacted. Nothing in npm run eval calls any of this.',
    coverage,
    caveats: notes,
    // classifyFailure is exercised against the envelope shape rather than a
    // live failure, because producing one needs a browser checkout flow.
    failure_classification_examples: [
      classifyFailure({
        code: 'BAD_REQUEST_ERROR',
        description: 'Payment failed at authentication',
        source: 'customer',
        step: 'payment_authentication',
        reason: 'incorrect_otp',
      }),
      classifyFailure({
        code: 'GATEWAY_ERROR',
        description: 'Payment processing failed at the bank',
        source: 'issuer_bank',
        step: 'payment_authorization',
        reason: 'payment_failed',
      }),
      classifyFailure({
        code: 'BAD_REQUEST_ERROR',
        description: 'Payment failed',
        source: 'customer',
        step: 'payment_authorization',
        reason: 'payment_failed',
      }),
    ],
    transcript: client.transcript,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, 'razorpay-transcript.json');
  writeFileSync(file, JSON.stringify(redact(out, creds), null, 2) + '\n');
  console.log(`\n  wrote ${file}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
