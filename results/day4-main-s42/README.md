# Day-4 checkpoint run

`npm run eval -- --batch main --seed 42`, 500 cases, mix_a, on 2026-08-26.
This is the run the day-4 numbers in `docs/CHALLENGES.md` come from.

`metrics.json` and the per-case results are committed. The four audit ledgers
are **not**: they are 63 MB for this run alone, dominated by
`audit.naive-retry.jsonl` at 34 MB. They regenerate byte-identically from the
seed, and day 5 adds `npm run replay` for reading a single case's chain.
Committing an audit trail of a submittable size is a day-5 problem.

| policy | recovered | of face | of ceiling | net | cases | atts | msgs | notices | refused | esc | harm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| do-nothing | ₹0.00 | 0.0% | 0.0% | ₹0.00 | 0 | 500 | 0 | 0 | 0 | 0 | clean |
| naive-retry | ₹1,13,336.00 | 6.6% | 12.4% | ₹1,12,430.44 | 114 | 1264 | 0 | 268 | 0 | 0 | clean |
| static-policy | ₹5,96,091.90 | 34.9% | 65.2% | ₹5,88,407.77 | 185 | 1215 | 436 | 268 | 0 | 28 | clean |
| oracle | ₹9,13,994.17 | 53.5% | 100.0% | ₹9,05,407.69 | 273 | 994 | 411 | 235 | 0 | 28 | clean |

Value at risk ₹17,07,092.23. Structurally unrecoverable ₹2,68,856.39 (15.7%).
Recoverable ceiling ₹9,13,994.17, derived by oracle search, not asserted.

The ceiling is a lower bound on the true optimum (see D-011), so
"of ceiling" is if anything harsh on the policies above it. `static-policy` is
a tuned ablation fitted on seeds 101–103, disjoint from the seed reported here.
