# Experiments

Every prompt and model variant that was measured, including the ones that made
things worse. A tuning log that records only the wins describes a straight line
that did not happen.

Every row is re-runnable:

```bash
npm run eval -- --batch main --prompt v2 --model gemini-3.1-flash-lite
npm run behaviour -- --runs <run-a>,<run-b> --batch main
```

All three recorded prompt-by-model pairs replay from the committed cache with no
API key and no network. The fourth was never finished — see the note at the end.

## The grid, on the 500-case main batch

Recovered value, and share of the oracle-derived ceiling of ₹9,13,994.17.
Static-policy, the hand-tuned rules engine, recovers **₹5,96,091.90 (65.2%)**.

| | `gemini-3.7-flash` @ low | `gemini-3.1-flash-lite` @ minimal |
|---|---|---|
| **prompt v1** | **₹5,85,645 · 64.1%** | ₹3,98,306 · 43.6% |
| **prompt v2** | *not measured — budget* | ₹5,43,880 · 59.5% |

Both main effects are large, and they point in opposite directions:

- **Model, holding the prompt at v1:** 3.7-flash is worth **+₹1,87,339 (+47%)**.
- **Prompt, holding the model at flash-lite:** v2 is worth **+₹1,45,574 (+37%)**.

That is why the one confounded run — v2 on flash-lite against a v1-on-3.7-flash
baseline — looked like a mild regression. Two large effects were cancelling.

### Against the baseline, paired

Both policies run the identical cases, so the per-case difference is the right
thing to resample. Independent per-policy intervals overlap almost entirely and
say nothing.

| configuration | agent − static-policy | behind in |
|---|---|---|
| v1 · 3.7-flash | −₹10,447 | 54.7% of resamples |
| v2 · flash-lite | −₹52,212 | 80.5% |
| v1 · flash-lite | −₹1,97,786 | 99.1% |

**54.7% is a coin flip.** The best configuration measured is statistically tied
with the rules engine, not behind it. Only the v1/flash-lite result is a genuine
deficit.

### Behavioural counters

Counts over thousands of decisions, so they move sharply where money moves
noisily. This is what the prompt work actually bought.

| counter | v1 · 3.7 | v1 · lite | v2 · lite | static |
|---|---|---|---|---|
| model decisions | 2,736 | 3,738 | 3,101 | — |
| waited while `retry_debit` permitted | 500 | 1,485 | 1,054 | **0** |
| `handoff_human` | 99 | 58 | **13** | 28 |
| `stop_terminal` | 15 | — | 76 | **0** |
| AFA: `request_afa` | 53 | 67 | 41 | 37 |
| AFA: `retry_debit` | 2 | 1 | **14** | 15 |
| model spend | $4.98 | $1.73 | $1.80 | $0 |
| $ per ₹1,00,000 recovered | 0.85 | 0.43 | **0.33** | 0 |

The AFA defect diagnosed in C-018 — requesting authentication the payer had
already been asked for, then never re-presenting — is **closed by v2** and by
the prompt alone: 2 → 14 presentments on AFA cases, against static-policy's 15.
Escalation is closed too, and overshoots: 99 → 13 against static's 28.

Flash-lite's weakness has a clear shape. On the identical v1 prompt it waits
**three times as often** while a presentment is on the menu (1,485 vs 500). A
model asked to think with zero reasoning tokens is markedly more passive.

## Prompt iteration, on the 30-case tune batch

`mix_tune`, seed 2026, held out from `main`, `gemini-3.1-flash-lite`. A
diagnostic probe that over-weights the C-018 failure modes; `eval` prints a
banner saying nothing measured on it is a recovery result. Judged on counters,
not rupees — at 30 cases the paired intervals for these variants overlap
heavily.

| | v1 | **v2** | v3 | static |
|---|---|---|---|---|
| `wait` | 160 | **82** | 107 | 80 |
| waited while `retry_debit` permitted | 123 | **53** | 73 | 0 |
| `retry_debit` on AFA cases | 1 | **3** | 1 | 4 |
| `handoff_human` | 7 | **2** | 3 | 4 |
| `stop_terminal` | 9 | 10 | 11 | **0** |
| model decisions | 268 | **194** | 194 | — |
| recovered | ₹19,040 | **₹53,156** | ₹21,086 | ₹76,595 |

### v1 → v2 worked

Three factual additions, none of them a compliance rule: what a presentment,
message and handoff cost in rupees against invoice size; that AFA is unblocked
by one request and sits behind an expiring mandate; that escalation is not a
free way to be careful. Plus a `WAITING` section: wait until something could
actually have changed.

The waiting section also cut decisions 268 → 194 on this batch, a 28% cost
reduction as a **side effect of better behaviour** rather than a trade against
it. That did not transfer to `main`, where decisions rose — the tune batch has
no terminal codes and a very different mix, and behaviour tuned on it does not
automatically generalise.

### v2 → v3 backfired

v3 named the real budgets — four presentments, four lifetime messages — after
watching the agent spend all four contacts re-requesting authentication on one
₹18,293 invoice and then hand it to a human with nothing left.

It hoarded them instead. Waiting rose 82 → 107, idle retries 53 → 73, AFA
retries fell back to 1. **An unspent message recovers exactly as much as a
wasted one.** A second paragraph aimed at `stop_terminal` moved that counter
from 10 to 11, which is to say not at all.

Reverted. v3's text and its decisions are both kept, so the row re-runs.

## The cell that was never measured

**v2 on `gemini-3.7-flash`** is the configuration both main effects predict
should be best, and it is the one that was not finished: the account's
prepayment credits were exhausted 2,300 decisions into roughly 3,100. Those
2,300 are committed, so resuming would cost only the remainder.

The circuit breaker abandoned that run rather than publishing ~3,000
static-policy fallbacks under the agent's name, which is the behaviour C-019
added it for.

Total spend across every experiment on this page: **₹1,241** (12,738 recorded
decisions).
