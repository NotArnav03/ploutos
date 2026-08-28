# Ploutos

**A bounded recovery agent for failed recurring payments on Indian rails.**

Built for the Razorpay AI Buildathon 2026, Track 03 — AI Revenue Recovery.

```bash
npm install && npm run eval
```

Two seconds, no API key, no network. It reproduces every number below from
committed decisions.

---

## The problem

A subscription debit fails. Someone's balance was short on the 3rd, an issuer
was down for an hour, a card expired, a mandate was quietly revoked at the bank.
Most of that money is recoverable and most of it is never recovered, because
recovering it well means deciding *per case* when to re-present, on which rail,
whether to say anything to the customer, and — the part that is usually skipped
— when to stop.

Stopping is not a detail. A re-presentment against an invoice the customer has
already settled by other means is a double charge. A message to someone who
asked to cancel is a complaint. A retry against a revoked mandate is an
unauthorised debit attempt. A recovery system that ignores these recovers more
money and is worse.

## What this is

A recovery loop over a batch of failed invoices that detects revenue at risk,
diagnoses why it failed, chooses an intervention from a bounded ladder, executes
it, and stops when it should — with every decision recorded so that any single
one can be replayed and explained.

The design commitment that shapes everything else:

> **A deterministic policy engine owns the guardrails. The LLM chooses only
> within the set the engine permits.**

The model never moves money, never determines eligibility, never evaluates a
compliance rule, never decides when to stop, and never computes a metric. It
diagnoses, it chooses among already-permitted options, it picks a channel, a
wait duration and a language, and it writes the rationale a human will read in
the audit trail.

---

## Results

500 failed invoices, `mix_a`, seed 42. Value at risk **₹17,07,092.23**, of which
**₹2,68,856.39 (15.7%)** is structurally unrecoverable by the taxonomy's own
classes. Prompt v1 on `gemini-3.7-flash`.

| policy | recovered | of face | of ceiling | net | cases | atts | msgs | notices | refused | esc | harm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| do-nothing | ₹0.00 | 0.0% | 0.0% | ₹0.00 | 0 | 500 | 0 | 0 | 0 | 0 | clean |
| naive-retry | ₹1,13,336.00 | 6.6% | 12.4% | ₹1,12,430.44 | 114 | 1264 | 0 | 268 | 0 | 0 | clean |
| **static-policy** | **₹5,96,091.90** | 34.9% | **65.2%** | ₹5,88,407.77 | 185 | 1215 | 436 | 268 | 0 | 28 | clean |
| **agent** | **₹5,85,644.72** | 34.3% | **64.1%** | ₹5,69,527.56 | 204 | 1081 | 732 | 285 | **0** | 99 | clean |
| oracle *(ceiling)* | ₹9,13,994.17 | 53.5% | 100.0% | ₹9,05,407.69 | 273 | 994 | 411 | 235 | 0 | 28 | clean |

### The honest reading

**The agent does not beat the hand-tuned rules engine. It ties with it.**

Both policies ran the identical 500 cases, so the comparison is paired:

```
gross -₹10,447.18   95% CI -₹1,87,631.35 .. +₹1,69,982.79
net   -₹18,880.21   95% CI -₹1,96,765.26 .. +₹1,60,724.57
the agent came out behind in 54.7% of resamples
```

54.7% is a coin flip. Only 89 of 500 cases reached different outcomes, and those
differences sit in a few dozen high-value invoices, so **this batch cannot
resolve a two-percent difference in recovered value** — in either direction.
`npm run eval` prints that warning itself rather than leaving it to the reader.

What the run *does* establish, over 12,738 recorded model decisions:

- **Zero gate rejections.** The model never once chose an action the policy
  engine had not permitted. Not because it was well-behaved — because the
  response schema is rebuilt per call to enumerate only the permitted actions,
  so a forbidden one is undecodable rather than discouraged.
- **Zero harm events.** No double charge, no contact outside permitted hours, no
  message to a DND or revoked-mandate payer, across every policy.
- **A ceiling that was derived, not asserted.** ₹9,13,994.17 comes from an
  oracle that searches ground truth for what was actually achievable. If any
  observation-only policy ever beats it, the run **fails** rather than
  publishing the higher number.

## What the model choice and the prompt are each worth

Prompt and model were both varied on the same 500 cases. Both effects are large:

| | `gemini-3.7-flash` | `gemini-3.1-flash-lite` |
|---|---|---|
| **prompt v1** | **₹5,85,645 · 64.1%** | ₹3,98,306 · 43.6% |
| **prompt v2** | *not measured* | ₹5,43,880 · 59.5% |

- **Model**, prompt held fixed: **+47%** for the larger model.
- **Prompt**, model held fixed: **+37%** for v2.

Prompt v2 closes the specific defects diagnosed in `docs/CHALLENGES.md` C-018 —
presentments on authentication-blocked cases go from 2 to 14 (the baseline
manages 15), and escalations to a human fall from 99 to 13 (the baseline: 28).

The top-right cell is empty for an honest reason: **the API budget ran out**
2,300 decisions into roughly 3,100. It is the configuration both effects predict
should be best, and it was never measured. `docs/EXPERIMENTS.md` has the full
grid, the behavioural counters, and the variant that made things worse.

---

## Architecture

```
world (ground truth)  ──►  observation  ──►  gate  ──►  policy  ──►  runner  ──►  ledger
   src/world/**            src/adapter/    src/policy/   ▲          src/eval/    src/ledger/
   NEVER imported                                        │
   by policy code                              LLM chooses here only,
                                               from the permitted set
```

Five things carry the weight:

**1. The latent/observable split is enforced by the build.** `src/world/**` holds
ground truth. `src/agent/**`, `src/policy/**` and `src/domain/**` may never
import it, and a test fails the build if they do. The agent cannot cheat because
it cannot reach the answer.

**2. Rules are enforced structurally, never prompted.** A test asserts that
`CONTACT_HOURS`, `DND`, `PREDEBIT_NOTICE` and `AFA_THRESHOLD` never appear in
the system prompt. The gate removes illegal actions before the model sees a
menu. "The LLM cannot authorise a refund" is a property of the request schema
and of the action union — there is no refund action to construct.

**3. Every refusal names the rule that caused it.** The trail records not just
what happened but what was forbidden and why, which is what makes it an
explanation rather than a log.

**4. The audit trail is hash-chained per case, and verified before any metric is
reported.** A tampered or truncated trail is worse than none, because it still
looks credible, so `npm run eval` refuses to print numbers derived from one.

**5. Decisions are committed, so the results replay.** 12,738 recorded model
decisions live in `.cache/llm/`, keyed on prompt version, model, observation
hash and the permitted set — so an answer chosen from one menu is never replayed
against a different one.

Full walkthrough, with sequence diagrams and the enforcement points: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Reproducing the numbers

```bash
npm run eval                        # the table above, ~2s, no API key
npm test                            # 166 tests
```

Every figure comes from `results/checkpoint-main-s42-agent-v1/`, committed in
full — metrics, per-case outcomes, and the complete hash-chained audit trail for
all five policies, nothing sampled.

To check the trail rather than take it on trust:

```bash
# re-derive every hash and every link in all five chains
npm run replay -- --run results/checkpoint-main-s42-agent-v1 --verify

# read one case's decisions as a timeline
npm run replay -- --run results/checkpoint-main-s42-agent-v1 --case CASE-00005
```

The second prints, for every step: what the gate permitted, **which rule refused
each thing it did not**, what the policy chose and the reason it gave, and what
the world did in response. `CASE-00005` is the ₹19,369 invoice discussed in
C-018, where the gate offered a presentment five times and the agent waited
through all of them until the mandate expired.

Other configurations, all replaying from cache with no key:

```bash
npm run eval -- --batch main --prompt v2 --model gemini-3.1-flash-lite
npm run behaviour -- --runs results/grid/v1-flash-lite,results/grid/v2-flash-lite
```

---

## The site

`web/` is a single self-contained page presenting the above: the problem, the
gate walked step by step over a real case, the results table, the paired
comparison, and the rules registry.

```bash
npm run site:build      # regenerate web/index.html from the committed run
npm run site            # http://localhost:5173
```

**It has no backend and does not want one.** `web/build.mjs` reads
`results/checkpoint-main-s42-agent-v1/`, `config/rules_registry.yaml` and the
gzipped audit trail, and bakes a ~29 KB payload into the page. Nothing on the
page is typed by hand, so a new checkpoint plus `npm run site:build` moves every
figure at once — the same property `npm run eval` has, for the same reason.

The gate walkthrough replays `CASE-00005` from the committed trail: what the
engine permitted at each step, **which rule refused each thing it did not**,
what the model chose, and the rationale it gave. Those are recorded Gemini
decisions, not live calls. The page never contacts a model, holds no
credential, and renders identically offline.

`web/index.html` and `web/artifact.html` are generated and committed so the
site can be served without running the build; `web/index.template.html` is the
source.

## Razorpay test-mode adapter

The actions the agent chooses correspond to real gateway calls. `npm run
razorpay-demo` exercises them against Razorpay **test mode** and writes
`results/razorpay-transcript.json` — every request and response, credentials
redacted.

| action | status |
|---|---|
| `send_payment_link` | **live** — creates a real Payment Link, verified by fetching it back |
| `retry_debit`, `request_afa`, `serve_predebit_notice`, `switch_rail`, `request_instrument_update`, `grant_grace` | **unavailable on this account** |
| `wait`, `notify_soft`, `capture_promise_to_pay`, `handoff_human`, `stop_terminal` | not applicable — never leave the merchant's own systems |

The mandate actions are unavailable because **Razorpay Subscriptions is a
separately-enabled product** and this test account does not have it:
`POST /v1/plans` returns a bare `{"error":"Unauthorized"}`. That is recorded in
the transcript as a real 401 rather than mocked, because a mocked mandate call
demonstrates nothing.

Failure classification maps only what Razorpay's error envelope states
structurally — `step` and `source` are documented and stable. It returns
`null` for everything else and carries the raw `reason` through, because the
complete reason list is published only as a spreadsheet linked from their docs,
and a mapping table built by guessing at those strings would look authoritative
and be fiction.

**None of this is in the evaluation path.** `tests/boundary.test.ts` fails the
build if `src/eval`, `src/policy`, `src/agent` or `src/domain` imports
`src/razorpay` — a measured number must never depend on a gateway being
reachable.

## Honesty notes

- **Every number here comes from a committed run.** Nothing is estimated,
  projected or rounded up from a smaller sample.
- **The world is synthetic.** Failure-code distributions are an assumption, not
  a measurement, which is why the headline is run under three different mixes
  rather than one. `config/failure_mix.yaml` argues each.
- **Every compliance parameter carries a `verification` status**, and they were
  checked against primary sources on 27 Aug 2026:
  - `AFA_THRESHOLD` ₹15,000 and `PREDEBIT_NOTICE` 24h are **verified** against
    RBI/DPSS/2026-27/396, the E-mandate Framework 2026.
  - `CONTACT_HOURS` and `DND_SUPPRESSION` are **analogous** — the regulations
    are real (RBI/2022-23/108; TRAI TCCCPR) but they bind lenders recovering
    loans and telecom-resource messaging respectively, not a merchant
    collecting a subscription. We adopt them voluntarily and say so.
  - The six remaining `unverified` rules are retry caps and contact limits,
    which are merchant policy and ours to choose.
- **One known deviation, in the unsafe direction.** The E-mandate Framework
  requires the 24-hour pre-debit notice for cards; our rule applies it to UPI
  Autopay and e-NACH only, so a card debit is presented here without it. It is
  documented rather than fixed, because changing the permitted set invalidates
  all 12,738 recorded decisions and the budget for a re-run is gone. See C-026.
- The phrases "RBI compliant" and "NPCI compliant" appear nowhere in this
  repository, and a test enforces that. So does a test that no unverified rule
  claims a regulator requires it.
- **A re-run reproduces every hash and every number exactly; the files differ.**
  Each record carries the wall clock at which it was written, deliberately
  outside the hash.
- **Goodwill cost is an unfalsifiable modelling assumption** and is reported
  beside the headline net figure, never folded into it.
- **Model spend is reported in dollars beside the rupee figures, never inside
  them** — converting would put an unstated exchange rate into a headline
  number. The whole project cost **₹1,241** in inference.

## What I would do next

1. **Finish the top-right cell.** v2 on `gemini-3.7-flash`, ~800 decisions
   remaining. Both main effects predict it is the configuration that would
   finally beat the baseline.
2. **`stop_terminal` is the largest open behavioural gap** — the agent closes
   invoices as uncollectable that the rules engine recovers by simply asking the
   payer for a new card. One attempt to fix it by instruction failed
   (`EXPERIMENTS.md`, v3); the next attempt should be structural.
3. **Seeds and mixes.** The result is one seed on one mix. The deterministic
   policies and the oracle sweep both for free; the agent's row does not.

## Setup

```bash
npm install
npm test
npm run typecheck
```

No API key is needed for the tests or the evaluation. One is needed only to
*record* new decisions; copy `.env.example` to `.env` and add a Gemini key.
`npm run eval` prints which credential it is about to use before it spends
anything.

## Licence

MIT. Sole author: Arnav.
