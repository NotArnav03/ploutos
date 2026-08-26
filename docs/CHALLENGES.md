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
