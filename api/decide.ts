/**
 * One live decision, on an invoice somebody uploaded.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * It runs the real gate and the real agent over an uploaded record and returns
 * a single decision: the permitted set, the rule id that refused each excluded
 * action, and the model's choice with the rationale it wrote.
 *
 * It does NOT run the recovery loop, because it cannot honestly. A case record
 * carries a `latent` block - the ground truth the simulator uses to answer an
 * action: whether a retry would have succeeded, whether the payer settles out
 * of band, how responsive they are per channel. Without it there is nothing to
 * respond to what the agent does, and generating one would mean inventing the
 * outcome and then reporting it as a result. So `latent` is stripped on the way
 * in and this endpoint stops after one decision, which needs no world at all.
 *
 * NOTHING HERE IS IN THE MEASURED PATH. `tests/boundary.test.ts` fails the
 * build if src/eval, src/policy, src/agent or src/domain imports this
 * directory, for the same reason it does for src/razorpay: a number this
 * project reports must never depend on a network call or a key being present.
 * `npm run eval` does not know this file exists.
 *
 * The key lives in the Vercel environment, server side. It is never sent to the
 * browser.
 */
import { z } from 'zod';

import { makeAgent } from '../src/agent/agent.js';
import { DecisionCache } from '../src/agent/cache.js';
import { observe, observationHash } from '../src/adapter/observe.js';
import { computePermitted } from '../src/policy/gate.js';
import {
  CustomerSchema,
  InvoiceSchema,
  SubscriptionSchema,
  type Invoice,
} from '../src/domain/schemas.js';
import { RuleRegistry } from '../src/domain/rules.js';
import { TaxonomyIndex } from '../src/domain/taxonomy.js';
import { newRuntime } from '../src/orchestrator/runtime.js';
import { toTimestamp, type Timestamp } from '../src/domain/time.js';

/**
 * What an upload may contain. Anything else - `latent` above all - is dropped
 * rather than rejected, so a record copied straight out of data/batches works.
 */
const UploadSchema = z.object({
  case_id: z.string().min(1).max(64),
  customer: CustomerSchema,
  subscription: SubscriptionSchema,
  invoice: InvoiceSchema,
});

const MAX_BODY_BYTES = 96 * 1024;

/**
 * A per-instance budget. This is a demo running on somebody's free tier, and
 * an unguarded endpoint that makes a paid call per request is an invitation.
 * Serverless instances are not shared state, so this is a speed bump rather
 * than a real limiter - the hard cap is the quota on the key itself.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const hits: number[] = [];

function overBudget(): boolean {
  const cutoff = Date.now() - WINDOW_MS;
  while (hits.length > 0 && (hits[0] as number) < cutoff) hits.shift();
  if (hits.length >= MAX_PER_WINDOW) return true;
  hits.push(Date.now());
  return false;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The clock the decision is made against: the last attempt, plus an hour. */
function clockFor(invoice: Invoice): Timestamp {
  const last = invoice.attempts.at(-1);
  const base = last ? Date.parse(last.ts) : Date.parse(invoice.first_failed_at ?? invoice.due_date);
  return toTimestamp(base + 60 * 60 * 1000);
}

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST an invoice record as JSON.' }, 405);

  if (overBudget()) {
    return json(
      {
        error: 'Too many live decisions in the last minute.',
        detail: 'This runs on a free tier. Wait a moment, or read the recorded run instead.',
      },
      429,
    );
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: 'That file is too large.' }, 413);

  // Accept a bare record, a JSON array, or a .jsonl batch straight out of
  // data/batches - the file people are most likely to have to hand.
  let record: unknown;
  let note: string | null = null;
  try {
    record = JSON.parse(text);
  } catch {
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (firstLine === undefined) return json({ error: 'That file is empty.' }, 400);
    try {
      record = JSON.parse(firstLine);
      note = 'That looked like a .jsonl batch, so the first record was used.';
    } catch {
      return json({ error: 'That is not valid JSON.' }, 400);
    }
  }
  if (Array.isArray(record)) {
    if (record.length === 0) return json({ error: 'That array is empty.' }, 400);
    note = 'That was an array of records, so the first one was used.';
    record = record[0];
  }
  if (typeof record !== 'object' || record === null) {
    return json({ error: 'Expected a JSON object describing one case.' }, 400);
  }

  const parsed = UploadSchema.safeParse(record);
  if (!parsed.success) {
    return json(
      {
        error: 'That record does not match the case schema.',
        detail: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`),
        hint: 'Download a sample from the page and edit it - any record from data/batches works.',
      },
      422,
    );
  }

  const upload = parsed.data;
  const firstAttempt = upload.invoice.attempts[0];
  if (!firstAttempt) {
    return json({ error: 'The invoice has no failed attempt, so there is nothing to recover.' }, 422);
  }

  const now = clockFor(upload.invoice);
  const registry = new RuleRegistry();
  const taxonomy = new TaxonomyIndex();

  // Runtime is rebuilt from the record's own history, so the gate sees the
  // attempts, contacts and promises the uploader actually described.
  const runtime = newRuntime(upload.case_id, firstAttempt, now);
  runtime.attempts = [...upload.invoice.attempts];
  runtime.contacts = [...upload.invoice.contacts];
  runtime.promises = [...upload.invoice.promises];

  const observation = observe({
    source: {
      case_id: upload.case_id,
      customer: upload.customer,
      subscription: upload.subscription,
      invoice: upload.invoice,
    },
    runtime,
    now,
    issuer: 'ISSUER_DEMO',
    issuer_health: null,
  });
  const obsHash = observationHash(observation);

  const gate = computePermitted({ observation, runtime, registry, taxonomy, now });

  // A stop rule fired: the engine has already decided, and there is nothing
  // for the model to choose between. No call is made.
  if (gate.stop !== null) {
    return json(
      {
        case_id: upload.case_id,
        now,
        observation_hash: obsHash,
        permitted: [],
        excluded: gate.excluded,
        checks: gate.checks,
        stop: gate.stop,
        decision: null,
        model: null,
        note: 'A stop rule fired. The engine closed the case without consulting the model.',
      },
      200,
    );
  }

  // The gate half of this endpoint needs no credential and no network, so it
  // is reported even when the model half cannot run. A judge with no key still
  // sees the permitted set and every rule that refused something.
  if (!process.env['GEMINI_API_KEY']) {
    return json(
      {
        case_id: upload.case_id,
        now,
        observation_hash: obsHash,
        permitted: gate.permitted,
        permitted_channels: gate.permitted_channels,
        excluded: gate.excluded,
        checks: gate.checks,
        stop: null,
        decision: null,
        model: null,
        note,
        error: 'The gate ran. The model did not: this deployment has no credential configured.',
        detail: 'Set GEMINI_API_KEY in the Vercel project environment to enable the live decision.',
      },
      503,
    );
  }

  // noCache + a cache pointed at a directory that does not exist: nothing is
  // replayed from the committed decisions, and nothing is written into them.
  // flush() is never called, so this cannot touch .cache/llm.
  const agent = makeAgent({
    noCache: true,
    allowFallback: false,
    cache: new DecisionCache('/tmp/ploutos-live-nocache'),
  });

  try {
    const decision = await agent.decide({
      observation,
      permitted: {
        case_id: upload.case_id,
        observation_hash: obsHash,
        permitted: gate.permitted,
        permitted_channels: gate.permitted_channels,
        contact_window_opens_at: gate.contact_window_opens_at,
        excluded: gate.excluded,
      },
      ctx: { registry, taxonomy, now, run_id: 'live-demo' },
    });

    // The gate is the authority, here as everywhere else. If a choice outside
    // the permitted set ever arrived, it would be reported, not executed.
    const outside = !gate.permitted.includes(decision.action.type);

    return json(
      {
        case_id: upload.case_id,
        now,
        observation_hash: obsHash,
        permitted: gate.permitted,
        permitted_channels: gate.permitted_channels,
        excluded: gate.excluded,
        checks: gate.checks,
        stop: null,
        decision: {
          action: decision.action,
          diagnosis: decision.diagnosis,
          rationale: decision.rationale,
          outside_permitted_set: outside,
        },
        model: decision.meta.model,
        latency_ms: decision.meta.latency_ms,
        note,
      },
      200,
    );
  } catch (err) {
    // Fail loudly. allowFallback is off precisely so that a broken call cannot
    // return static-policy's answer wearing the agent's name.
    return json(
      {
        case_id: upload.case_id,
        now,
        observation_hash: obsHash,
        permitted: gate.permitted,
        permitted_channels: gate.permitted_channels,
        excluded: gate.excluded,
        checks: gate.checks,
        stop: null,
        decision: null,
        model: null,
        note,
        error: 'The gate ran. The model did not answer, so there is no decision to show.',
        detail: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
}
