# Build challenges

Kept contemporaneously, from day 1, because the application asks *"what issues
did you face while building, and how did you solved them?"* and an answer
reconstructed on the last day reads exactly like an answer reconstructed on the
last day.

Entries are appended as things break. Trivia is recorded as trivia — inflating a
five-minute dependency bump into a war story is worse than omitting it.

Format: date · what broke · why · what was done · what it cost.

---

## 2026-08-25 · Day 1

### C-001 — Test runner shipped a vulnerable transitive dependency chain
**Severity: minor. Cost: ~5 minutes.**

`npm audit` reported five advisories (one critical, one high) immediately after
the first install. All of them were in `vitest`'s dev-only chain via `vite` and
`esbuild`, none in anything that ships or runs in the evaluation path.

Left alone it would have been harmless — but the repo is a submission artifact
that payments engineers will read, and a reviewer running `npm audit` and seeing
"1 critical" forms an impression before reading a line of code. Bumped `vitest`
from 2.x to 3.x, which pulls a patched `vite`. Clean audit.

Worth noting as a judgement call rather than a fix: the vulnerability was not
real for this project, and the reason to act was how it would read.

### C-002 — Wrote against a zod v4 API while pinned to zod 3.25
**Severity: minor. Cost: ~5 minutes.**

Used `z.prettifyError()` for config validation error messages. That is a zod v4
export; the project resolves `zod@3.25.76`, where it does not exist on the root
export. `tsc` would have caught it, but it was caught first by knowing the
version boundary was ambiguous — 3.25 ships a `zod/v4` subpath, so the two APIs
coexist in one installed version and it is easy to write the wrong one.

Replaced with a hand-rolled formatter over `error.issues`, which is stable across
both. Decided against upgrading to zod 4 for this: v4 changes `z.record`
semantics for enum keys, and the domain schemas already lean on that.

---

## Categories to watch for later

Placeholders, so the real entries land in a structure rather than a heap:

- **Simulator determinism.** Any place where a run is not byte-identical given a
  seed. Most likely source: iteration order over a Map keyed by generated ids.
- **The counterfactual problem.** The recoverable ceiling depends on the oracle
  being genuinely optimal rather than merely good. If the agent ever beats the
  oracle, the oracle is wrong, not the agent.
- **Structured output drift.** Rate at which the model returns an action outside
  the permitted set, and what the fallback did. This number is reported, not hidden.
- **Compliance parameter verification.** The four `unverified` rules in
  `config/rules_registry.yaml` and what the primary sources actually say.
- **Cost and latency.** What a full 500-case agent run costs and how long it
  takes, cold cache and warm.

---

## 2026-08-25 · Day 2

Four modelling bugs, all of them found by one piece of instrumentation rather
than by reading the code. `npm run gen` prints the target failure mix beside the
mix the simulator actually produced, plus a "relabelled" count of cases where
the mechanism derived a different code than the one the case was built for.

First run: **18.2% relabelled**, and four codes off target by more than four
points. That number is the reason all of these were caught in an hour instead of
surfacing on day 8 as an inexplicably easy batch.

### C-003 — The "healthy" baseline account was broke
**Severity: high. Cost: ~20 minutes.**

Latent state starts from a healthy baseline which each archetype then perturbs.
The baseline placed the salary refill day *after* the invoice due date, so the
baseline account had no money at presentment. Any archetype whose own mechanism
failed to fire fell through the check order into the funds check.

Two visible symptoms: `INSUFFICIENT_FUNDS` came out 17 points above its 38%
target, and `TXN_TIMEOUT` — which sits *after* the funds check in the ordering —
never appeared at all, against a 5% target. Fixed by deriving the refill day
backwards from the due date so the baseline is genuinely funded, and sizing the
funded window to cover the offset.

The wider lesson: in a layered generator, the base layer has to be *neutral*.
A base layer that fails in a plausible way silently absorbs every other cause.

### C-004 — A global target mix was arithmetically unreachable
**Severity: high. Cost: ~25 minutes.**

The generator drew a rail first, then renormalised the failure mix over the
codes that rail supports. `INSTRUMENT_EXPIRED` only exists on cards, so its
reachable share was capped near (card share × renormalised weight) ≈ 3.2%,
against a 9% global target. It measured 2.2%. No amount of tuning inside that
structure could have fixed it — the target was not achievable by construction.

Inverted the draw: pick the root cause from the global mix first, then pick a
rail that can actually exhibit it, weighted by rail popularity. The global mix
is now hit directly and the rail split falls out as a consequence. That is also
the more honest causal direction — a merchant's failure mix is a property of
their book, not of a rail chosen in advance.

### C-005 — Every high-value invoice failed authentication
**Severity: medium. Cost: ~10 minutes.**

`afa_satisfied` defaulted to false, so every SMB invoice at or above the ₹15,000
AFA threshold failed with `AFA_REQUIRED` regardless of the cause it was built
for. `AFA_REQUIRED` ran 4.8 points hot.

The modelling error: authentication for a high-value recurring debit is arranged
as part of normal billing, exactly like the pre-debit notice, which the
generator already handled correctly. Only the case built to *lack* it should
lack it. Fixed by mirroring the notice logic.

### C-006 — Issuer outages never landed in the week invoices were due
**Severity: medium. Cost: ~10 minutes.**

Issuer degradation windows were scattered uniformly across a 45-day horizon, but
invoices fall due in the first week. `issuer_flaky` cases looked for a degraded
issuer to sit on, usually found none, and fell through to another cause.
`ISSUER_UNAVAILABLE` measured 2.6% against 12%.

Fixed by guaranteeing that the three largest issuers each carry a degradation
window overlapping the due-date window. Correlated failure across many accounts
at one bank on one day is the entire basis for the issuer-health signal, so
without this the fleet-level diagnosis had nothing real to detect.

### Result

Relabelling fell from **18.2% to 0.4%**; worst-case drift from 17 points to 3.6,
which is within sampling noise at n=500. Structurally unrecoverable value landed
at 15.7%, inside the intended 15–27% band.

The drift table is now permanent output of `npm run gen` and the bounds are
asserted in `tests/world.test.ts`, so a future change that quietly breaks the
causal chain fails the build rather than producing a flattering batch.

---

## 2026-08-25 · Day 3

### C-007 — The naive baseline was accidentally a strawman
**Severity: high (it would have inflated the headline). Cost: ~15 minutes.**

`naive-retry` served a pre-debit notice whenever `retry_debit` was unavailable,
without checking *why* it was unavailable. A case blocked by `RETRY_MIN_GAP`
therefore got a fresh notice on every wake: **1,949 notices against 787 retries.**

Nothing failed. The run was clean, the recovery number was unchanged, and the
only visible symptom was a message count that looked slightly high in a column
I had added an hour earlier for a different reason.

It matters because the baseline is what the agent gets measured against. An
inflated baseline cost makes the agent's efficiency look better for a reason
that has nothing to do with the agent. Fixed by serving a notice only when
`PREDEBIT_NOTICE` is the rule actually named in the exclusion list — which is
only checkable because the gate records *which* rule blocked *which* action.
The "why not" logging paid for itself before the agent existed.

Notices fell to 269 and cost per ₹100 recovered from 0.85 to 0.81. There is now
a regression test asserting notices stay below retries.

### C-008 — Compliance notices were counted as collections pressure
**Severity: medium. Cost: ~15 minutes.**

Pre-debit notification is legally required before an e-mandate debit. It was
being recorded as an ordinary contact, so it consumed the payer's contact
budget, counted toward nudge fatigue, and would have fed the goodwill penalty
once that was wired in.

The perverse consequence: a policy that skipped a notice it was obliged to send
would score as more restrained than one that sent it. Added a `compliance` flag
to the contact record and split the metric into `contacts_total` (collections)
and `notices_total` (compliance). Fatigue and goodwill now count only the former.

Worth stating in the write-up because it is a genuine modelling judgement rather
than a bug: a mandatory notice is not pressure, and a metric that treats it as
pressure will reward non-compliance.

---

## 2026-08-26 · Day 4

Day 4 built the gate out to all 28 rules, added the tuned `static-policy`
ablation and the truth-aware `oracle`, and produced the first derived
recoverable ceiling. Five of the six problems below were caught by
instrumentation that had been built for a different reason — which is now a
pattern rather than a coincidence.

### C-009 — 73 of 1,000 audit records failed their own hash check
**Severity: high. Cost: ~50 minutes.**

The first real run of the chain-verification guard refused to report metrics:
73 events rehashed to something other than their stored hash. A tampered or
broken audit trail is worse than no audit trail, because it still looks
credible, so the run correctly aborted.

It was not tampering. Exclusions built on the stop path were constructed as
`{action_type, rule_id, channel, detail}` while `block()` built them as
`{action_type, rule_id, detail, channel}`. Zod rebuilds objects in
schema-declaration order when it parses, `JSON.stringify` is key-order
sensitive, and so an event hashed before the round-trip disagreed with the same
event hashed after it.

Fixed with `src/domain/canonical.ts` — a canonical JSON serialiser that sorts
keys and drops `undefined` — now shared by `hashEvent` and `observationHash`.
The lesson worth keeping: any hash over a structure that crosses a
serialisation boundary needs a canonical form, and the bug is invisible until
something actually verifies.

### C-010 — The ladder made it impossible to give up
**Severity: high. Cost: ~20 minutes.**

1,680 of 13,018 decisions were being rejected by the gate, all of them the same
shape: `stop_terminal` refused by `LADDER_MONOTONIC` because closing a case
reads as a jump from rung 0 to rung 7. Policies were literally unable to stop,
and the oracle burned its step budget waiting for permission to give up.

De-escalation is never an escalation. `stop_terminal` and `handoff_human` are
now exempt from the ladder check. Worth noting that the rule was correct in
spirit and wrong in scope — it is the kind of bug that only appears once
something actually tries to obey the rule.

### C-011 — Refused choices were being counted as harm
**Severity: medium. Cost: ~15 minutes.**

The metric lumped gate rejections in with harm events, so a policy proposing an
action the gate then refused scored as if it had breached a rule. That is
backwards: a refusal is the gate *working*. Harm is a breach that reached the
world.

Split into `gate_rejections` (a quality signal about the policy) and
`harm_events` (any nonzero value invalidates the run). Only the latter feeds
`harm.clean`.

### C-012 — The oracle was beaten by a heuristic, three times
**Severity: high. Cost: ~2 hours.**

The `OracleViolationError` invariant — fail any run where an observation-only
policy recovers more than the truth-aware oracle — fired three separate times,
each a different incompleteness in the search:

1. `static-policy` recovered ₹5,96,936 against a ceiling of ₹5,95,795. The
   invariant had been designed but not yet wired into the CLI, so the first fix
   was to actually enforce it. The cause: `notify_soft` mutates latent state
   when a payer tops up, so an intervention *creates* recoverability that a
   fixed-world probe cannot see.
2. After adding intervention probing the ceiling fell to ₹5,70,702, because the
   delivery probe indexed the RNG stream by non-compliance contacts while the
   runner indexes it by total contacts. The probe and the world disagreed on
   any case that had been served a notice.
3. After fixing that and probing across the remaining attempt-seq budget, the
   ceiling was ₹5,76,238 and still lost.

The resolution is a design decision rather than a patch: the oracle now takes a
fallback policy and defers to it whenever the exact search has nothing to
offer, so the ceiling is `max(exact search, tuned rules)` per decision. It
remains a lower bound on the true optimum, which is the safe direction for a
denominator — it can only make our own policies look worse.

### C-013 — A twelve-hour retry step stranded cases at an hour they could never act
**Severity: high. Cost: ~1.5 hours. Found by a test, not by a run.**

The new oracle tests asserted the ceiling invariant on a second failure mix,
and it failed immediately: on `mix_c`, `static-policy` recovered ₹1,56,451
against a ceiling of ₹1,32,850. The default mix had passed, so this would have
surfaced on day 8's sensitivity sweep instead, with a week's results built on
top of it.

The audit trail showed the oracle waiting nineteen simulated days on a case it
had already solved, alternating between exactly two timestamps: 07:30 and 19:30
IST. Both are outside the 09:00–19:00 contact window. No channel was ever
permitted, so the required pre-debit notice could never be served, so the debit
was never unblocked, and the invoice aged out while the policy knew precisely
which presentment would have settled it.

Two independent causes:

- The oracle returned `wait until <now>` when it knew the winning time was now
  but the gate would not let it act — a decision that cannot advance anything.
- The runner's stall guard then advanced the clock by a flat 12 hours. Twelve
  divides twenty-four, so the case revisited the same two wall-clock times for
  the rest of its life. A time-of-day rule it failed at those two times, it
  failed forever.

Fixed at the source rather than in the guard: the gate now reports
`contact_window_opens_at`, so any policy blocked only by the clock can wait for
the clock instead of guessing an offset — including the LLM agent on day 6,
which gets it for free in the permitted set. The oracle no longer emits a wait
that cannot advance. The stall guard's step is now seven hours, coprime with
twenty-four, so a stalled case walks the whole clock instead of resonating with
it; and stalls are counted into `stalled_steps` rather than absorbed silently,
because a stranded case is exactly the kind of failure that hides.

Stalls across all four policies are now zero, which is the real confirmation:
the guard is defensive, not load-bearing.

The corrected ceiling is ₹9,13,994 rather than ₹8,27,081 — 10.5% higher. Every
"percent of recoverable" figure had been measured against an understated
denominator, which flattered every policy in the table.

### C-014 — I broke a deliberate wait while fixing the stall
**Severity: medium. Cost: ~30 minutes. Self-inflicted, caught by re-measuring.**

The first version of the C-013 fix let `static-policy` pull *any* wait forward
to the moment contact hours reopened. Its recovery promptly dropped from
₹5,96,937 to ₹5,18,836 and I nearly attributed that to a re-tune that had
happened in the same edit.

Decomposing the two changes showed the re-tune was worth 0.07% either way — the
regression was entirely mine. A wait aimed at the payer's next salary credit is
a *plan*; pulling it forward to 9am tomorrow just burns a presentment into an
account that is still empty. The window-wait now applies only when the target
has already passed, i.e. when the wait is a stall rather than a plan.

Two things worth keeping from this. First: when two changes land together and
the number moves, decompose before explaining — the obvious culprit was the
wrong one. Second: the grid search accepted a parameter change worth 0.04% on
three training seeds, which is well inside run-to-run variation. Held-out seeds
split 4–1 in its favour, so it stands, but a search that accepts differences
that small is fitting noise and needs an acceptance margin before day 8.

---

## 2026-08-26 · Day 5

### C-015 — The audit trail did not fit in the repository
**Severity: medium. Cost: ~40 minutes.**

Day 4 ended with a working hash-chained ledger and a problem I had not
anticipated: one 500-case run writes 63 MB of audit events, of which
`audit.naive-retry.jsonl` alone is 34 MB. The submission's central claim is
that there is an audit trail a reviewer can check, and the trail was too big to
commit.

The tempting fixes were all quiet compromises. Commit a sample of cases, and
the trail no longer covers the run the numbers come from. Drop the `excluded`
array, and the records shrink by most of their volume but stop being able to
answer "why not" — which is the thing that makes them worth having. Commit
nothing and describe the format, and the claim reverts to trust-me.

Gzip was the boring answer and the right one: this JSONL is enormously
repetitive, so it compresses about 20:1, and the four ledgers are 4.1 MB
compressed. `Ledger` writes through a gzip stream when the path ends in `.gz`,
`readLedgerFile` handles either form, and the complete trail is committed with
nothing sampled.

Two things worth recording. First, the fix nearly introduced a worse bug:
ending a gzip transform is not the same as the underlying file being flushed,
so an early `close()` truncates the ledger — and a truncated chain fails
verification in a way indistinguishable from tampering. `close()` now waits on
the file stream, and a test asserts the compressed and plain forms contain
identical hashes. Second, there is now a test that tampering is still caught
*through* the compressed form, because compression must not become somewhere an
edit can hide.

### C-016 — A reproducibility claim I had to walk back
**Severity: low. Cost: ~5 minutes. Nobody caught this but me.**

The day-4 checkpoint README said the ledgers "regenerate byte-identically from
the seed". They do not. Every record carries `ts_wall`, the real clock at the
moment it was written, so two runs at the same seed produce different bytes.

What is actually true is stronger and more precise: `ts_wall` is deliberately
excluded from the hash, so a re-run reproduces every hash and every number
exactly while the files differ. The claim is now stated that way. It is a small
thing, but "byte-identical" is the kind of overclaim a payments engineer would
test in thirty seconds, and finding it false would cast doubt on every other
claim in the repo.

### C-017 — I built a signal that could not fire, and only found out by measuring it
**Severity: medium. Cost: ~1 hour. Found by rendering a prompt and reading it.**

Day 6 wires the agent up, and the first thing I did before spending money on
the API was print a real prompt and read it as if I were the model. Three
things were wrong with one line of it, in ascending order of seriousness.

The line was `ISSUER  ISSUER_07 · observed health: ${obs.issuer_health}`.

First, `issuer_health` is an object, not a number, so on every issuer the
tracker actually had data for, the model was being handed the string
`[object Object]`. It happened to render `null` in the case I looked at, which
is why the bug had survived: the failing branch was the one I never saw.

Second, that `null` was itself misleading. Null means "too little traffic
through this issuer to say anything", and printing the literal word `null`
invites a reader — human or model — to treat absence of evidence as evidence.

Third, and the one that mattered: once I fixed the rendering and went looking
for a case that exercised the non-null branch, I could not find one that said
anything. So I measured it properly, across every committed batch:

| batch | prompts rendered | with issuer data | degraded | failure_rate values seen |
|---|---|---|---|---|
| main | 12,652 | 62 | 0 | 100% |
| main_mix_b | 13,612 | 255 | 0 | 100% |
| main_mix_c | 10,156 | 50 | 0 | 100% |
| stress | 51,797 | 5,747 | 0 | 100% |

Every reported failure rate, across 88,217 rendered prompts, was exactly 100%.

The reason is structural and, in hindsight, obvious. `IssuerHealthTracker`
compared an issuer's failure rate in the last six hours against its own rate
over the trailing fortnight. But the only presentments it can ever see are the
ones in a **recovery queue**, and a recovery queue is made of failures by
definition. The baseline sat at 100% for every issuer, no issuer could exceed
it, and `degraded` was a flag with no reachable true branch.

I changed the baseline to the *other* issuers in the same window, which is both
correct and the comparison a merchant actually makes: "everything is failing"
is a queue, "ISSUER_04 is failing while the other nine are not" is a bank
having a bad afternoon. That fix is right, and it still does not fire — because
in this world every issuer in the queue is at 100% simultaneously.

There were three ways out and only one honest one.

I could have fed the world successful presentments so a real baseline existed.
That means editing the world model on day 6 to make an agent input look better,
which is precisely the move the frozen-world hash test exists to prevent, and I
am not going to defeat my own guardrail the first time it costs me something.

I could have left the line in. A prompt that says "100% of 9 attempts failed"
on 62 of 12,652 cases, when that number is an artifact of how the queue was
seeded, is a constant dressed up as a signal — worse input than no input, and
an overclaim if the README ever said "issuer degradation detection".

What I did instead: the tracker keeps the corrected peer baseline, the prompt
renders the health clause **only when it discriminates** (when the issuer
differs from its peers by 10 points or is outright degraded), and today that
means the model sees an issuer id and nothing else. Two tests pin both halves —
one proves degradation fires on a stream that contains it, one proves it stays
false on an all-failure stream and says why.

The general lesson is the one this project keeps re-learning: an instrument is
not working because it compiles and its tests pass. It is working when you have
looked at what it actually emitted on real data. I have now been saved four
separate times by printing something and reading it.

### C-018 — The agent failed to beat the rules engine, and the reason was in my prompt
**Severity: high. Cost: ~2 hours. This is the day-6 result.**

First honest five-policy run on the 500-case main batch, prompt v1,
gemini-3.7-flash, 2,736 decisions, zero API errors, zero gate rejections:

| policy | recovered | of ceiling | net | cases | atts | msgs | esc |
|---|---|---|---|---|---|---|---|
| static-policy | ₹5,96,091.90 | 65.2% | ₹5,88,407.77 | 185 | 1215 | 436 | 28 |
| agent (v1) | ₹5,85,644.72 | 64.1% | ₹5,69,527.56 | 204 | 1081 | 732 | 99 |

The agent did not beat the rules engine. It is 1.8% behind on gross and 3.2%
behind on net.

**How much of that is real:** almost none of it, and this correction was added
after the fact. Both policies ran the same 500 cases, so the comparison is
paired, and resampling the per-case difference gives:

```
gross -₹10,447.18  95% CI -₹1,87,631.35 .. +₹1,69,982.79
net   -₹18,880.21  95% CI -₹1,96,765.26 .. +₹1,60,724.57
the agent came out behind in 54.7% of resamples
```

54.7% is a coin flip. Only 89 of 500 cases reached different outcomes at all,
and those differences concentrate in a few dozen high-value invoices whose
outcomes are lumpy, so a 500-case batch cannot resolve a two-percent difference
in recovered value. "The agent lost" — how this entry was originally written —
was an overclaim in the pessimistic direction, and no more defensible than the
optimistic kind.

What is *not* noisy is the behavioural evidence below. Those are counts over
thousands of decisions: 500 foregone retries, 99 escalations against 28, a 53:2
ratio of authentication requests to presentments. Those defects are certain even
though their price is not, and they are the reason to change the prompt.

The demo batch had said the opposite: 60 cases, agent at 99.97% of ceiling,
comfortably ahead of static-policy. That is the entire argument for not
believing a small batch, and I am glad I wrote the number down as suspicious
before the big run rather than after.

**Where the money went.** The agent recovered MORE cases than static-policy
(204 vs 185) and LESS money. It beat static-policy in every invoice size band
except the largest — and that band is 73% of all value at risk:

| band | n | at risk | static | agent | oracle |
|---|---|---|---|---|---|
| ₹0–₹500 | 252 | ₹68,898 | ₹28,356 | ₹29,348 | ₹38,572 |
| ₹500–₹2,000 | 142 | ₹1,46,858 | ₹59,045 | ₹69,535 | ₹95,609 |
| ₹2,000–₹10,000 | 41 | ₹2,46,459 | ₹77,487 | ₹88,984 | ₹1,27,980 |
| **≥ ₹10,000** | **65** | **₹12,44,877** | **₹4,31,204** | **₹3,97,778** | **₹6,51,833** |

Twelve AFA_REQUIRED cases worth ₹2,10,403 were recovered by static-policy and
lost by the agent. AFA — additional factor of authentication — is what a large
recurring debit needs before it can be presented, and in this world one
`request_afa` satisfies it immediately.

The audit trail settles what happened, on CASE-00005, a ₹19,369 invoice:

```
08-05T09:00 retry_debit=no  [AFA_THRESHOLD: 1936913 is at or above the 1500000 threshold and is not authenticated]
08-05T09:00   -> request_afa
08-05T21:00 retry_debit=YES   -> wait
08-06T04:00 retry_debit=YES   -> wait
08-06T10:00 retry_debit=YES   -> request_afa
08-06T22:00 retry_debit=YES   -> wait
08-07T04:00 retry_debit=YES   -> request_afa
08-07T16:00 retry_debit=no  [MANDATE_VALIDITY_WINDOW: mandate valid_till 2026-08-07T08:00:00.000Z has passed]
08-07T16:00   -> handoff_human
```

The gate offered `retry_debit` five consecutive times. The agent waited, asked
for authentication it already had, waited again, and handed a ₹19,369 invoice
to a human eleven hours after the mandate expired. Across all 18 AFA cases it
sent 53 authentication requests and made 2 presentments.

**This generalises.** Two counts, measured across the whole run:

- The agent waited while `retry_debit` was on the permitted list **500 times
  across 251 cases, ₹10,04,775 of invoice value**. Static-policy did this zero
  times.
- The agent escalated to a human 99 times against static-policy's 28, on seven
  failure codes static-policy never escalates at all. At ₹150 a handoff that is
  ₹14,850 against ₹4,200, and every handoff also closes the case to automation.

**The cause was mine, not the model's.** Prompt v1 taught restraint and never
priced it. It said a failed retry "costs a gateway fee and consumes one of the
few attempts this invoice is allowed", and it said "recovering nothing is an
acceptable outcome... stop or escalate". Both true. Neither quantified. A model
told to be careful, with no sense of what care costs, is careful about a 50
paise retry fee while a ₹19,369 mandate expires underneath it.

It also never mentioned AFA_REQUIRED once, in a list that explained six other
failure codes in detail.

Prompt v2 makes three factual additions, none of them a compliance rule and all
of them things a real merchant knows about their own business: what a
presentment, a message and a handoff actually cost, in rupees, against the size
of the invoice; that AFA is unblocked by one request and sits behind an expiring
mandate; and that escalation is not a free way to be careful.

The honest caveat, stated before the numbers rather than after: this is tuning
against the batch the result is measured on. The guard is the day-8 plan — five
seeds and three failure mixes — and a v2 that only wins on main-seed-42 has not
actually won anything.

### C-019 — A retry policy that turned one exhausted quota into 13,565 wasted requests
**Severity: high. Cost: 31 minutes of wall clock and most of a day's quota.**

The prompt-v2 re-run finished in thirty-one minutes and reported this:

```
  ran agent          1877991ms  6719 ledger events
    0 cached, 0 live call(s) at concurrency 24, 10852 retried, 2713 error(s)
    !! 2713 decision(s) fell back to static-policy; this run is NOT a clean agent result
```

Every decision failed. The agent row in the results table came out
byte-identical to static-policy, because that is exactly what it was.

The cause was a daily quota:

```
"quotaMetric": "generativelanguage.googleapis.com/generate_requests_per_model_per_day",
"quotaValue": "10000",
"retryDelay": "33845s"
```

Ten thousand requests per model per day on the free tier, and a reset 9.4 hours
away. Three separate mistakes of mine turned that into a thirty-one minute
mystery.

**1. My retry policy made the problem five times worse.** A 429 is two different
events wearing one status code. Per-minute throttling clears in seconds and
retrying is right. A daily quota does not clear for hours, and every retry
spends another request against a quota that is already gone. My backoff capped
at sixty seconds and tried four more times per decision, so 2,713 failed
decisions became 13,565 wasted requests — and a large part of the quota that
the *first* half of the run was still legitimately using.

The fix is to read the body rather than the status. Google returns the wait in a
`RetryInfo` detail, and a wait measured in hours is a wall, not a delay.
`QuotaExhaustedError` is now thrown immediately and never retried.

**2. The fallback was silently producing a fake result.** Falling back to
static-policy for one unlucky decision is resilience. Falling back for all 2,713
is not — it publishes a row labelled "agent" whose every number belongs to the
rules engine, which is worse than crashing because it looks like a result. There
is now a breaker: twenty consecutive failures abandons the run. A broken run
should fail loudly, not publish a lie.

**3. My own tooling would not tell me what went wrong.** Thirty-one minutes of
failure and the operator saw `2713 error(s)` and no reason. The error text
existed — `ProviderError` carried the full body — and eval simply never printed
it. `AgentStats` now carries `last_error` and eval prints it under the warning.

The irony is not lost on me: this project is built around the claim that a
system should be able to explain its own refusals, and I shipped a client that
retried into a wall 10,852 times without ever saying what the wall was.

Two tests now pin the new contract: an intermittent failure still falls back and
completes, and a persistently dead API aborts rather than quietly returning
static-policy's numbers under the agent's name.

### C-020 — The replay didn't, and the test that should have caught it was too small
**Severity: high. Cost: ~2 hours. Found by running the command the README tells a reviewer to run.**

After reverting the unmeasured v2 prompt, I ran `npm run eval -- --batch main`
to check the repo still reproduced its own committed numbers. It didn't. It
started making live API calls, hit the exhausted quota, and died.

That is the repo's central claim failing: clone it, run one command, get the
committed results back without an API key.

**Root cause.** `issuer_health` is the one field in a case observation that
other cases can change — it is computed from the fleet's shared decline stream.
It was read *inside* each concurrent task, so at concurrency > 1 the value
depended on which other cases in the same wave had already presented. That made
`observation_hash` a function of network latency. The hash is part of the
decision cache key, so every lookup on a re-run missed.

Measured, with static-policy on the 500-case batch:

| | pre-fix | post-fix |
|---|---|---|
| same run twice at concurrency 1 | identical | identical |
| concurrency 1 vs concurrency 24 | **different** | identical |
| reproduces the committed ledger | true (at c=1) | n/a, hashes moved |

That table also explains why only the agent broke. Every deterministic policy
runs at concurrency 1, so their observations never drifted; the agent is the
only policy that raises it, and it ran at 24.

**Two wrong turns worth recording.** I first blamed the concurrency refactor
wholesale, then talked myself *out* of the issuer-health explanation on the
grounds that health is non-null in only 62 of ~12,650 observations — too rare,
I reasoned, to be the first miss. That reasoning was wrong: one differing
observation diverges that case's decision, which diverges its history, and every
later observation on that case differs too. 62 seeds of divergence cascade
across a 500-case batch easily. The fix is to measure rather than to reason
about it, which is what the table above finally did.

**The fix.** Issuer health is now read for a whole wave up front, in the wave's
own sorted order, before any decision in it runs. The observation is a function
of the seed and the simulated clock alone, which is what it always claimed to be.

**The test that should have caught this.** `tests/concurrency.test.ts` already
asserted that concurrency 1 and 8 produce identical per-case results and
identical metrics. It passed throughout — because *no policy reads issuer
health*, so the drift never reached a metric. The property that mattered was one
nobody was asserting: that the observation hashes themselves are stable.

There is now a test for exactly that. It also had to be made bigger: at 50 cases
issuer health is null everywhere, so the assertion was vacuous and passed with
the bug reinstated. At 400 cases it fails without the fix and passes with it,
which is the only version of that test worth having.

The cost is that the fix changes observation hashes, so the 2,849 recorded v1
decisions no longer match and have to be re-recorded once quota resets. The
checkpoint README says so plainly rather than leaving a command in it that
doesn't work.

### C-021 — I nearly forged my own evidence
**Severity: high, and it never shipped. Cost: 20 minutes.**

While debugging C-020 I wrote a scratch script that ran the batch with a stub
completer to count cache misses. `makeAgent` defaults its cache to the committed
one at `.cache/llm`, and I did not override it. The stub's decisions were
written there: 5,500 fabricated entries, in the file the README describes as
real recorded model decisions, structurally indistinguishable from the genuine
ones.

I caught it only because an unrelated count came out wrong — the cache reported
8,349 entries where it should have had 2,849. It was never committed, and
`git checkout` restored it.

This is the worst near-miss of the project so far. Every claim in the repo rests
on the recorded decisions being real, and I had a workflow in which a debugging
script could quietly overwrite them.

Two guards now. `makeAgent` throws if a caller injects a completer without also
injecting a cache — an injected completer means a test or a diagnostic, and
neither may touch the committed cache. And a test asserts that every committed
entry carries a non-zero token count, since a decision that cost nothing did not
come from an API.

The general lesson is the one that keeps recurring: the guardrail has to be
structural. I *knew* not to point a stub at the real cache, and I did it anyway,
because knowing is not a mechanism.

### C-022 — Salvaging ₹457 of recorded decisions instead of paying twice
**Severity: none, it worked. Worth recording as the cheapest good decision of the day.**

The C-020 fix changed what a case observes, which changed `observation_hash`,
which is part of the decision cache key. The obvious consequence was that 2,736
recorded decisions — ₹457 of real API spend — were orphaned and would have to be
bought again.

Before paying, I checked how much had actually changed. Of 2,736 decision
points, **2,671 hashed identically** and only **65 moved**. That is the expected
number: issuer health is non-null in roughly 62 of the run's observations, and
those are exactly the ones the fix touches. The measurement that had confused me
earlier — a replay missing almost everything — was the cascade from those 65,
not 2,736 independent misses.

So `npm run migrate-cache` replays the committed audit trail decision-for-
decision and copies each recorded model output verbatim under the corrected key.
It invents nothing. Its safety condition is the permitted set: a decision is
only transferable if the gate offers the model the same choice it originally
chose from, and the migration aborts on any mismatch rather than silently
re-labelling a judgement as an answer to a different question. Zero of 2,736
mismatched.

Result: 65 entries written, no API calls, and `npm run eval -- --batch main`
now reproduces the committed checkpoint in 1.7 seconds — 2,736 cached, 0 live.

The general point is that "the cache is invalid, re-run it" was the expensive
reflex, and thirty seconds of counting showed 97.6% of it was fine.
