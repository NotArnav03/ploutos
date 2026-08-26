# Day-6 checkpoint — first measured agent run

500 cases, `main` batch, mix_a, seed 42. Prompt **v1**, `gemini-3.7-flash`,
2,736 model decisions, **zero API errors, zero gate rejections, harm clean**.

## The result

The agent **lost to the deterministic rules engine.**

| policy | recovered | of face | of ceiling | net | cases | atts | msgs | notices | refused | esc | harm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| do-nothing | ₹0.00 | 0.0% | 0.0% | ₹0.00 | 0 | 500 | 0 | 0 | 0 | 0 | clean |
| naive-retry | ₹1,13,336.00 | 6.6% | 12.4% | ₹1,12,430.44 | 114 | 1264 | 0 | 268 | 0 | 0 | clean |
| static-policy | ₹5,96,091.90 | 34.9% | 65.2% | ₹5,88,407.77 | 185 | 1215 | 436 | 268 | 0 | 28 | clean |
| **agent (v1)** | **₹5,85,644.72** | **34.3%** | **64.1%** | **₹5,69,527.56** | 204 | 1081 | 732 | 285 | 0 | 99 | clean |
| oracle | ₹9,13,994.17 | 53.5% | 100.0% | ₹9,05,407.69 | 273 | 994 | 411 | 235 | 0 | 28 | clean |

Value at risk ₹17,07,092.23. Structurally unrecoverable ₹2,68,856.39 (15.7%).
Model spend for the agent run: **$4.57**.

Down 1.8% on gross and 3.2% on net against a rules engine that thinks for free.
The full diagnosis — which invoices, which failure codes, and why — is
`docs/CHALLENGES.md` C-018. The short version: the agent waited while
`retry_debit` was permitted 500 times across 251 cases (₹10,04,775 of invoice
value) where static-policy did so zero times, and escalated to a human 99 times
against static-policy's 28. Both trace to a system prompt that taught restraint
without ever pricing it.

This is committed because it is the measured result, not because it is the
result I wanted. Prompt v2 exists and is not yet measured — see C-019 for why.

## What is in here

- `metrics.json` — every metric for all five policies
- `cases.<policy>.jsonl` — per-case outcome for all 500 cases
- `audit.<policy>.jsonl.gz` — the complete hash-chained audit trail, nothing sampled

## Verifying it

The audit trail, the metrics and the per-case results in this directory are the
real artefacts of the run and verify as they stand:

```bash
npm run replay -- --case CASE-00005 --policy agent --verify
```

**The recorded agent decisions in `.cache/llm` do NOT currently replay**, and
that is a defect, not a caveat. This run's agent executed at concurrency 24, and
at the time the issuer-health tracker was read inside each concurrent task - so
the observation handed to the model, and therefore the cache key derived from
it, depended on the order those tasks happened to finish. Re-running looks up
keys that were never recorded and falls through to live API calls.

The determinism bug is fixed (`docs/CHALLENGES.md` C-020) and the fix changes
observation hashes, so these decisions have to be re-recorded before
`npm run eval -- --batch main` replays this checkpoint offline. That re-record
is blocked until the daily API quota resets. Everything above was measured from
this run and none of it changes; what is missing is the offline replay path, and
this note stays here until it works.

`CASE-00005` is the ₹19,369 invoice discussed in C-018: the gate offered
`retry_debit` five consecutive times and the agent waited through all of them
until the mandate expired.
