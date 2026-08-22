# pi-autoresearch

An automated research harness that tries to disprove its own results.

A campaign proposes hypotheses, implements them, measures them with an evaluator
the candidate cannot see or influence, and judges them with a pure function no
model can reach. Negative results are kept. Claims that survive multi-seed
replication against a held-back measurement can advance the baseline; nothing
else can.

```
npx tsx src/setup.ts "optimize attention with cuda"      # scaffold + verify
npx tsx src/cli.ts campaign --campaign attn-001 \
  --domain domains/attention.domain.json --hours 0 --detach
npx tsx src/cli.ts stop --campaign attn-001              # or the dashboard button
```

The dashboard is at `http://127.0.0.1:4791` (`npx tsx src/ui/server.ts`).

---

## The one thing you have to get right

**The protected evaluator is the research contribution. Everything else is
plumbing.**

`src/setup.ts` will one-shot a whole domain from a sentence — candidate,
evaluator, config, planted cheats — and `doctor` will verify it mechanically
before anything runs. That verification is real: it runs your baseline, measures
its noise floor, plants every cheat and checks your evaluator catches each one
via the exact check it claimed would fire. A generated domain that does not pass
does not launch.

But passing `doctor` means **every defence you declared works**. It does not
mean you declared the right defences. Nothing can check that for you, because it
is the actual scientific judgement in the whole system.

Two examples from this project, both of which decided whether the results meant
anything:

- **CUDA kernels.** The evaluator rejects any result above 448 GB/s, because that
  is the memory bandwidth of the device. A kernel reporting more did not do the
  work. Nothing in "optimise a softmax kernel" suggests that check; it comes from
  knowing the hardware.
- **Backtesting.** The evaluator re-runs the strategy with the future replaced by
  different data and checks the past positions did not move. Lookahead cannot
  hide from that, however it was written — no `shift(-1)`, no negative index, no
  clever normalisation. Nothing in "write a trading strategy" suggests it; it
  comes from knowing how this field fails.

Both were invented, not derived. An agent asked to write an evaluator writes one
that computes the metric and stops, because that is what the task sounds like.

### What makes an evaluator good

Before you run a campaign that matters, read the generated evaluator and ask:

1. **Does it own everything that could be gamed?** The data, the held-back split,
   the timing, the reference answer. If the candidate can touch it, the candidate
   will eventually optimise it.
2. **Is there a hard bound, and does it check it?** A bandwidth, a FLOP ceiling,
   an entropy limit, causality, conservation of anything. A bound turns a
   suspicion into proof — this is the single highest-value check you can add.
3. **Is the held-back measurement genuinely held back?** Hidden shapes, a later
   time window, an unseen corpus. If a good score on it can be obtained by
   fitting the visible part, it is not held back.
4. **Would the obvious cheat be caught?** Write it down and add it as a fixture.
   Fixtures are permanent: when a domain later proves porous, the fix is a new
   fixture, never a loosened check.
5. **Is the metric close to complete?** Ask what you would be unhappy to
   discover the system had optimised for. If the answer is "a strategy with a
   great Sharpe and one catastrophic month", the metric is not enough on its own
   and the missing property belongs in a check, not in a blended score.

Point 5 is where the finance domain in `domains/examples/` falls short, and it
says so: `sharpe` on synthetic daily equities is cross-sectional quant, not
"finance". No drawdown, no capacity, no macro state. It is labelled as a
demonstration rather than a general result.

---

## What the harness gives you for free

You do not have to write, and should not reimplement:

- **Noise floor measurement.** The campaign re-runs your untouched baseline
  across its own replication variants and measures the spread. Nothing smaller
  counts as a result, and a contract registering a threshold below it is
  rejected before any compute is spent. Do not declare `metric.noiseFloor`.
- **Multi-seed / multi-window replication** with a minimum-agreement policy,
  and a check that variants actually varied.
- **A pure judge.** No model can set a status.
- **Pre-registered contracts.** Thresholds are hashed and stored before the
  experiment is built; the judge refuses any contract registered after its result.
- **Portfolio lanes** with a non-borrowable falsification floor, so attacking
  accepted claims cannot be deferred forever.
- **A hash-chained evidence ledger**, sealed diffs, sealed agent traces, and a
  citability check per claim.
- **Operator steering** that is recorded as an intervention before the manager
  sees it.

## Adding a domain

```
npx tsx src/setup.ts "<what to research>" [--slug name] [--attempts 3]
npx tsx src/doctor.ts --domain domains/<slug>.domain.json   # re-verify any time
```

A domain is four things: candidate files, a protected evaluator, a config, and
planted cheats. The config must include one cheat of each kind — `do_nothing`,
`peek`, `partial_work` — because those are the domain-independent ways to fake a
result and requiring them is what stops a weak evaluator passing its own tests.

Declare `agentSearch: false` and a `leadsAsOf` date for any domain whose holdout
is **time**: web search cannot be date-fenced, and a single headline about the
scored period is lookahead no other check can see. See
`docs/literature-access.md`.

## Honest limitations

`SCOPE.md` lists all 16 product invariants with their real status, including the
deferred ones. `plans/06-findings.md` documents every defect found by running the
system — including the false positives it produced and the promotions that were
withdrawn.

The system caps at **A3** on its own autonomy ladder: validated improvement. It
makes no novelty claims, and any output claiming novelty is a bug.
