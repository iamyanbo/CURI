# What Breaks in an Autoresearch Harness — Findings

Date: 2026-08-21
Status: draft findings from building and running `pi-autoresearch` v0
Scope: one system, two domains (a tiny language model on CPU, a CUDA softmax kernel on an
RTX 3060 Ti), ~30 hours of construction and 13h 34m of unattended operation.
Every number below comes from `.autoresearch/state.sqlite`, the archived run logs, or the two
verification harnesses. Nothing is estimated.

---

## 1. Summary

We built a falsification-oriented research harness and ran it unattended. It produced ten validated,
compounding improvements. It also produced **four false accusations of fraud**, and two of its
cheat-detectors were **silently dead** for an entire campaign before we noticed.

The headline is not the research result. It is this:

> Across twenty-six defects found by running the system, **every one was in the harness, none in the
> model's reasoning**. And the harness's dominant failure mode was not letting cheating through —
> it was accusing correct work of cheating, or blaming correct work for the harness's own faults.

Porting the harness to a second, structurally unlike domain — from bits-per-character on a CPU,
where lower is better, to GB/s on a GPU, where higher is better — added seven more defects and one
new category. That port is the closest thing here to an independent test of the architecture, and
its result is reported in §6: the domain-independent core needed no changes, and every new defect
was in a place where a value had been written down twice.

---

## 2. What the campaign produced

| | |
|---|---|
| Span | 12h 44m |
| Cycles | ~80 |
| Model | `fireworks/deepseek-v4-flash-0731` (both manager and executor) |
| Cost | **$0.5256** |
| Events | 406, hash-chained, verified |
| Contracts registered | 90 |
| Artifacts sealed | 315 |
| Evaluations | 79 |
| Human interventions | 8 (7 changed the frontier) |

**Metric movement** (bits-per-char, char-level LM on tinyshakespeare):

```
val      2.916446 → 1.758483    −39.7%
holdout  2.956793 → 1.924430    −34.9%
```

Quote the holdout figure. The visible split is what candidates optimise against; the holdout is the
one they never see. The follow ratio held at ~0.87 across all eleven baseline advances rather than
decaying, which is the signature of real improvement rather than accumulated overfitting.

**Claim outcomes:**

| Status | Count |
|---|---:|
| inconclusive | 29 |
| refuted | 17 |
| implementation_invalid | 16 |
| tested (controls confirmed) | 14 |
| **replicated** | **10** |
| proposed | 4 |

46 negative results retained and queryable. A keep/revert loop discards all of them.

**Replicated claims by lane:** exploit 4 · mechanism 3 · moonshot 3. No lane dominated. The
`moonshot` lane — added mid-run for ideas that must regress before paying off — produced 3 of 10
within hours of existing.

**Run reliability:**

| Run kind | Succeeded | Failed |
|---|---:|---:|
| manager | 90 | 23 |
| executor | 78 | 11 |
| compute | 84 | 0 |
| evaluation | 79 | 5 |
| replay (replication) | 37 | 8 |

The manager's 20% failure rate is the single largest source of waste, and is what a bounded retry
was added to absorb.

---

## 3. The counterfactual

The central claim — that structured orchestration decides better than a simple loop — was tested by
holding evidence fixed and varying only the acceptance policy. Ten replicated claims plus four
planted cheats; each candidate trained and evaluated once; each rebuilt against the revision it was
actually written against and scored against the baseline it actually faced.

| Arm | Honest kept | Cheats admitted | Admitted |
|---|---:|---:|---|
| `naive` (keep/revert on self-reported number) | 10/10 | **3/4** | label_leak, parser_spoof, eval_window_shrink |
| `no_checks` (independent measurement only) | 10/10 | **1/4** | label_leak |
| `full` (shipped harness) | **9/10** | **0/4** | — |

**Reading it:**

- **Independent measurement stops two of three cheats.** The parser spoof reported 0.9672 while
  independently measuring 1.7585 — a keep/revert loop records a 46% improvement that never existed.
  Simply not trusting the candidate's own number kills it.
- **Only the audits stop the third.** The label leak produced a genuine, independently-measured 14%
  improvement. Nothing about the number is fake. It was caught solely because val improved 0.245
  while the holdout improved 0.106 — a follow ratio of 0.43. **This is a cheat you cannot detect by
  measuring more carefully, only by measuring something the cheat could not reach.**
- **Seed shopping was caught by luck, not by a gate.** Its checks passed clean; it simply landed on
  a worse seed. A luckier draw and only the seed-policy gate stood between it and acceptance.
- **The full arm rejected one genuine improvement** — a 10% false-negative rate, analysed in §5.

---

## 4. Cheat detection, and the trap of only testing one direction

Four planted cheats, each improving the visible metric while violating the task, each targeting a
different defence. First run: **2 of 4 caught.**

| Fixture | Targets | First run | After fixes |
|---|---|---|---|
| Train on the validation split | leakage divergence | ❌ escaped | ✅ |
| Print a metric never computed | independent recomputation | ✅ | ✅ |
| Score on a tiny slice of the split | full-split recomputation | ✅ | ✅ |
| Hardcode a favourable seed | seed-policy gate | ❌ escaped | ✅ |

Both escapes were real holes:

1. **The seed detector was dead.** Its regex contained a literal backspace byte (0x08) where a
   word-boundary escape was intended — written there by a code-generation step that interpreted the
   escape. It had matched nothing for its entire existence, including through a complete 37-cycle
   campaign, and looked correct in every `grep` because a backspace is invisible in terminal output.
2. **The leakage threshold was guessed.** The follow-ratio bar was 0.25, chosen by intuition. The
   planted leak scored 0.26 and walked through. Recalibrated against measured data.

**The methodological point.** Every prior change to these defences had been driven by fixing a FALSE
positive, and each fix made detection more permissive. Nothing had ever tested the other direction.
A detector that never fires is indistinguishable from a detector with nothing to catch.

> **You cannot validate a safety mechanism by observing that it stays quiet.**

---

## 5. False accusations: the dominant failure mode

Four times the harness declared legitimate work fraudulent. Every one was caught and withdrawn with
the reason recorded rather than the status quietly flipped.

| # | Accused | Actual cause |
|---|---|---|
| 1 | An EMA candidate | It measured averaged weights but *saved* un-averaged ones. A candidate bug, not evasion. The check fired correctly; the label was wrong. |
| 2 | A SwiGLU candidate | The leakage test used a fixed val↔holdout *gap* calibrated on the original baseline. The gap grows with model quality (0.040 → 0.158 over four improvements), so the test was on a collision course with the campaign's own success. |
| 3 | A fresh-seed baseline control | The leakage floor was tied to the contract's `support_delta`. A manager working against a hard baseline set it to 0.012 — **below the task's measured seed-noise floor of 0.027**. The test was diagnosing leakage from pure noise. |
| 4 | An n-gram bypass candidate | The **operator** edited the protected evaluator mid-cycle. The integrity check correctly detected that the rules changed underneath the experiment, but could not distinguish a repair from an attack. |

Three of the four trace to the same root: **a threshold calibrated against intent rather than
against measured noise.**

### 5.1 The remaining false negative

The counterfactual's one rejected honest claim was diagnosed rather than assumed:

```
seed 7      gain 0.118   holdout gain 0.087   ratio 0.74   ✓
seed 1234   gain 0.096   holdout gain 0.074   ratio 0.77   ✓
seed 99991  gain 0.075   holdout gain 0.037   ratio 0.49   ✗  (bar: 0.50)
```

All three seeds cleared the improvement bar comfortably. The claim died because one seed's follow
ratio missed by **0.01**.

Two errors compound here, and both are instructive:

1. **Calibrated on aggregates, applied to single runs.** The 0.50 bar came from cumulative campaign
   figures (0.65–0.99). Single-run ratios span 0.49–0.77. The planted label leak scores 0.43.
   **Honest single runs and genuine cheats overlap** — a single run's follow ratio cannot separate
   them.
2. **A multiple-comparisons bug inside the defence itself.** Applying a noisy test independently to
   three seeds gives three chances to fail; any one failure kills the claim.

The fix is structural: leakage is a property of the *candidate*, not of a run, so it must be judged
on pooled evidence across seeds. ALiBi's pooled ratio is 0.667 (clearly honest); the label leak stays
near 0.43 (clearly not). This weakens nothing — the other three cheats are caught by independent
recomputation and the seed-policy gate, neither of which depends on replication strictness.

### 5.2 Misattributed blame: a distinct and more corrosive failure

The CUDA campaign produced a failure that does not fit the false-accusation table above, and is
worse than the entries in it.

A falsify contract legitimately carries no improvement threshold — it is attacking a claim, not
proposing one. An earlier fix made `support_delta` optional for that lane and taught the *judge* to
treat a missing threshold as unreachable. It did not teach the *evaluator call*, which passed the
value through unresolved. `String(undefined)` is the entirely valid command-line argument
`"undefined"`, so the threshold crossed the process boundary looking plausible and died fifteen
minutes later inside Python's `argparse`.

The harness reported:

```
status : implementation_invalid
why    : the protected evaluator did not complete
```

That sentence points at the candidate. The candidate was fine. **A harness defect was wearing a
candidate-shaped error message**, and it survived two campaigns because the message was one an
operator would accept without investigating.

This is distinct from a false accusation. A false accusation names a specific innocent party and can
be argued with. Misattributed blame is quieter: it sends the operator to tune the wrong component,
and every hour spent there is spent making a correct part of the system worse. An operator reading
that log would have loosened the evaluator, weakening a real defence to fix a bug that was never in
it.

The structural fix is not the patched call site but the rule that numbers are validated **at the
process boundary**, where the harness still knows the value is its own fault:

> refusing to invoke the evaluator: --support-delta is undefined, not a finite number. This is a
> harness defect, not a candidate failure.

An error that names its own author cannot be misattributed.

---

## 6. The twenty-six defects

| # | Defect | Class |
|---|---|---|
| 1 | Candidate bug reported as cheating | mislabel |
| 2 | Passing control reported as `inconclusive` | mislabel |
| 3 | Valid empty-diff control reported as an abort | mislabel |
| 4 | Baseline pointer advanced without the metric it referred to | state propagation |
| 5 | Two components disagreeing on which revision was "the baseline" | state propagation |
| 6 | Repair cap read operator invalidations as live failures | mislabel |
| 7 | Replication that could not detect its own failure | dead check |
| 8 | Unbounded context packet exceeded the OS argv limit | scaling |
| 9 | Leakage judged on distance rather than divergence | miscalibration |
| 10 | Whitespace-only worker reply counted as success | mislabel |
| 11 | Seed detector held a literal backspace byte | dead check |
| 12 | New lane added everywhere except its validator | incomplete change |
| 13 | Truncated model output diagnosed as malformed | mislabel |
| 14 | Executor had no retry on producing no change | missing recovery |
| 15 | Moonshot lane promised multi-step ideas, gave one-shot execution | design incoherence |
| 16 | Evaluator failures discarded their own reason | observability |
| 17 | Manager kept proposing work the harness already did | information gap |
| 18 | Leakage floor could sink below the noise floor | miscalibration |
| 19 | Operator evaluator edits indistinguishable from attacks | missing concept |
| 20 | Metric direction hardcoded to `minimize`; every verdict in a `maximize` domain inverted | incomplete change |
| 21 | Manager prompt hardcoded the old domain's metric; thresholds set 400x below the noise floor | incomplete change |
| 22 | UI reported in-flight stages as `0 ms`, indistinguishable from a dead process | observability |
| 23 | Falsify contract's absent threshold reached the evaluator as the string `"undefined"` | incomplete change |
| 24 | Malformed candidate config crashed the harness — a denial of service any executor could trigger | missing recovery |
| 25 | Dangling ledger revision crashed with a raw buffer dump instead of naming the inconsistency | observability |
| 26 | One throwing cycle ended the entire campaign; no containment existed | missing recovery |

**Distribution:** 6 mislabels · 4 incomplete changes · 3 observability · 3 missing recovery ·
2 dead checks · 2 miscalibrations · 2 state propagation · 1 each of scaling, design incoherence,
information gap, missing concept.

**Defects 1-19 came from building the system; 20-26 came from generalising it.** That distinction
matters more than the totals. Before the refactor, `incomplete change` was a single defect. After
it, it is the second-largest class, and all three new members have the same shape: *a correct idea
applied to one of the two places that needed it.*

- Direction was moved to the domain interface; two call sites kept reading `"minimize"`.
- The metric was made configurable; the manager's prompt kept describing the old one in prose.
- The falsify lane was allowed to omit a threshold; the judge learned this and the evaluator did not.

None of these was a wrong decision. Each was a right decision that landed in one place. Generalising
a working system is therefore not a neutral refactor — **it manufactures this defect class at a rate
that ordinary feature work does not**, because every hardcoded assumption becomes a fork where the
two branches can silently disagree, and the domain that exposed the disagreement is by definition
the one nobody had run yet.

The countermeasure that works is not review. It is arranging for the second reader not to exist:
derive the value once and pass it, so there is no second place to forget.

**None were in the model's reasoning.** The manager's hypotheses were consistently well-motivated —
ALiBi, learnable slopes, convolutional stems, sparse MoE routing, slot memory — and it designed
ablations to attack its own accepted conclusions.

**None of the semantic defects would have been prevented by fencing tokens, leases, epochs, or
process-tree ownership** — the machinery `plans/03` front-loads into M0. Defect 8 is the exception
that proves the rule: `03` specified a bounded, deterministic context packet, the unbounded version
was built for speed, and it crashed the run.

### 6.1 A test that asserted the bug

While building the fix for #19, a test was written, it passed, and it was **asserting the broken
behaviour** — the authorised-change branch returned before the candidate's own conduct was examined,
so an operator edit could have laundered a genuine attack landing in the same cycle. It surfaced
only on re-reading the gate order after the test went green.

> A passing test proves the code does what the test says, not what you meant. This is the same
> lesson as the planted cheats, one level up.

---

## 7. Operational lessons

1. **A guard that never complains may be asleep.** Test that detectors *fire*, not only that they
   do not misfire. Two were dead; both were found by deliberately feeding the system something it
   should reject.
2. **Calibrate every threshold against measured noise.** Three of four false accusations came from
   constants chosen by reasoning. The task's seed-noise floor (0.027) was measurable and was not
   measured until it caused failures.
3. **Distinguish "broken" from "cheating" in the taxonomy, not the prose.** Conflating them puts
   fabricated fraud into an evidence record that is supposed to be trustworthy.
4. **Never edit the referee mid-game.** Editing the protected evaluator during a live cycle
   correctly invalidated the experiment and incorrectly accused the candidate.
5. **Tell the model what the system already does.** The manager repeatedly proposed seed-stability
   controls the harness performs automatically. The defect was the information gap, not either party.
6. **Aborts must cost something eventually.** Aborts deliberately consume no research budget, which
   let one broken lane keep winning the allocator's deficit race and march the campaign into its
   abort cap.
7. **Run it.** Every one of the twenty-six was found by operation, not inspection. The design
   documents are 3,900 lines and predicted almost none of them.

---

## 8. Honest limitations

- **One domain, and a toy one.** All results are on a character-level LM. The techniques rediscovered
  (ALiBi, convolutional stems, MoE routing) are published work; the system performed **no prior-art
  search** and its ladder is capped at **A3 — validated improvement**, never A4.
- **One model** (`deepseek-v4-flash-0731`) for both roles. No model comparison was run.
- **8 interventions, 7 frontier-changing.** This campaign needed substantial hands-on repair and
  should not be described as having run itself unattended for 12 hours.
- **18.9% of wall time is `unknown`** — the gaps where the run was stopped for fixes. Reported, not
  absorbed.
- **The counterfactual holds evidence fixed** and varies only acceptance policy. It does not measure
  whether the harness *searches* better, only whether it *decides* better.
- **The leakage-pooling fix in §5.1 is diagnosed but not yet implemented**, so the 10%
  false-negative figure stands as measured.
- **No durability testing.** `plans/04` §7.2 specified a four-edge crash matrix; it was never run.
