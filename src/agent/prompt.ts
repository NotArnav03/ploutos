import type { PermittedSet } from '../domain/actions.js';
import type { CaseObservation } from '../domain/schemas.js';
import { formatINR } from '../domain/money.js';
import { hoursBetween, localParts, type Timestamp } from '../domain/time.js';

/**
 * The system prompts, every version that was measured.
 *
 * WHY ALL THREE ARE STILL HERE
 *
 * `docs/EXPERIMENTS.md` compares them, and a tuning log whose rows nobody else
 * can re-run is a claim rather than a record. `--prompt` reproduces any row.
 *
 * It also removes a whole class of mistake. These experiments used to be run by
 * checking an old prompt into the working tree and checking it back out after,
 * and one `git add -A` swept the temporary file into an unrelated commit -
 * silently reverting the prompt, so the next run replayed one version's cached
 * decisions under another version's name. Nothing about that was visible in the
 * output. A flag cannot do it.
 */
export const PROMPTS: Record<string, string> = {
  /**
   * Day 6. Taught restraint without ever pricing it, so the model guarded a
   * 50-paise retry fee while mandates expired underneath it. See C-018.
   */
  v1: `You decide the next step for a single failed recurring payment in an Indian merchant's recovery queue.

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
- RISK_HOLD and LIMIT_EXCEEDED clear with time.
- A retry that fails is not free. It costs a gateway fee and consumes one of the few attempts this invoice is allowed before it must be closed.

MESSAGING PAYERS

Every message spends goodwill, and there is a hard lifetime cap. A nudge is worth sending when the payer has to DO something - fund the account, update a card, use a link. It is worth little when the next presentment would have succeeded anyway.

Write for the customer's language_pref: en is English, hi is Hindi, hinglish is the Roman-script mix most Indian consumers actually text in.

STOPPING

Recovering nothing is an acceptable outcome. If the evidence says this invoice is not collectable by any permitted action, stop or escalate rather than spending more of the payer's patience on it. A clean stop with a reason beats a slow decay into the invoice ageing out.

Answer in the required JSON format. Your rationale goes into an audit trail a human will read when they want to know why this happened, so write it for that reader.`,

  /**
   * Day 7. Behaviourally the best prompt measured - see docs/EXPERIMENTS.md -
   * but NOT the default, because its pairing with gemini-3.7-flash is the one
   * cell of the prompt-by-model grid that budget ran out before measuring. The
   * default has to be a pair the committed cache can replay offline.
   *
   * Adds what a presentment, message and
   * handoff cost against invoice size; that AFA is unblocked by one request and
   * sits behind an expiring mandate; that escalation is not a free way to be
   * careful; and that a wait should last until something could have changed.
   */
  v2: `You decide the next step for a single failed recurring payment in an Indian merchant's recovery queue.

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

Answer in the required JSON format. Your rationale goes into an audit trail a human will read when they want to know why this happened, so write it for that reader.`,

  /**
   * Day 7, reverted. Named the real budgets - four presentments, four lifetime
   * messages - and the model hoarded them rather than spending them better.
   * Kept because a tuning log that records only the wins describes a straight
   * line that did not happen.
   */
  v3: `You decide the next step for a single failed recurring payment in an Indian merchant's recovery queue.

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

TWO BUDGETS YOU ARE SPENDING

This invoice gets at most four presentments and at most four outbound messages in its entire life, and then it is closed whether or not it was paid. Every message counts against that four: an authentication request, a card-update request and a nudge all come out of the same four.

So spending three messages on the same ask leaves one for everything else. If you have already asked the payer to authenticate and they have not, asking again in the same words is not persistence - it is spending the budget you would need to ask them for something different.

WAITING

When you wait, wait until something could actually have changed. The refusals tell you when that is: a retry gap that needs 24 more hours, contact hours that reopen at 09:00, a salary credit due on the 1st. Waking up before then just looks at an unchanged case and spends another decision on it.

Waiting six hours when the earliest possible change is a day away is not caution, it is a wasted look. Pick the hour the situation actually moves.

MESSAGING PAYERS

Every message spends goodwill, and there is a hard lifetime cap. A nudge is worth sending when the payer has to DO something - fund the account, update a card, use a link. It is worth little when the next presentment would have succeeded anyway.

Write for the customer's language_pref: en is English, hi is Hindi, hinglish is the Roman-script mix most Indian consumers actually text in.

STOPPING

Recovering nothing is an acceptable outcome. If the evidence says this invoice is not collectable by any permitted action, stop rather than spending more of the payer's patience on it. A clean stop with a reason beats a slow decay into the invoice ageing out.

Escalating to a human is not a free way to be careful. It costs real money, and it closes the case to every automated route that might still have settled it. Hand off when you have run out of permitted moves that could plausibly work - not when you have run out of patience with the payer.

Closing the case with stop_terminal is not a cheaper way to escalate. Both end the invoice; neither collects anything. An expired card is not an unrecoverable invoice - it is an invoice waiting on a payer who has not been asked yet, and request_instrument_update is the ask. A failure code that names a thing the payer can fix is not terminal while you still have a message left to spend on it.

Answer in the required JSON format. Your rationale goes into an audit trail a human will read when they want to know why this happened, so write it for that reader.`,
};

/**
 * The version used when none is named.
 *
 * v1 rather than the behaviourally better v2, for one reason: the default has
 * to be a configuration `npm run eval` can replay from the committed cache with
 * no API key. v1 with gemini-3.7-flash is the highest-recovery pair that is
 * fully recorded, and it is the pair the committed checkpoint holds. v2's best
 * pairing was never measured. Pass `--prompt v2` for the rest of the grid.
 *
 * The decision cache is keyed on this, so editing the prompt it points at
 * invalidates every cached decision rather than mixing answers from two
 * different prompts into one reported number. It is written into every audit
 * record, so a result traces back to the exact instructions that produced it.
 */
export const PROMPT_VERSION = 'v1';

/** Throws rather than falling back, because a fallback would be a different experiment. */
export function systemPrompt(version: string = PROMPT_VERSION): string {
  const p = PROMPTS[version];
  if (p === undefined) {
    throw new Error(
      `unknown prompt version ${version}; have ${Object.keys(PROMPTS).join(', ')}`,
    );
  }
  return p;
}

/** The default prompt. Kept as a binding because tests assert against it. */
export const SYSTEM_PROMPT = systemPrompt();

const IST = 'Asia/Kolkata';

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
