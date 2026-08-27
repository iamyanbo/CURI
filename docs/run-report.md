# CURI — report on two research runs

Two directions, on two machines, in two domains. Both are stopped; every number
here is read from their records rather than estimated.

| | Attention & KV-cache | Strategy generalization |
|---|---|---|
| Machine | Windows, RTX 3060 Ti (8 GB) | DGX Spark (GB10), Ubuntu aarch64 |
| Wall clock | 2026-08-26 00:20 → 08-27 19:00 (~43 h) | 2026-08-27 02:42 → 14:07 (~11 h) |
| Model | Gemini 3.7 Flash via Vertex AI, through Genkit | same |
| Runs | 125 | 89 |
| Recorded spend | **$39.60** | **$20.53** |
| Tokens | 46.7M in / 1.22M out | 24.6M in / 0.56M out |
| Tasks | 18 | 4 |
| Outcomes | **17** — 12 supported, 3 bounded, 1 refuted, 1 inconclusive | **4** — 3 supported, 1 bounded |
| Syntheses | 28 | 21 |
| Research threads | 4 | 5 |
| Thread relationships | 9 | 15 |
| Sources admitted | 41 | 14 |
| Longest single run | 178.9 min | — |

Combined: **214 runs, $60.13, 71.3M input tokens, 21 recorded outcomes.**

---

## Direction one — resource-adaptive transformer inference

Seventeen outcomes across four threads. The headline results:

**Heuristic KV-cache eviction is causally blind to unasked questions** (`bounded`).
H2O-style cumulative-attention retention scored **0% on non-local needle retrieval at 50% cache
budget — indistinguishable from random eviction**. During prefill, filler tokens do not attend to an
isolated fact, so attention mass never marks it as worth keeping. This refuted the study's own
leading hypothesis, and it is only a meaningful claim because the design included a random-eviction
control.

**Speculative decoding can lose wall-clock time at healthy acceptance** (`supported`). At α = 38–54%
throughput was *slower* than plain autoregressive decoding, because per-token latency tracks
transformer **layer depth** rather than parameter count: 0.5B/24 layers at 39.4 ms/tok against
1.5B/28 layers at 43.9 ms/tok.

**Key and value quantization errors differ in kind, not degree** (`supported`). Value error is
additive through a row-stochastic attention matrix; key error passes through a softmax and disperses
attention. Asymmetric K-INT8/V-INT4 held retrieval at 4-bit value precision.

**Randomized-Hadamard rotation fails to prevent key quantization damage** (`refuted`) — the one
outright refutation, and the outcome a score-maximizing loop has no way to record.

The remainder covered prompt-lookup speculation, prefill-pressure adaptive scheduling, failure
propagation between low-bit KV quantization and speculative verification, prefix-cache reuse,
spectral transform coding, and a dispatcher composing several of these.

### What these findings are and are not

Three of the four headline results reproduce work that already exists: the eviction failure is what
StreamingLLM and later needle-retrieval work describe for H2O-style policies; the decoding result is
the standard acceptance-rate/latency crossover, reached by measurement rather than algebra; the K/V
asymmetry is what KIVI reports. The contribution is not novelty. It is that they were independently
re-derived on hardware we control, with controls, and that the failures stayed in the record.

Bounds that apply to all of it: 0.5B–1.5B models at ≤4096 context on one consumer GPU, small
samples, simulated rather than genuine long-context memory pressure.

---

## Direction two — generalization and overfitting in systematic strategies

The second direction asks when a strategy found in historical data keeps its edge outside the window
it was found in. It declares no metric to maximize, because a Sharpe target would make the search
the very thing under study.

Data is Ken French daily factor and industry-portfolio returns, visible through **2015-12-31**
(13,217 daily rows of FF5, 23,637 of 49 industry portfolios, 23,536 of momentum), with source URL,
SHA-256 and date range recorded in a manifest. Everything from **2016-01-04 to 2026-06-30** — 2,637
trading days — is written outside the project, in no worktree and reachable by no relative path.

Its first experiment swept search intensity from 1 to 5,000 strategy variants:

| variants examined | best in-sample Sharpe | out-of-sample @ 0 bps | out-of-sample @ 10 bps |
|---|---|---|---|
| 1 | 0.78 | 0.36 | 0.07 |
| 100 | 3.07 | 0.87 | 0.12 |
| 1,000 | 3.81 | 0.64 | **−0.44** |
| 5,000 | 4.11 | 0.43 | **−0.89** |

Search harder, look better in sample, do worse out of sample — and at 10 bps of cost, the
best-looking strategy of 5,000 loses money. The run also computed the theoretical expected maximum
Sharpe under a null via extreme value theory, deflated Sharpe ratios, and combinatorial purged
cross-validation across 12,870 combinations at four cost levels.

Its four outcomes: search intensity and out-of-sample decay (`bounded`); serial boundary leakage
being negligible against macro regime dominance (`supported`) — a mildly contrarian result against
the standard purging advice; parameter-surface flatness and basin ensembling preventing decay
(`supported`); and an end-to-end ex-ante falsification framework (`supported`).

**Open and unresolved:** the search-intensity table and the CPCV summary disagree — mean
out-of-sample Sharpe of 0.43–0.87 in one and 2.6 in the other, with a PBO near zero that is
implausible for 5,400 strategies. One of them has a bug or they measure different things. The
CPCV numbers should not be quoted until that is settled.

**Not yet done:** nothing has been evaluated against the withheld decade. That evaluation is a
separate operator step, by design — if the agent could reach the holdout, the number would mean
nothing.

---

## What the runs cost, and what that taught us

Twenty-two of the 125 local runs failed. Almost all were provider failures rather than research
failures: `PROVIDER_RATE_LIMITED` from Vertex, and a recurring `Failed to parse stream` transport
error. Two tasks exhausted all three executor attempts without an experiment ever running, at about
$2.70, and were returned "unfinished" as though the science had failed. Both instances shared one
API key, which doubled the request rate against a single quota — a setup mistake on our side.

A rate limit says nothing about whether a study is feasible, so counting it against a task's attempt
budget is wrong in the same way that counting a supervisor restart was. That one is fixed; this one
is known and not yet.

The larger lesson was about idle cost. Roughly half of the second direction's budget went to
pausing and resuming rather than research:

- The orchestrator would pause, judging nothing worth doing.
- Continuous mode resumed it on a timer, handing it the same context and the same question.
- Given a turn, it recorded *something* rather than nothing — a restated synthesis, a re-described
  component map — and each such event reset the idle backoff, so the cycle repeated every 90 seconds.

Three separate repetition loops came out of that single cause, and closing each one moved the
behaviour to the next. The fix was to stop resuming on a clock: a pause now stands until evidence
arrives that could change it. Measured on the live direction afterwards, the cost of an hour fell
from about **$2.00 to $0.17** while recorded findings went up.

Also measured, earlier in the build: recording only the final model call of an agent turn
undercounted input tokens **20×** and output **90×**, because a tool loop re-sends the whole
conversation each turn and reasoning tokens arrive in a separate field.

---

## Where the record lives

The attention direction is published to Firestore and served read-only from Cloud Run, including
agent traces — 122 of its 125 runs carry a published trace. Text is redacted and then the assembled
record is checked against identifiers taken from the running environment; a field that still matches
stops the publish rather than being scrubbed and sent.

The finance direction runs unpublished: that machine has no Google credentials, and publishing is
optional by design.
