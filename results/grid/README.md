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

## Why the audit ledgers are not here

They are 4–5 MB apiece and they regenerate exactly, because the decisions that
produced them are committed in `.cache/llm/`. Any row rebuilds in about two
seconds with no API key:

```bash
npm run eval -- --batch main --prompt v2 --model gemini-3.1-flash-lite
npm run eval -- --batch tune --prompt v3 --model gemini-3.1-flash-lite
```

The headline run keeps its complete trail committed, because that is the one a
reviewer should be able to audit without running anything at all.

Note that `tune` is a **diagnostic** batch. It over-weights the failure modes
from C-018 to make them measurable on thirty cases, and `eval` prints a banner
saying so. Nothing measured on it is a recovery result.
