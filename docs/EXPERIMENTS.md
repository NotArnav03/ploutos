# Experiments

Every prompt or policy variant that was measured, including the ones that made
things worse. A tuning log that only records the wins is a story about a
straight line that did not happen.

## How these are judged

On the **behavioural counters**, not on rupees.

The tune batch is 30 cases (`mix_tune`, seed 2026, held out from `main`), and at
that size a difference in recovered value is mostly sampling noise — the paired
intervals for these variants overlap heavily. The counters are counts over
hundreds of decisions and move sharply and consistently, so they are the signal.
Rupees are reported for context and are not the verdict.

All runs: `gemini-3.1-flash-lite` at `thinkingLevel: minimal`, concurrency 4.

## Results

| | v1 | **v2** | v3 | static-policy |
|---|---|---|---|---|
| `wait` decisions | 160 | **82** | 107 | 80 |
| waited while `retry_debit` was permitted | 123 | **53** | 73 | **0** |
| `retry_debit` on AFA cases | 1 | **3** | 1 | 4 |
| `request_afa` on AFA cases | 19 | 14 | 14 | 12 |
| `handoff_human` | 7 | **2** | 3 | 4 |
| `stop_terminal` | 9 | 10 | 11 | **0** |
| total model decisions | 268 | **194** | 194 | — |
| recovered | ₹19,040 | **₹53,156** | ₹21,086 | ₹76,595 |
| of ceiling | 23.1% | **64.4%** | 25.5% | 92.8% |
| model spend | $0.13 | $0.11 | $0.11 | $0 |

**v2 is the current best and is what HEAD carries.**

## v1 → v2: the diagnosed fixes worked

Three additions, all factual and none of them a compliance rule: what a
presentment, message and handoff cost in rupees against invoice size; that AFA
is unblocked by one request and sits behind an expiring mandate; that escalation
is not a free way to be careful. Plus a `WAITING` section telling the model to
wait until something could actually have changed.

Idle retries fell 123 → 53, handoffs 7 → 2, and recovery nearly tripled. The
`WAITING` section also cut total decisions 268 → 194, which is a 28% cost
reduction as a side effect of better behaviour rather than a trade against it.

## v2 → v3: telling the model its budgets were scarce made it hoard them

v3 added two things to v2.

A **TWO BUDGETS** section stating the real caps — four presentments and four
lifetime messages per invoice — after observing the agent spend all four
contacts on repeated authentication requests for one ₹18,293 invoice and then
hand it to a human with nothing left.

And a paragraph telling it that `stop_terminal` is not a cheaper `handoff_human`,
after v2 cut handoffs 7 → 2 while `stop_terminal` stayed at 10 — the model had
simply switched give-up doors.

Both failed, and one backfired. Waiting rose 82 → 107, idle retries 53 → 73,
and retries on AFA cases fell back to 1. Naming the budget as scarce made the
model conserve it, which is worse than the overspending it was meant to fix: an
unspent message recovers exactly as much as a wasted one. The `stop_terminal`
paragraph moved that counter 10 → 11, i.e. not at all.

Reverted. v3's decisions stay in the committed cache so the comparison is
reproducible, but `PROMPT_VERSION` is back to `v2`.

## Still open

`stop_terminal` at 10 against static-policy's 0 is the largest remaining
behavioural gap, and it costs real money: four `INSTRUMENT_EXPIRED` cases closed
as "unrecoverable" that static-policy recovered by simply asking the payer for a
new card. One attempt at fixing it by instruction failed. The next attempt
should probably be structural rather than persuasive — `stop_terminal` is only
ever correct when a stop rule has already fired, so the gate may be the right
place to enforce that, not the prompt.

That is a change to the action space rather than to the wording, so it is a
separate decision and not a tuning iteration.
