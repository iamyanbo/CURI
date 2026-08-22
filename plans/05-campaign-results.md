# Campaign `tinyml-001` — Results

Date: 2026-08-20
Status: complete; stopped on its own wall-clock budget
Artifacts: `.autoresearch/state.sqlite` (canonical), `.autoresearch/archive/*.log` (every run, including
the failed ones), `SCOPE.md` (invariant enforcement), `src/cli.ts card` (regenerates the claim card)

---

## 1. Claim card

```
CAMPAIGN  tinyml-001
STATUS    stopped: wall_clock_exhausted
SPAN      4h 51m
  model_reasoning      3h 33m  (73.2%)
  compute             40m 48s  (14.0%)
  unknown             26m 35s  (9.1%)
  supervisor           7m 51s  (2.7%)
  evaluation           2m 49s  (1.0%)
HUMAN     6 interventions (5 changed the frontier)
RUNS      184 recorded · 16 failed
CLAIMS    4 replicated · 18 inconclusive · 9 refuted · 6 implementation_invalid · 2 proposed
          27 negative result(s) retained and queryable
LANES     control=9 · exploit=11 · falsify=6 · mechanism=11
COST      $0.2137 in model calls
TRACE     179 events · hash chain verified
LADDER    A3 — validated improvement
```

Model: `fireworks/deepseek-v4-flash-0731` for both manager and executor.

## 2. What was found

Four claims survived multi-seed replication, each measured by an evaluator the candidate cannot
read, against a threshold registered before the experiment ran.

| # | Claim | Lane | val | holdout |
|---|---|---|---:|---:|
| — | baseline | — | 2.916446 | 2.956793 |
| 1 | ALiBi relative-position attention bias replacing learned absolute positions | mechanism | 2.827195 | 2.898960 |
| 2 | Learnable ALiBi distance slopes | exploit | 2.679325 | 2.766943 |
| 3 | Causal convolutional stem for local character n-grams | mechanism | 2.467952 | 2.594502 |
| 4 | Two-layer residual causal conv stem for longer local n-grams | mechanism | 2.398249 | 2.525815 |

**val −0.518 (17.8%) · holdout −0.431 (14.6%).**

Quote the holdout figure. The visible split is what candidates are scored on, so it flatters; the
holdout followed at about 83% of the val gain, and that ratio is the generalisation claim.

The sequence shows the portfolio compounding rather than restarting: the mechanism lane opened
ALiBi, the baseline advanced onto it, and the exploit lane then proposed sharpening it — its
recorded mechanism begins *"The replicated ALiBi improvement fixes each attention head's distance
penalty to a geometric schedule…"*. Claims 3 and 4 opened a structurally independent direction
(local n-gram convolution) alongside it. A winner-descending tree cannot hold two directions at once;
this is what the immutable-state design bought.

### 2.1 What this is not

These are all published techniques. The system performed **no prior-art search**, so it rediscovered
rather than invented, and the claim card says so in the same words. The ladder caps at **A3** by
construction — `SCOPE.md` records invariant 7 (novelty) as deferred, and any output claiming A4 or
A5 is a defect, not a result.

## 3. The noise floor, measured

Two late candidates cleared their registered thresholds and then failed replication:

```
candidate    val 2.375607  (+0.0226 vs baseline)
seed 7       val 2.402319  (−0.0041 — worse than baseline)
seed 99991   val 2.387284  (+0.0110 — below the 0.015 bar)
```

The seed spread (0.027) exceeded the claimed effect (0.023). On this task, **single-seed differences
below roughly 0.03 bpc carry no information.** That retroactively validates the four accepted claims,
whose gains were 0.070–0.211, and it is a concrete instance of the multiple-comparisons failure the
audit names as F8: run enough candidates against a 0.015 threshold and some clear it by luck.

Cheap gate admits, expensive gate confirms. The division of labour worked.

## 4. Honest accounting

**73% of wall time was model reasoning; 14% was compute.** The long-horizon studies cited in
the original audit reported roughly the inverse (~90% compute). This campaign was **model-latency-bound**,
which means a stronger, slower manager costs cycles directly, and that training is nearly free at the
margin — there is headroom for much longer experiments per cycle.

**9.1% `unknown`** is the time the campaign was stopped while defects were repaired. It is reported
rather than absorbed, which is the entire point of the interval algebra.

**6 interventions, 5 frontier-changing.** This is a high number and it is the true one. Every
restart, invalidation, rollback and withdrawn accusation is recorded. A campaign that needed this
much hands-on repair should not be described as having run itself for five hours, and the card
does not describe it that way.

**27 negative results retained.** A keep/revert loop discards these; here they stay queryable and
feed the next manager's context packet, ranked ahead of merely recent items so the campaign does not
re-propose what it already refuted.

## 5. Nine defects, and what they have in common

Every defect below was found by running the system, not by reading it. Eight were **semantic** — two
components disagreeing about what a value meant — and one was a scaling limit.

| # | Defect | Consequence if shipped |
|---|---|---|
| 1 | A candidate bug (measured EMA weights, saved non-EMA) reported as cheating | fabricated fraud accusation in the evidence record |
| 2 | A passing control reported as `inconclusive` | a working measurement path recorded as a weak effect |
| 3 | A valid empty-diff control reported as an aborted cycle | the control lane starves; 4 consecutive aborts kill the run |
| 4 | Baseline pointer advanced without the metric it referred to | later candidates credited with an already-banked gain |
| 5 | Two components disagreeing on which revision was "the baseline" | every post-advance comparison invalid; 4 cycles voided |
| 6 | Repair cap read operator invalidations as live harness failures | a fresh 3-hour campaign died at cycle zero |
| 7 | Replication that could not detect its own failure | three identical runs scored as three confirmations, promoted at belief 0.99 |
| 8 | Unbounded context packet exceeded the OS argv limit | `ENAMETOOLONG` crash at cycle 16 |
| 9 | Leakage judged on distance rather than divergence | every future improvement flagged as cheating |

**None were in the model's reasoning.** The manager's hypotheses were consistently well-motivated —
ALiBi, learnable slopes, convolutional stems, and a fixed-slope ablation to test whether its own
accepted mechanism mattered. The failures were all in the harness.

**None of the eight semantic defects would have been prevented by fencing tokens, leases, epochs, or
process-tree ownership** — machinery the original technical plan front-loaded into M0. Defect 8 is the exception
that proves the rule: `03` specified a bounded, deterministic context packet, the unbounded version
was built for speed, and it crashed the run. The spec was right there and skipping it was wrong.

### 5.1 The pattern

Two defects (7 and 9) share a sharper shape, and it is the most transferable finding here:

**A check that fires correctly on data meaning something other than what it assumes is worse than no
check, because it launders a wrong conclusion through a passing gate.**

- Replication varied seeds by rewriting `config.json`. A candidate that wrote `cfg["seed"] = 12345`
  severed that channel silently; three identical runs were scored as three independent
  confirmations and a baseline advanced on top. No adversarial intent — a reasonable implementation
  of a reasonable instruction, which is exactly why capability containment would not have caught it.
- Leakage was judged by a fixed val↔holdout gap calibrated on the original baseline. The gap grows
  with model quality (0.040 → 0.158 across four improvements), so the test was on a collision course
  with the campaign's own success.

Both are **constants that did not move with the system they measured**. The general lesson: verify
that a mechanism worked rather than assuming it did, and re-derive thresholds from current state
rather than freezing them at design time.

## 6. Counterfactual status

Not yet run. The planned three-arm comparison — keep/revert loop, harness with shortcut
checks disabled, full harness — remains the outstanding validation. Until it is run, this campaign
demonstrates that the harness **can** produce replicated compounding improvements; it does not
establish that the harness is **better** than a simpler loop at equal budget.

That distinction is the audit's own standard and it applies to us.

## 7. Queued fixes

1. Derive the declared parameter surface from the current baseline's `config.json` rather than a
   hardcoded list — it went stale when an accepted candidate added a config key, and blocked a
   legitimate ablation.
2. Tie the leakage diagnostic floor to the contract's registered `support_delta` instead of a fixed
   0.02; any gain large enough to claim support is large enough to require holdout corroboration.
3. Drop the positive-`support_delta` requirement for falsify-lane contracts — a refutation
   experiment has no improvement threshold to state, and requiring one aborted a falsify cycle.
