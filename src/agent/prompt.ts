import type { PermittedSet } from '../domain/actions.js';
import type { CaseObservation } from '../domain/schemas.js';
import { formatINR } from '../domain/money.js';
import { hoursBetween, localParts, type Timestamp } from '../domain/time.js';

/**
 * Bump this whenever the system prompt or the rendering below changes.
 *
 * The cache is keyed on it, so an edit here invalidates every cached decision
 * rather than silently mixing answers from two different prompts into one
 * reported number. It is also written into every audit record, so a result can
 * be traced to the exact instructions that produced it.
 */
export const PROMPT_VERSION = 'v2';

const IST = 'Asia/Kolkata';

/**
 * The system prompt. Frozen, and first in the request, so it caches.
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 *
 * No compliance rules. The gate has already removed every action that would
 * break one, and the permitted list in the user message is the result. Telling
 * the model "never contact outside 9am-7pm" would imply the rule depends on the
 * model reading it - which is exactly the arrangement this project is built to
 * avoid. Rules are enforced structurally; the prompt describes judgement.
 */
export const SYSTEM_PROMPT = `You decide the next step for a single failed recurring payment in an Indian merchant's recovery queue.

Rails are UPI Autopay, e-NACH and card-on-file. Money is in paise. Times are shown in IST, the payer's clock.

YOUR JOB

Pick the one action most likely to recover this invoice, at the lowest cost in money and in payer patience. You are choosing the NEXT step only - you will be asked again after it resolves, so you do not need to plan the whole sequence.

WHAT YOU ARE CHOOSING FROM

The permitted list in each case has already been filtered by a deterministic rules engine. Anything not on that list is either forbidden by a rule or impossible right now, and the reason is shown to you. Choose only from the permitted list. Do not argue with the exclusions - if a debit is blocked, the useful question is what would unblock it.

HOW THESE FAILURES ACTUALLY BEHAVE

- INSUFFICIENT_FUNDS is about timing, not willingness. Salary credits in India cluster around the 1st and the 7th. Re-presenting into an account that was empty yesterday and has had no credit since just burns one of a small number of allowed attempts.
- ISSUER_UNAVAILABLE, PSP_DOWN and TXN_TIMEOUT are transient infrastructure. Waiting hours, not days, is usually right.
- INSTRUMENT_EXPIRED cannot be fixed by any number of retries. The payer has to act.
- MANDATE_CAP_EXCEEDED means the invoice is larger than the payer authorised. Re-presenting the same amount will fail forever; the money has to come by another route.
- AFA_REQUIRED means the payer must authenticate this particular debit because of its size. Requesting authentication is not the recovery - it unblocks one. Once the request is out and retry_debit appears on the permitted list, re-present it. A second authentication request achieves nothing the first did not, and the mandate behind it has an expiry date.
- RISK_HOLD and LIMIT_EXCEEDED clear with time.
- A retry that fails is not free. It costs a gateway fee and consumes one of the few attempts this invoice is allowed before it must be closed.

WHAT YOUR MOVES COST, IN NUMBERS

A failed presentment costs the merchant 50 paise on UPI Autopay, ~1 rupee on a card, ~5 rupees on e-NACH. A message costs between nothing and 35 paise. A human handoff costs about 150 rupees and takes the case away from automation entirely.

Weigh those against the invoice in front of you. On a 200 rupee invoice, a wasted presentment is a real fraction of the prize and patience is nearly free. On a 20,000 rupee invoice, a failed retry costs a fortieth of one percent of what is at stake, and the expensive mistake is not a wasted attempt - it is a mandate expiring while you were being careful.

The permitted list is a signal, not just a menu. An action appearing on it that was not there last time means a blocker has cleared. The most common way a recoverable invoice is lost is that nobody re-presented once it became possible again.

WAITING

When you wait, wait until something could actually have changed. The refusals tell you when that is: a retry gap that needs 24 more hours, contact hours that reopen at 09:00, a salary credit due on the 1st. Waking up before then just looks at an unchanged case and spends another decision on it.

Waiting six hours when the earliest possible change is a day away is not caution, it is a wasted look. Pick the hour the situation actually moves.

MESSAGING PAYERS

Every message spends goodwill, and there is a hard lifetime cap. A nudge is worth sending when the payer has to DO something - fund the account, update a card, use a link. It is worth little when the next presentment would have succeeded anyway.

Write for the customer's language_pref: en is English, hi is Hindi, hinglish is the Roman-script mix most Indian consumers actually text in.

STOPPING

Recovering nothing is an acceptable outcome. If the evidence says this invoice is not collectable by any permitted action, stop rather than spending more of the payer's patience on it. A clean stop with a reason beats a slow decay into the invoice ageing out.

Escalating to a human is not a free way to be careful. It costs real money, and it closes the case to every automated route that might still have settled it. Hand off when you have run out of permitted moves that could plausibly work - not when you have run out of patience with the payer.

Answer in the required JSON format. Your rationale goes into an audit trail a human will read when they want to know why this happened, so write it for that reader.`;

function inr(p: number): string {
  return formatINR(p as never);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `dd/mm hh:mm` in IST.
 *
 * Every component is padded. An unpadded month rendered `02/8`, an ambiguous
 * field in a prompt whose whole purpose is that nothing in it has to be
 * guessed at.
 */
function stamp(ts: Timestamp): string {
  const p = localParts(ts, IST);
  return `${pad2(p.day)}/${pad2(p.month)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * The case, rendered for the model.
 *
 * Only observable fields. This function receives a `CaseObservation`, which the
 * adapter has already stripped of latent state, so there is no way for ground
 * truth to reach the prompt even by accident.
 */
export function renderCase(obs: CaseObservation, permitted: PermittedSet): string {
  const now = localParts(obs.now, IST);
  const lines: string[] = [];

  lines.push(`NOW  ${now.weekday} ${stamp(obs.now)} IST`);
  lines.push('');
  lines.push(
    `INVOICE ${obs.invoice.id}  ${inr(obs.invoice.amount_paise)}  due ${obs.invoice.due_date.slice(0, 10)}` +
      `  (${hoursBetween(obs.invoice.due_date, obs.now).toFixed(0)}h ago)`,
  );
  lines.push(
    `RAIL    ${obs.subscription.rail}  ·  plan ${inr(obs.subscription.plan.amount_paise)}/${obs.subscription.plan.interval}`,
  );

  const m = obs.subscription.mandate;
  lines.push(
    `MANDATE ${m.status}  cap ${inr(m.max_amount_paise)}  valid till ${m.valid_till.slice(0, 10)}` +
      `  afa_required=${m.afa_required}`,
  );

  const c = obs.customer;
  const reach = Object.entries(c.channels)
    .map(([ch, s]) => {
      const flags = [
        s.reachable ? null : 'no address',
        s.consent ? null : 'no consent',
        s.dnd ? 'DND' : null,
      ].filter(Boolean);
      return `${ch}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`;
    })
    .join(', ');
  lines.push(
    `PAYER   ${c.segment}  language_pref=${c.language_pref}  tenure ${c.tenure_months}mo` +
      `  lifetime value ${inr(c.ltv_paise)}`,
  );
  lines.push(`        channels: ${reach}`);
  lines.push(
    `        prior failed invoices: ${c.prior_failures}  ·  messages sent on this invoice: ${
      obs.invoice.contacts.filter((x) => !x.compliance).length
    }`,
  );

  lines.push('');
  // The issuer, and its health ONLY when that health says something.
  //
  // Three separate problems were found here, in this order. The field is an
  // object, so interpolating it printed "[object Object]". Null is not a zero
  // and not a bad issuer - it means too little traffic to judge - so printing
  // the word "null" invited the model to read absence of evidence as evidence.
  // And then the measurement that mattered: across 88,000 rendered prompts on
  // four batches, every single reported failure_rate was exactly 100%, because
  // the only stream this tracker can see is a RECOVERY queue and a recovery
  // queue is made of failures. See docs/CHALLENGES.md C-017.
  //
  // So the health clause is printed only when it discriminates - when this
  // issuer is behaving differently from its peers. Today that is never, and the
  // model correctly sees only an issuer id. Feeding it a constant dressed up as
  // a signal would be worse than feeding it nothing.
  const h = obs.issuer_health;
  const informative =
    h !== null && (h.degraded || Math.abs(h.failure_rate - h.baseline_failure_rate) >= 0.1);
  lines.push(
    `ISSUER  ${obs.issuer}` +
      (h !== null && informative
        ? ` · ${(h.failure_rate * 100).toFixed(0)}% of ${h.attempts} attempts failed in the ` +
          `last ${h.window_hours}h; other issuers ${(h.baseline_failure_rate * 100).toFixed(0)}%` +
          `${h.degraded ? ' - DEGRADED right now' : ''}`
        : ''),
  );

  lines.push('');
  lines.push(`ATTEMPTS ON THIS INVOICE (${obs.invoice.attempts.length})`);
  for (const a of obs.invoice.attempts) {
    lines.push(
      `  ${stamp(a.ts)}  ${a.rail.padEnd(12)} ${a.succeeded ? 'SUCCESS' : (a.code ?? 'FAILED')}`,
    );
  }

  const contacts = obs.invoice.contacts;
  if (contacts.length > 0) {
    lines.push('');
    lines.push(`MESSAGES ALREADY SENT (${contacts.length})`);
    for (const x of contacts) {
      lines.push(
        `  ${stamp(x.ts)}  ${x.channel.padEnd(9)} ${x.template_id}` +
          `${x.compliance ? '  (required notice, not a nudge)' : ''}`,
      );
    }
  }

  lines.push('');
  lines.push(`PERMITTED NOW: ${permitted.permitted.join(', ')}`);
  lines.push(
    `PERMITTED CHANNELS: ${
      permitted.permitted_channels.length > 0 ? permitted.permitted_channels.join(', ') : 'none right now'
    }`,
  );
  if (permitted.contact_window_opens_at !== null) {
    lines.push(`  (contact hours reopen ${stamp(permitted.contact_window_opens_at)} IST)`);
  }

  // The refusals, grouped by rule. This is the most useful part of the prompt:
  // it tells the model not just what it cannot do but what would have to change
  // for it to become possible.
  if (permitted.excluded.length > 0) {
    // Grouped by rule AND detail, not by rule alone. Three channels can be
    // refused by CONSENT_REQUIRED for three different reasons - no address, no
    // consent, DND - and collapsing them under the first reason would tell the
    // model something false about two of them.
    const groups = new Map<string, { rule: string; detail: string; actions: string[] }>();
    for (const e of permitted.excluded) {
      const target = e.channel === null ? e.action_type : `${e.action_type}/${e.channel}`;
      const k = `${e.rule_id}\u0000${e.detail}`;
      const entry = groups.get(k);
      if (entry) entry.actions.push(target);
      else groups.set(k, { rule: e.rule_id, detail: e.detail, actions: [target] });
    }
    lines.push('');
    lines.push('NOT PERMITTED, AND WHY');
    for (const { rule, detail, actions } of groups.values()) {
      lines.push(`  ${actions.join(', ')}`);
      lines.push(`    ${rule}: ${detail}`);
    }
  }

  return lines.join('\n');
}
