# The committed run

`npm run eval -- --batch main --seed 42` — 500 cases, mix_a, seed 42.
Last regenerated 2026-08-26 (day 5). This is the run every number quoted in
`README.md` and `docs/` comes from; there are no figures in this repo that were
typed by hand or carried over from a run that no longer exists.

## Results

Value at risk **₹17,07,092.23**. Structurally unrecoverable **₹2,68,856.39**
(15.7%). Recoverable ceiling **₹9,13,994.17**, derived by oracle search rather
than asserted by the generator.

| policy | recovered | of face | of ceiling | net | cases | atts | msgs | notices | refused | esc | harm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| do-nothing | ₹0.00 | 0.0% | 0.0% | ₹0.00 | 0 | 500 | 0 | 0 | 0 | 0 | clean |
| naive-retry | ₹1,13,336.00 | 6.6% | 12.4% | ₹1,12,430.44 | 114 | 1264 | 0 | 268 | 0 | 0 | clean |
| static-policy | ₹5,96,091.90 | 34.9% | 65.2% | ₹5,88,407.77 | 185 | 1215 | 436 | 268 | 0 | 28 | clean |
| oracle | ₹9,13,994.17 | 53.5% | 100.0% | ₹9,05,407.69 | 273 | 994 | 411 | 235 | 0 | 28 | clean |

The ceiling is a **lower bound** on the true optimum (see D-011), so "of
ceiling" is if anything harsh on the policies measured against it.
`static-policy` is a tuned ablation fitted on seeds 101–103, disjoint from the
seed reported here. The agent lands on day 6 and is not in this table yet.

## What is in here

- `metrics.json` — every computed metric for all four policies.
- `cases.<policy>.jsonl` — one line per case: status, money, cost, counts.
- `audit.<policy>.jsonl.gz` — **the complete audit trail**, 27,173 hash-chained
  events across the four policies. Gzipped, because the four ledgers are 63 MB
  raw and 4.1 MB compressed; nothing is sampled or truncated.

## Checking it yourself

```
npm run replay -- --run results/checkpoint-main-s42 --verify
npm run replay -- --run results/checkpoint-main-s42 --case CASE-00002
```

The first re-derives every hash and checks every link in all four chains. The
second prints one case's decisions as a timeline: what the gate permitted, which
rule refused each thing it did not, what the policy chose and why, and what the
world did about it.

## On reproducing this

Re-running `npm run eval` with the same seed reproduces every **hash** and every
**number** here exactly. It does not reproduce the files byte for byte, because
each record also carries `ts_wall`, the real clock at the moment it was written.
`ts_wall` is deliberately excluded from the hash for exactly this reason — it is
reporting metadata, not part of what is being attested.
