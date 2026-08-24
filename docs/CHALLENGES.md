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
