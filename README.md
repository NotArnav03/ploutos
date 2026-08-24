# Vasooli

**A bounded recovery agent for failed recurring payments on Indian rails.**

Built for the Razorpay AI Buildathon 2026, Track 03 — AI Revenue Recovery.

> 🚧 **Day 1 of 10.** This README is a stub. No results are claimed yet, because
> no evaluation has been run yet. Every number that eventually appears here will
> come from a committed run under `results/`, reproducible with a single command.
> Until then this file describes intent, not achievement.

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
diagnoses, it chooses among already-permitted options, it writes the customer
copy and the handoff summary. An LLM choice outside the permitted set is
rejected and recorded as a violation rather than executed — and the rate at
which that happens is a reported number, not a hidden one.

## Status

| Day | Deliverable | State |
|-----|-------------|-------|
| 1 | Domain schemas, failure taxonomy, rules registry, boundary test | ✅ |
| 2 | Generator, latent state, simulator, frozen world model | — |
| 3 | `do-nothing` + `naive-retry` baselines, metric harness | — |
| 4 | Policy engine, `static-policy` + `oracle` baselines | — |
| 5 | Hash-chained audit ledger, `npm run replay` | — |
| 6 | LLM decision service | — |
| 7 | Tuning, promise-to-pay, message copy | — |
| 8 | Adversarial cases, harm metrics, sensitivity analysis | — |
| 9 | Razorpay test-mode adapter, compliance verification, diagram | — |
| 10 | Final run, results, video | — |

Full plan in [`docs/PLAN.md`](docs/PLAN.md). Decisions in
[`docs/DECISIONS.md`](docs/DECISIONS.md). Things that broke, in
[`docs/CHALLENGES.md`](docs/CHALLENGES.md).

## Honesty notes

These are stated up front rather than in a footnote, because they change how
every number here should be read.

- **Outcomes are simulated.** There is no production payment data in this
  project and none is claimed. A hand-written, seeded simulator resolves whether
  a given intervention would have worked, from latent state the agent cannot
  see. Its rules are in the repo and were committed before the agent existed.
- **The failure codes are ours.** `config/failure_taxonomy.yaml` defines
  fourteen codes, each naming the real-world category it is modeled on. They are
  not a claim of parity with any payment service provider's live code set.
- **The failure mix is an assumption.** Three different mixes ship and the
  headline runs under all three, so a result that only survives under one is
  visible as such.
- **Compliance bounds are configurable rules modeled on published e-mandate
  guidance.** They are not a claim of regulatory compliance. Rules whose
  parameter we invented are marked `unverified` in the registry and listed in
  the generated report.
- **No blockchain, no crypto, no token.** The audit ledger is hash-chained for
  tamper-evidence — a Merkle-style integrity chain, the same idea as a
  tamper-evident log file. Nothing here settles on a chain.

## Setup

```bash
npm install
npm test
npm run typecheck
```

No API key is needed to run the tests or, once it exists, the evaluation — agent
decisions replay from a committed cache.

## Licence

MIT. Sole author: Arnav.
