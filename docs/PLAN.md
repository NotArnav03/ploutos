# Build plan

**Track 03 — AI Revenue Recovery.** Razorpay AI Buildathon 2026.

The bar, verbatim, is the spec:

> Don't just identify the problem. Show measured money recovered across a batch,
> with compliant escalation, stopping rules, and an audit trail.

Every item below traces to a clause in that sentence.

---

## The slice

Recovery of **failed recurring debits on Indian rails** — UPI Autopay, e-NACH,
card-on-file — for a merchant's failed-invoice queue.

Chosen over the other example directions because it is the only one where all
three properties hold at once:

- **The money is already denominated.** ₹ at risk is a sum over invoice
  amounts, not a counterfactual. Checkout-abandonment recovery has no honest
  denominator — "this cart would have converted" is unfalsifiable, and a panel
  of payments engineers will read that as grading our own homework.
- **The failure is coded.** Decline codes split cleanly into recoverable-with-
  time, recoverable-with-action, and structurally terminal. That split is what
  makes an honest recoverable ceiling computable.
- **The lever set is rich enough to need an agent.** When to re-present, on
  which rail, whether to notify first, whether to request an instrument update,
  when to capture a promise, when to hand to a human, when to stop.

Two further example directions are folded in rather than built separately:
**payment degradation → root cause** appears as issuer-health signal feeding
retry timing, and **promise-to-pay** is rung 4 of the escalation ladder.

**Hinglish voice recovery is deliberately out of scope.** It is the flashiest
direction and the worst time-to-value: telephony, STT/TTS, latency, and it makes
the evaluation non-deterministic, which destroys the thing the bar rewards. The
localisation signal is kept for a fraction of the cost — `language_pref` on the
customer, and the agent generates message copy in Hinglish/Hindi/English within
template guardrails. See rule `NO_VOICE`.

---

## Calendar

Submission target is **3 September**, not the 5th. The 5th is sourced from
secondary reporting rather than the official page, and the form locks with no
edits after submitting. Two days of buffer against a date we cannot verify is
cheap insurance.

Ten working days, 25 August to 3 September.

| Day | Date | Deliverable | Submittable after? |
|-----|------|-------------|--------------------|
| 1 | Aug 25 | Repo, domain schemas, failure taxonomy, rules registry, boundary test | no |
| 2 | Aug 26 | Generator, latent state, simulator, golden-file tests. **Freeze the world model.** | no |
| 3 | Aug 27 | `do-nothing` + `naive-retry` baselines, metric computation, `npm run eval`. **First real numbers.** | barely |
| 4 | Aug 28 | Policy engine + unit tests. `static-policy` and `oracle` baselines. **Checkpoint.** | yes, minimally |
| 5 | Aug 29 | Hash-chained audit ledger, `npm run replay` | yes |
| 6 | Aug 30 | LLM decision service: diagnosis, action selection, structured output, cache. **First agent run.** | yes — the real pitch exists |
| 7 | Aug 31 | Tuning against the harness. Promise-to-pay rung, message copy. Experiment log. | yes |
| 8 | Sep 1 | Adversarial cases, harm metrics to zero, seed sweep, bootstrap CIs, 3-mix sensitivity | yes, strong |
| 9 | Sep 2 | Razorpay test-mode adapter, compliance-parameter verification, architecture diagram | yes |
| 10 | Sep 3 | README, freeze the final run, record video, **submit** | ship |
| — | Sep 4–5 | Buffer only. Do not plan work here. | — |

**Day 4 is a hard checkpoint.** If `npm run eval` is not producing numbers by
the end of it, the scope is wrong and the response is to cut, not to push: drop
rail-switching and message generation and ship a timing-only recovery loop.

**From day 4 onward the repo ends every day in a state worth submitting**, tagged.
If days 9–10 are lost to other commitments, the day-8 tag is still a real entry.

### What the compressed calendar cost

The original plan had twelve days and a separate day for recording. At ten, the
optional demo dashboard is **cut** — the video shows the CLI and a static HTML
report instead. Day 10 carries both the README and the recording, which is the
tightest day in the plan. If day 9 slips, the video is recorded against the day-8
tag and the Razorpay adapter is dropped from the submission rather than the
README being rushed.

---

## Dataset

Ground truth lives in `src/world/latent.ts` and the agent never sees it. The
adapter emits only `CaseObservation` (`src/domain/schemas.ts`). The separation is
enforced by `tests/boundary.test.ts`, which fails the build on violation.

- **Batches.** `demo.jsonl` 60 invoices (under two minutes, for the video),
  `main.jsonl` 500 failed invoices over ~400 subscriptions (headline),
  `stress.jsonl` 2,000 (run once, to show it holds up).
- **Failure mix is an assumption, not a measurement.** Three mixes ship
  (`config/failure_mix.yaml`) and the headline runs under all three. A result
  that only survives under one mix is an artifact of the mix, and we say so.
- **15–27% of at-risk value is structurally unrecoverable** by construction.
  The metric rewards identifying and stopping on those, not recovering them.
- **~5% adversarial cases**, hand-authored: out-of-band payment mid-dunning
  (a re-presentment here is a double charge), cancellation mid-ladder, DND on
  one channel but consent on another, an amount just over the AFA threshold, a
  mandate expiring inside the retry window, a duplicate failure event, and a
  high-LTV account on its fourth consecutive failure.

## Intervention policy

A deterministic policy engine owns the guardrails. The LLM chooses only within
the set the engine permits. Rungs:

| Rung | Action |
|------|--------|
| 0 | Silent re-presentment, no contact |
| 1 | Re-presentment + soft notification |
| 2 | Instrument-update request, or rail switch |
| 3 | Payment link with an expiry |
| 4 | Promise-to-pay capture, retry scheduled against the promise |
| 5 | Grace period — one cycle, once, never a discount |
| 6 | Human handoff with a written case summary |
| 7 | Terminal: write-off or suspension, with a `rule_id` |

Serving a pre-debit notice and requesting AFA are **rung-neutral**: compliance
must not cost the customer an escalation step.

Authority bounds are enforced by the type system as well as the registry — there
is no discount action and no refund action in `src/domain/actions.ts`, so "the
agent cannot offer a discount" is a property of the code, not a promise in a
prompt.

## Metrics

`npm run eval -- --batch <file> --policy <p> --seed <n>` writes
`results/<run_id>/{metrics.json, cases.jsonl, audit.jsonl, report.md}`, committed.

Four policies through the **same** simulator and the **same** audit pipeline:

1. `do-nothing` — establishes the denominator.
2. `naive-retry` — fixed +24h/+72h/+120h, same rail, no messaging. The honest bar.
3. `static-policy` — tuned decline-code rules, no LLM. **Doubles as the LLM ablation.**
4. `oracle` — sees latent state. Not a competitor; the recoverable ceiling.

Headline numbers: ₹ at risk; ₹ recoverable ceiling; ₹ recovered per policy;
**recovery rate against ceiling**; net recovered after intervention cost;
contacts per successful recovery; median time-to-recovery; **harm-rule
violations, which must be zero**; false- and missed-escalation rate; cost per
₹100 recovered; share of LLM choices rejected by the gate.

Rigour that is nearly free: 5-seed sweep with mean ± std, bootstrap 95% CIs,
and the three-mix sensitivity run.

**A run that recovers more money while tripping one harm rule is reported as a
failed run.**

## Audit trail

Append-only JSONL, hash-chained (`prev_hash` → `hash`) so tampering is
detectable. This is a Merkle-style integrity chain and explicitly **not** a
blockchain; see `docs/DECISIONS.md` D-005.

Every record carries the observation hash, the permitted set, **the excluded
actions with the `rule_id` that excluded each**, the decision with its rationale
and model metadata, the policy checks, the action, the outcome, the money delta
and the cost.

`npm run replay -- --case CASE-0142` renders one case as a human-readable
timeline: what was known, what was allowed and why three things were not, what
was chosen and why, what happened.

## Where the LLM is not

Money movement · eligibility determination · retry caps · compliance checks ·
stop conditions · metric computation · outcome resolution.

Where it earns its place: synthesising a root-cause diagnosis across decline
history, issuer health and customer history; choosing among permitted actions
with timing, channel and tone; generating customer copy in the right language
and register; writing the human-handoff summary.

The `static-policy` baseline is the evidence for that claim. If the LLM delta is
small, we publish it and discuss it.

---

## Video, in order

| Time | Content |
|------|---------|
| 0:00–0:25 | The number. ₹ at risk, naive-retry recovery, agent recovery against ceiling, zero violations. Table on screen. |
| 0:25–1:10 | Architecture, one diagram, hammering the LLM boundary. |
| 1:10–2:30 | Live `npm run eval` on the demo batch, ending on the metrics table. |
| 2:30–3:30 | `npm run replay` on one case: observation → three excluded actions and why → diagnosis → choice → outcome. |
| 3:30–4:10 | A case it could not recover, and a case where it **stopped** — the out-of-band payment where it halted to avoid a double charge. |
| 4:10–4:40 | Baseline chart, and limitations stated aloud, not buried. |
| 4:40–5:00 | Razorpay test-mode clip, reproduce instructions. |

No music, no logo animation, no personal intro. Scripted, one take per section.
