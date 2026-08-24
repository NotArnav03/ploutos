# Decisions

Numbered, dated, and kept in the repo so a reviewer can see what was chosen
deliberately rather than by drift. Superseded decisions are struck, not deleted.

---

### D-001 — Track 03, sliced to failed recurring-debit recovery
**2026-08-25**

Track 03's bar is numeric, so success is knowable before submitting. Within it,
recurring-debit recovery is the only example direction where the money at risk
is a sum rather than a counterfactual, the failure carries diagnostic signal in
a code, and the lever set is wide enough to justify an agent at all.

Checkout-abandonment recovery was rejected because its denominator is invented.
B2B receivables was rejected because the only lever is "send a better message"
and whether a payer responds is unmodelable. Payment-degradation root cause was
rejected as a standalone deliverable because it diagnoses without closing the
loop — it is folded in as issuer-health input to retry timing instead.

---

### D-002 — TypeScript, not Python
**2026-08-25**

The work is orchestration, state machines and schema validation, not numerics.
Zod gives one schema definition doing double duty as runtime validation and as
the structured-output contract for the model. The Razorpay SDK is Node. The
"data work" is summing integers over a few thousand JSONL rows, which is not
pandas territory, and bootstrap CIs are twenty lines. Python would only win with
a hard dependency on sklearn or statsmodels, and there is none. With ten days,
the language-learning tax decides it.

---

### D-003 — Frozen world model, with a structural latent/observable split
**2026-08-25**

The central credibility risk is that we author both the data and the outcome
model and therefore grade our own homework. Three mechanisms answer it:

1. Ground truth lives in `src/world/latent.ts`. The agent sees only
   `CaseObservation`. `tests/boundary.test.ts` fails the build if `src/agent`,
   `src/policy` or `src/domain` ever imports `src/world`.
2. The simulator is hand-written, deterministic, seeded, and **committed before
   the agent exists**. Git history is the evidence for that ordering.
3. An `oracle` policy that does see latent state establishes the recoverable
   ceiling, so the headline is "X% of what was recoverable", not "X% of face
   value" — which would be unachievable and therefore meaningless.

Changing the world model after the agent exists requires re-running every
baseline, because the baselines would no longer have been measured in the same
world.

---

### D-004 — No voice channel in v1
**2026-08-25**

Hinglish voice recovery is the flashiest example direction and the worst
time-to-value: telephony integration, STT/TTS, latency handling, and it makes
the evaluation non-deterministic, which destroys the measurability the bar
rewards. The localisation signal is kept at a fraction of the cost through
`language_pref` and generated message copy. Enforced by rule `NO_VOICE`.

---

### D-005 — No blockchain, no crypto, no token, anywhere
**2026-08-25**

Stated explicitly because the audit ledger is hash-chained and that invites the
wrong reading. `prev_hash` → `hash` is a Merkle-style integrity chain, the same
idea as a tamper-evident log file. There is no chain, no consensus, no token and
no settlement layer in this project. The README says so in the same paragraph
that introduces the ledger.

---

### D-006 — Money is integer paise, everywhere
**2026-08-25**

Branded `Paise` type; a raw number cannot reach a money position without going
through `paise()` or `rupees()`. `rupees()` throws on sub-paise precision rather
than rounding it away, because a silent round is how a batch total drifts from
the sum of its invoices — the first thing a payments reviewer checks.

---

### D-007 — Our own failure codes, not imitations of real gateway codes
**2026-08-25**

`config/failure_taxonomy.yaml` defines fourteen codes, each carrying a
`modeled_on` field naming the real-world category it imitates. Inventing strings
that look like real Razorpay error codes would be a cosmetic gain and a
credibility catastrophe if a panelist recognised one and it was wrong. The
header of that file states the position plainly.

---

### D-008 — Razorpay's API sits behind an adapter and off the evaluation path
**2026-08-25**

Using their test-mode API is a plus, and depending on it is a risk the brief
itself warns against. One real test-mode flow behind `src/adapter`, gated by an
env var, with the transcript recorded and committed so it replays without keys.
The eval path never touches the network. Their MCP server is a mention, not a
dependency.

---

### D-009 — LLM decisions are cached by observation hash, and the cache is committed
**2026-08-25**

Otherwise "a runnable command that regenerates the results" costs money and
drifts on every run. Keyed on a hash of the observation plus the prompt version,
so a prompt change invalidates cleanly. Disclosed in the README with a
`--no-cache` flag documented, because an undisclosed cache would look like
hiding non-determinism.

---

### D-010 — Verification discipline on every compliance claim
**2026-08-25**

Each rule in `config/rules_registry.yaml` carries `verification.status`.
`unverified` means the shape is realistic but **the number is ours**. Rules are
enforced either way; the status governs what we are permitted to *claim*.

Until every rule a claim depends on is `verified` against a primary source, the
only sanctioned phrasing is: *compliance-bounded by a configurable rules
registry modeled on published e-mandate guidance*. The words "RBI compliant" and
"NPCI compliant" do not appear in this repo, the README, or the video.

Currently unverified and needing a primary source before day 9:
`PREDEBIT_NOTICE` (24h), `AFA_THRESHOLD` (₹15,000), `CONTACT_HOURS` (09:00–19:00),
`DND_SUPPRESSION` (channel scope). The remainder are merchant-policy parameters
that are ours to choose and are labelled as such.
