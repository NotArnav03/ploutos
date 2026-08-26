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

### D-011 — The ceiling is the oracle's result, and the oracle may consult a heuristic
**2026-08-26**

The recoverable ceiling is derived by searching the same simulator every other
policy runs against, never asserted by the generator. The search is exact where
it can be — presentment randomness is addressed by `(seed, case_id, purpose,
attempt_seq)` rather than drawn from a running stream, so probing a candidate
time returns the true outcome rather than a sample from a similar distribution.

Where the exact search comes up empty, the oracle defers to `static-policy`
rather than giving up. The ceiling is therefore `max(exact search, tuned rules)`
per decision. This is not elegant, and it is deliberate: a one-decision-deep
search cannot see that a nudge which fails today may be followed by one that
lands next week, and it twice produced a "ceiling" that a plain heuristic beat.

The resulting number is a **lower bound on the true optimum**, and it is
reported as such. That is the safe direction for a denominator — it can only
make our own policies look worse — and `OracleViolationError` fails any run in
which an observation-only policy beats it, so the bound cannot quietly rot.

### D-012 — The gate publishes when it will next allow a contact
**2026-08-26**

`computePermitted` returns `contact_window_opens_at` alongside the permitted
set. The gate already knows when contact hours reopen; without publishing it,
every policy has to guess an offset, and a guess that divides 24 hours strands
the case at an hour it is never permitted to act (see C-013).

This matters most for day 6: the LLM chooses from the permitted set, and "you
may not contact anyone right now, but you may at 09:00" is information it needs
in order to choose `wait` sensibly. Encoding it in the gate keeps that reasoning
deterministic and out of the prompt.

### D-013 — Escalated cases count as unrecovered
**2026-08-26**

A case handed to a human is money this system did not collect, so it scores as
unrecovered. A real merchant's team would recover some fraction of it; we have
no basis for that fraction and will not invent one.

The consequence is visible and should be stated plainly rather than hidden: the
parameter search drove `handoff_min_value_paise` above every invoice in the
batch — "never hand off" — because under this accounting a handoff is pure cost.
We keep the tuned value rather than hobbling the baseline for realism, since a
baseline weakened on purpose is precisely the strawman the ablation exists to
avoid. Every number in this project therefore measures **automated recovery
only**, and escalations are reported in their own column so the trade stays in
view.

### D-014 — The audit trail is committed in full, gzipped
**2026-08-26**

A 500-case run produces 27,173 audit events across four policies: 63 MB of
JSONL, dominated by `audit.naive-retry.jsonl` at 34 MB. That is too large to
commit, and the obvious responses were all bad ones — sample a few hundred
cases, drop the `excluded` array that makes the trail explanatory, or commit
nothing and ask a reviewer to take the ledger on trust.

JSONL of this shape compresses about 20:1, because every record repeats the
same rule ids and field names. The four ledgers are 4.1 MB gzipped, so the
complete trail is committed with nothing sampled and nothing truncated. The
`Ledger` writes through a gzip stream when the path ends in `.gz`, and
`readLedgerFile` handles either form, so `npm run replay` reads the committed
artifact and a fresh local run identically.

A test asserts that tampering is still detected *through* the compressed form,
because compression must not become a place an edit can hide.

### D-015 — `ts_wall` is outside the hash
**2026-08-26**

Every record carries both `ts_sim` (the simulated clock, which is what policy
decisions are made against) and `ts_wall` (the real clock when the record was
written). Only `ts_sim` is hashed.

This means a re-run at the same seed reproduces every hash and every number
exactly, while the files differ byte for byte. That is the honest arrangement:
`ts_wall` is reporting metadata about when a run happened, not part of what the
chain attests to. Hashing it would make the trail unreproducible for a reason
that has nothing to do with integrity, and the README says so rather than
claiming byte-identical reruns.

### D-016 — Issuer health is computed against peers, and shown only when it discriminates
**2026-08-26**

`IssuerHealthTracker` originally compared an issuer's recent failure rate to its
own trailing rate. That cannot work on a recovery queue, which is 100% failures
for every issuer by construction, so `degraded` had no reachable true branch —
measured at zero across 88,217 rendered prompts on four batches (C-017).

The baseline is now the other issuers in the same window. That is the correct
comparison and the one a merchant makes, and it is still computed entirely from
the merchant's own decline stream, so it stays observable and never touches
latent state.

The prompt renders the health clause only when the issuer differs from its
peers by ten points or more, or is outright degraded. In the committed batches
that is never, and the model correctly sees an issuer id with no health claim
attached. The alternative — printing a value that is always 100% — would be
feeding the model a constant and calling it a signal.

The obvious "fix" of adding successful presentments to the world so a baseline
exists was rejected. Editing the frozen world model to make an agent input look
better is exactly what the golden-hash test exists to prevent, and the first
time that guardrail costs something is the worst possible time to route around
it. If the world ever grows a full presentment stream, it will be for a reason
that is not "the agent's inputs looked thin".

### D-017 — Model spend is reported in dollars, beside the rupees, never inside them
**2026-08-26**

The agent costs money to think, and an agent that spends more on inference than
it recovers is not a recovery system. So `metrics.json` now carries
`inference_tokens_in`, `inference_tokens_out`, `inference_cost_usd` and
`inference_usd_per_lakh_recovered`, and every deterministic policy reports zero
— which is the point of the comparison, since the rules engine thinks for free.

Two choices worth writing down.

**Not converted into the rupee figures.** The mechanical costs in
`config/costs.yaml` are rupees a merchant pays a gateway. Inference is dollars
paid to a model vendor. Folding them together needs an exchange rate, which is
an unstated assumption inside a headline number, and the useful statement needs
no FX at all: "$X of model spend per ₹1,00,000 recovered" names both units.

**Summed off the decisions, not off a counter in the client.** Token counts come
from the audit records, so the figure is recomputable from the committed ledger
by anyone who clones the repo. That also required making a cache hit report the
tokens its decision cost when it was recorded — otherwise a replayed run reports
zero spend, and the cheapest-looking run would be the one that did no work. The
tokens were really spent, once; `cache_hit` on the record says it was not spent
again today.
