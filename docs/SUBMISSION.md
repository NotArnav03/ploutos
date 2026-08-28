# Submission working document

Draft answers for the Razorpay AI Buildathon 2026 form, and the script for the
five-minute video. Nothing here is submitted automatically — this is the
material to paste in.

---

## Project Name

**Ploutos — a bounded recovery agent for failed recurring payments**

## Project Objectives

Recover revenue from failed recurring debits on Indian rails (UPI Autopay,
e-NACH, cards-on-file) with an LLM making the per-case judgement calls, and to
do it in a way where the compliance guarantees do not depend on the model
behaving well.

Three things it sets out to prove, in order of how hard they were:

1. **Measured money, against a ceiling that was derived rather than asserted.**
   Recovery is reported as a share of what an oracle with access to ground truth
   actually achieved — not as a share of face value, which includes money no
   policy could ever have collected. If any observation-only policy beats the
   oracle, the run fails rather than publishing the higher number.

2. **Compliance enforced structurally, not prompted.** The system prompt
   contains no compliance rules at all, and a test asserts that. A deterministic
   gate removes illegal actions before the model sees a menu, and the response
   schema is rebuilt per call to enumerate only permitted actions — so a
   forbidden action is undecodable rather than discouraged. Across 12,738
   recorded model decisions the gate-rejection count is zero.

3. **An audit trail that explains rather than logs.** Every decision, and every
   *refusal*, is recorded with the rule id that caused it, in a per-case
   hash-chained ledger that is verified before any metric is printed.

## GitHub Repository URL

https://github.com/NotArnav03/ploutos

Public. Verified 28 Aug 2026 that an anonymous request reaches the README, both
architecture diagrams, the rules registry, the metrics and the gzipped audit
trail — every artefact this document cites.

## Live Demo

https://ploutos-one.vercel.app

The project site: the problem, the policy gate walked step by step over
`CASE-00005`, the results table, the paired comparison, and the rules registry
with its verification statuses.

Section III is live. Upload a case record — or run one of the three samples —
and it runs the real gate and makes one real model call, showing the permitted
set, the rule that refused everything else, and the model's own reasoning. It
stops after one decision rather than simulating an outcome it has no ground
truth for. `tests/boundary.test.ts` fails the build if the measured path can
reach that endpoint.

`node web/build.mjs` regenerates it from `results/checkpoint-main-s42-agent-v1`
on every push, so the page cannot drift from the run it reports. There is no
backend, no credential, and no model call at page load — the decisions it shows
are the recorded ones, and it renders identically offline.

## Pitch Video Link

*fill in*

---

## Build Challenges & Technical Obstacles

> Suggested form answer. The full log is `docs/CHALLENGES.md`, 26 entries.

The hardest problem was not building the agent. It was building instruments
honest enough to tell me the agent was not working, and then believing them.

Four that cost the most:

**The agent lost to the rules engine, and the audit trail said exactly why.**
First real run: ₹5,85,645 against a hand-tuned baseline's ₹5,96,092. The trail
showed the gate offering a presentment five consecutive times on a ₹19,369
invoice while the agent waited, re-requested authentication it already had, and
escalated eleven hours after the mandate expired. Across the batch it forewent
500 permitted retries and escalated 99 times to the baseline's 28. The cause was
my prompt: it taught restraint without ever pricing it, so the model guarded a
50-paise retry fee while mandates expired. The fixed prompt closed both defects
— presentments on authentication-blocked cases went 2 → 14, escalations 99 → 13.

**`npm run eval` silently stopped replaying its own results.** Issuer health was
read inside each concurrent task, so the observation hash — part of the decision
cache key — became a function of network latency. Every lookup missed and the
command quietly turned into thousands of live API calls. The existing
concurrency test passed throughout, because no policy reads that field so the
drift never reached a metric. The test that mattered was one nobody had written:
that the observation hashes themselves are stable. It also had to be made bigger
— at 50 cases the field is null everywhere and the assertion was vacuous.

**I nearly forged my own evidence.** A debugging script pointed a stub model at
the committed decision cache and wrote 5,500 fabricated decisions into the file
the README describes as real recorded ones — indistinguishable by inspection,
caught only because an unrelated count came out wrong. Never committed.
`makeAgent` now refuses a caller that injects a completer without injecting a
cache, and a test asserts every committed decision carries a non-zero token
count, because a decision that cost nothing did not come from an API.

**Verifying the compliance parameters found one that was wrong.** The 24-hour
pre-debit notice is exact per the RBI E-mandate Framework 2026 — but that
framework covers cards, and our rule applied it only to UPI Autopay and e-NACH.
It is the one deviation in the repo that errs loose rather than strict. It is
documented rather than quietly patched, because changing the permitted set
invalidates all 12,738 recorded decisions and would mean shipping a headline
number produced by a gate nobody had re-measured.

The pattern across all of them: instrumentation built for one reason kept
catching a different bug. The generator's drift table found four generator bugs.
"Why not" logging made a strawman baseline fixable. Chain verification caught a
key-order hash bug. The oracle invariant caught five separate search
incompletenesses. In every case the guardrail had to be *structural* — I knew
not to point a stub at the real cache, and did it anyway, because knowing is not
a mechanism.

---

## Five-minute video script

Total 5:00. Everything demoed runs offline from the committed cache in about two
seconds, so nothing can fail live.

### 0:00 – 0:35 · The problem

> A subscription debit fails. Balance short on the 3rd, issuer down for an hour,
> card expired, mandate revoked. Most of that money is recoverable and most of
> it is never recovered — because recovering it well means deciding per case
> when to re-present, on which rail, whether to message, and when to stop.
>
> Stopping is not a detail. Re-presenting against an invoice already settled is
> a double charge. Messaging someone who cancelled is a complaint. Retrying a
> revoked mandate is an unauthorised debit attempt. A recovery system that
> ignores those recovers more money and is worse.

### 0:35 – 1:20 · The design commitment

Show `docs/ARCHITECTURE.md` diagram.

> One commitment shapes everything: **a deterministic policy engine owns the
> guardrails, and the LLM chooses only within the set the engine permits.**
>
> The model never moves money, never decides eligibility, never evaluates a
> compliance rule, never decides when to stop. There are no compliance rules in
> the prompt — a test asserts that. The gate strips illegal actions first, and
> the response schema is rebuilt on every call to list only what is permitted,
> so a forbidden action isn't discouraged, it's undecodable.

### 1:20 – 2:20 · The measurement — run it live

```bash
npm run eval
```

> Two seconds, no API key. Five policies on 500 failed invoices.
>
> The number that matters is the last column — share of **ceiling**, not of face
> value. The ceiling is what an oracle with access to ground truth actually
> achieved by searching. If any policy that can't see ground truth ever beats
> it, the run throws, because that would mean the ceiling is wrong and every
> percentage below it is inflated.

### 2:20 – 3:20 · The audit trail

```bash
npm run replay -- --run results/checkpoint-main-s42-agent-v1 --case CASE-00005
```

> Every step: what the gate permitted, **which rule refused each thing it
> didn't**, what the model chose and why, what the world did back.
>
> This particular case is the one that cost me the most. Watch the gate offer
> `retry_debit` five times in a row while the agent waits — then the mandate
> expires and ₹19,369 is gone. I didn't find that by reading code. I found it by
> reading the trail.

### 3:20 – 4:20 · The honest result

> The agent recovers ₹5,85,645. The hand-tuned rules engine recovers ₹5,96,092.
>
> **It ties. It does not win.** Paired over the same 500 cases, the agent is
> behind in 54.7% of bootstrap resamples — a coin flip. `eval` prints that
> warning itself.
>
> What the run does establish: zero gate rejections across 12,738 model
> decisions, zero harm events, and a complete verifiable trail.
>
> And a grid — prompt versus model. The model is worth 47%. The prompt is worth
> 37%. The cell that combines the better prompt with the better model is the one
> configuration I never measured, because the API budget ran out 2,300 decisions
> into 3,100. It's marked empty rather than omitted.

### 4:20 – 5:00 · What's next, and the point

> Three things: finish that cell, fix the pre-debit notice scope I found while
> verifying compliance parameters against RBI's 2026 framework, and sweep more
> seeds.
>
> The claim I'd defend isn't "an LLM recovered more money." On this batch it
> didn't. It's that an LLM can be given real discretion over money while every
> rule that matters is enforced somewhere it cannot reach — and that when it
> fails, the trail tells you exactly which decision, on which invoice, against
> which rule.

---

## Pre-submission checklist

Verified 27 Aug 2026, re-checked 28 Aug 2026:

- [x] `npm test` green (**171 passed**), `npm run typecheck` clean
- [x] `npm run eval` reproduces the README table — **2,736 cached, 0 live calls**
- [x] `npm run replay -- --verify` — **all chains verified across 33,768 events**
- [x] No API key committed — `.env` is gitignored, `.env.example` values empty,
      and a scan for Google/Razorpay key patterns across every tracked file is clean.
      The test fixture is assembled from fragments so it cannot trip GitHub push
      protection at submission time.
- [x] `npm run razorpay-demo` exercised against test mode; transcript committed
      at `results/razorpay-transcript.json` with credentials redacted
- [x] All 26 challenge entries written; compliance parameters verified against
      primary sources

Still to do:

- [x] Repo pushed to GitHub — `master`, site included
- [x] Site deployed and serving — https://ploutos-one.vercel.app, verified
      byte-identical to a clean rebuild of the committed run (102,886 bytes)
- [x] **Repo made public**, and every artefact cited here fetches anonymously
- [x] README renders; both mermaid blocks in `docs/ARCHITECTURE.md` are
      `flowchart` and `sequenceDiagram`, which GitHub renders natively, and
      every code fence across README and docs is balanced
- [x] MIT `LICENSE` added — the README claimed MIT and GitHub detected no
      licence, because the file did not exist
- [x] Live decision working end to end, verified 28 Aug 2026 against the
      deployed endpoint: `CASE-00005` returned HTTP 200 in 2.0s, the gate
      permitted 8 of 12 actions, and the model chose `request_afa` on
      whatsapp — inside the permitted set, and the same action the recorded
      run chose on this case. `LIVE_MODEL=gemini-3.1-flash-lite`, on a
      free-tier key, so the demo cannot incur a charge
- [ ] Video recorded, under 5:00, link added above
- [ ] Form fields pasted from this document
