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
