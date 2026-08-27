# The prompt-by-model grid

Per-case results and metrics for every configuration in `docs/EXPERIMENTS.md`
other than the headline run, which lives in full — audit ledgers included — at
`results/checkpoint-main-s42-agent-v1/`.

| directory | batch | prompt | model | recovered |
|---|---|---|---|---|
| `v1-flash-lite` | main | v1 | gemini-3.1-flash-lite | ₹3,98,305.51 |
| `v2-flash-lite` | main | v2 | gemini-3.1-flash-lite | ₹5,43,879.61 |
| `tune-v1` | tune | v1 | gemini-3.1-flash-lite | ₹19,039.63 |
| `tune-v2` | tune | v2 | gemini-3.1-flash-lite | ₹53,156.01 |
| `tune-v3` | tune | v3 | gemini-3.1-flash-lite | ₹21,085.54 |

## What is here

For each configuration: `metrics.json`, per-case outcomes, and the hash-chained
audit trails for the agent and for static-policy, so every counter table in
`docs/EXPERIMENTS.md` can be checked without running anything:

```bash
npm run behaviour -- --runs results/grid/v1-flash-lite,results/grid/v2-flash-lite
npm run behaviour -- --runs results/grid/tune-v1,results/grid/tune-v2,results/grid/tune-v3 --batch tune
```

The ledgers for the three baselines that never vary between these runs
(do-nothing, naive-retry, oracle) are omitted, since they are identical to the
copies in `results/checkpoint-main-s42-agent-v1/` and regenerate from the same
seed. Any full run rebuilds in about two seconds:

```bash
npm run eval -- --batch main --prompt v2 --model gemini-3.1-flash-lite
```

Note that `tune` is a **diagnostic** batch. It over-weights the failure modes
from C-018 to make them measurable on thirty cases, and `eval` prints a banner
saying so. Nothing measured on it is a recovery result.
