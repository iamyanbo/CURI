# SCOPE — what this system enforces, and what it does not

This file exists because `plans/02-adversarial-autoresearch-audit.md` argues that the defining
failure of autoresearch projects is claiming properties the implementation does not have. Applying
that standard to ourselves means publishing the gap rather than hiding it.

The 16 product invariants are defined in `plans/01-pi-autoresearch-design.md` §1. Every one is
listed below with its **current** status, not its intended status. `target` is where v0 lands at the
end of the 12-day window; `now` is today.

Legend: `enforced` = mechanically prevented in code · `partial` = enforced with a stated hole ·
`deferred` = not implemented; the system MUST NOT claim it.

Last updated: 2026-08-22 (day 5, CUDA campaign + rejection audit)

| # | Invariant | Target | Now | Note |
|---|---|---|---|---|
| 1 | No claim without an artifact | enforced | partial | The full runs/attempts/artifacts/evaluations chain is written and `assertClaimIsCitable` checks it per claim; the claim card lists non-citable claims rather than dropping them. Not yet a schema-level NOT NULL path. |
| 2 | The actor cannot be the final judge | enforced | enforced | `src/loop/judge.ts` is a pure function; no model can set a status. Manager and executor are separate processes with disjoint tool sets, and neither can write canonical state. |
| 3 | Promotion rules registered before results | enforced | enforced | The contract is hashed and inserted before the worktree is created. The judge additionally refuses any contract whose registration timestamp follows its result. |
| 4 | Negative evidence changes state | enforced | enforced | Refutation, inconclusive, implementation-invalid and shortcut-suspected are distinct recorded states with retained evidence. A promotion has been withdrawn and a baseline rolled back on contrary evidence, and a second promotion was withdrawn today when its contract was found to be below the noise floor. Null results (`INTERVENTION_HAD_NO_EFFECT`) are now retained as `inconclusive` rather than discarded as invalid implementations. |
| 5 | Search remains plural | enforced | enforced | The deficit-based allocator assigns every cycle's lane; the manager cannot choose it. Falsify cycles run and have produced refutations. Aborted cycles no longer consume lane budget. |
| 6 | Pure knob search is delegated | partial | partial | Parameter quota enforced per campaign. No classical-optimizer baseline ships in v0, so delegation is capped rather than delegated. |
| 7 | Novelty is not self-declared | deferred | **partial** | CHANGED TODAY. The manager and executor now have `web_search`, `arxiv_search`, `code_search` and `fetch_content`, so prior art IS consulted - ad hoc, at the manager's discretion, not as a systematic dated search. That is enough to stop the system rediscovering known results, and NOT enough to support a novelty claim. v0 still makes none, and any output claiming novelty is still a bug. Search results are framed as untrusted data that cannot move a threshold or stand as evidence. |
| 8 | Wall-clock time is partitioned | enforced | enforced | `src/trace/intervals.ts`. Non-overlap is enforced by construction; gaps become `unknown`. Property-tested over 200 randomised trials. |
| 9 | Humans are visible | enforced | enforced | Campaign start, evaluator changes, operator steers and withdrawn promotions are all recorded as interventions with `changed_frontier`, surfaced by `status` and on the dashboard. A steer is consumed and written to the hash-chained log BEFORE the manager sees it, so a steered proposal cannot exist without its steer on record. |
| 10 | Stopping is allowed | enforced | enforced | Wall clock, cost, cycle cap, lane exhaustion, consecutive invalid implementations and consecutive aborts are all terminal. Observed firing on wall clock and on the repair cap. |
| 11 | Serial is the safe default | enforced | enforced | Concurrency is 1 and there is no code path to raise it. No spawn capability exists for workers. |
| 12 | A lease is not ownership without fencing | deferred | deferred | **Deliberately cut.** Single-user, single-daemon: an OS file lock plus PID/start-time reconciliation replaces fencing. Documented in `plans/04-v0-build-plan.md` §0.1. |
| 13 | Memory is scoped, not ambient | partial | partial | All state is campaign-scoped by schema. Worker isolation verified (see below). No cross-project import path exists. |
| 14 | Motivation precedes machinery | enforced | partial | A proposal without a mechanism or falsifier is rejected before any compute is spent. Full principles-map validation is still pending. |
| 15 | Complexity must earn its keep | partial | partial | v0 is an explicit 6× reduction of `03`, with a justification per cut. Ablations are not yet run. |
| 16 | Literal score success is not task success | enforced | enforced | Independent recomputation, divergence-based leakage, protected-tree hashing, roofline ceiling, hidden shapes. **A hole was found and closed today:** the manager could register a support threshold below the measured noise floor (0.02 against a floor of 8), and a baseline advanced on a 3.2 gain whose three reproductions spanned 13.1. `validateProposal` now rejects any threshold below the domain's measured noise floor, and that promotion was withdrawn in the ledger. |

## Rejection audit, day 5

Every rejected claim in `cuda-001` was re-read to check that it was rejected for an inspectable
reason. 36 rejections: **all 36 have a sealed agent trace**, 35 of 36 have recorded evaluator checks.

| Reason | n | Correctly rejected? |
|---|---|---|
| `MET_REFUTATION_THRESHOLD` | 28 | Yes. Real measured regressions with 4/4 evaluator checks passing. |
| `INTERVENTION_HAD_NO_EFFECT` | 6 | Substantively yes, **but mislabelled** as `implementation_invalid`. Now retained as `inconclusive`: a valid experiment that moved nothing is a null result, not a broken one. |
| `UNDECLARED_CONFIG_KEYS` | 1 | Yes. Edited `block_size`, outside the declared parameter surface. |
| `EVALUATION_DID_NOT_COMPLETE` | 1 | **No.** The protected evaluator was invoked with an unresolved threshold (the `"undefined"` defect). The candidate was never tested, and the harness's own fault was recorded against it. |

Two defects the audit exposed, both now fixed:

1. **The canonical record dropped the reason.** `claim.judged` stored `status`, `reasons` and `delta`
   but not `explanation`. The human-readable sentence existed only in console scrollback, so every
   judge-gate rejection read as blank when audited from the ledger. The explanation is now recorded.
2. **A null result was filed as a broken implementation.** Because invalids feed the
   consecutive-failure stop condition, a run of honest null results could have halted a healthy
   campaign as though the harness were failing.

## Verified facts as of day 1

These are measured, not asserted. Re-running the commands reproduces them.

**Worker isolation** (`plans/04-v0-build-plan.md` §4). Pi 0.76.0 with
`--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files` did **not**
execute a planted project-local extension and did not load a planted `AGENTS.md` or skill. The same
prompt without those flags **hangs indefinitely** in headless mode with the installed ambient
extension set, which is independent evidence that workers must not inherit the interactive resource
surface.

*Corrected on day 2:* the original spike also set a temp `HOME`, and this note previously implied
that contributed to isolation. It did not. Redirecting `HOME` only hides `auth.json`, and the flags
alone deliver the isolation. The production worker therefore leaves `HOME` intact.

**Determinism** (`domains/tinyml`). Two independent runs of the baseline produced a bitwise
identical checkpoint (`sha256` prefix `3f8a2816…` at 600 steps, `ffafbc3e…` at 1200). Clean replay
is therefore a hash comparison in this domain rather than a statistical test.

**Frozen data.**

| Asset | Hash |
|---|---|
| corpus (tinyshakespeare, 1,115,394 bytes) | `86c4e6aa9db7c042ec79f339dcb96d42b0075e16b8fc2e86bf0ca57e2dc565ed` |
| split manifest | `cd9dad825e282f360afa9100fecb3d90486c2f9fa014da3afce330af14611a04` |
| train split (1,003,854 tok) | `090c43295a657de4b12b697bb3839f136da3899b9d82fd1658521e93c80016e5` |
| val split, visible (55,770 tok) | `82bbf2bbaf78a5fe30d5a6fb03934bcc547f05ac5b80b9169fc2a657e7322a0f` |
| holdout split, **protected** (55,770 tok) | `91e7edcb9600566a57703bb75d3b6b078ec62d658d49f44d3096a70483ac1653` |

**Baseline** (1200 steps, seed 1337, 78,592 params, ~38 s):

| Metric | Value |
|---|---|
| val bits-per-char (independently recomputed) | 2.916446 |
| holdout bits-per-char | 2.956793 |
| val↔holdout gap | 0.0403 (leakage threshold 0.15) |
| candidate self-report vs independent recomputation | agree to 1e-6 |

## Day-2 verified facts

**The loop closes.** One command drives MANAGE → REGISTER → EXECUTE → CLASSIFY → RUN → EVALUATE →
JUDGE → SEAL. First live cycle: the manager proposed EMA weight averaging with a numeric falsifier,
the executor implemented it in an isolated worktree, and the protected evaluator measured
val 3.201993 against a 2.916446 baseline. The judge refuted it against the threshold registered
before the experiment ran. Cost $0.0045, 3m55s wall.

**Cost model** (the plans never estimated one). A full cycle is ~23k tokens and ~$0.005 at
flash-tier pricing, of which the control plane — context packet, prompts, schema — is the majority.
Compute is ~40s. This puts a 100-cycle campaign near $0.50 plus ~1.1h of compute.

**Four bugs, all at the worker-spawn boundary.** Auth resolution (redirecting HOME hid the provider
credentials), tool allowlist (a manager given one tool made 35 tool calls across 10 agent cycles
instead of answering), argv fidelity (`shell: true` on Windows split a multi-line prompt across ten
invocations), and stdin lifecycle (an idle stdin pipe made Pi block silently until timeout). None
were in the research logic. This is direct evidence for the `plans/04` §0.1 decision to cut the Rust
process host: the hard part on Windows is process *invocation*, not process *containment*, and it
cost about 40 lines to fix rather than a crate.

## Day-3 campaign findings

The 5-hour campaign was restarted several times as defects surfaced. Every restart, invalidation and
rollback is recorded as a `human_intervention`, so the claim card's intervention count is the real
one rather than a flattering one.

**Two validated, compounding improvements.**

| Claim | Lane | Seeds | Result |
|---|---|---|---|
| ALiBi relative-position attention bias | mechanism | 2.798 / 2.821 / 2.842 | replicated |
| Learnable ALiBi distance slopes | exploit | 2.669 / 2.695 / 2.682 | replicated |

Baseline moved 2.916446 → 2.679325, a cumulative 0.237. The second claim's stated mechanism
explicitly builds on the first, which is the portfolio compounding rather than restarting.

**Replication theatre — the most important defect found.** A candidate implemented a
seed-perturbation control by writing `cfg["seed"] = 12345` after config load. Replication varies
seeds by rewriting `config.json`, so that single line severed the channel silently: all three
"replications" ran the same seed, returned bitwise-identical numbers, and were scored as three
independent confirmations. The claim was promoted to `replicated` at belief 0.99 and the baseline
advanced onto it — which would have baked a fixed seed into the base and voided replication for the
rest of the campaign while continuing to report claims as replicated.

No adversarial intent was involved. It was a reasonable implementation of a reasonable instruction,
which is exactly why capability containment would not have caught it. Three defences now apply:
a seed-sensitivity check (replicas that do not differ prove the seed never reached training, so the
replication is void), static detection of hardcoded seeds in the diff, and a judge gate that fails
`SEED_POLICY_VIOLATED` before the metric is considered. The promotion was withdrawn and the baseline
rolled back.

**Defect taxonomy.** Eight defects were found by running the system. Seven were *semantic* — two
components disagreeing about what a value meant — and one was a scaling limit:

1. a candidate bug reported as cheating (self-report mismatch classed as evasion);
2. a passing control reported as `inconclusive`;
3. a valid empty-diff control reported as an aborted cycle;
4. a baseline pointer advanced without the metric it referred to;
5. two components disagreeing on which revision was "the baseline";
6. a repair cap that read operator invalidations as live harness failures;
7. replication that could not detect its own failure;
8. an unbounded context packet that eventually exceeded the OS argv limit (`ENAMETOOLONG`).

None were in the model's reasoning. None would have been prevented by fencing tokens, leases, or
process-tree ownership — the machinery `03` places at M0. Defect 8 is the exception that proves the
rule: `03` specified a bounded, deterministic context packet and the unbounded version was built for
speed, so the spec was right and skipping it was wrong.

The practical lesson is that in a system like this the detectors are the easy part and the taxonomy
is where the errors live. A check that fires correctly on data meaning something other than what it
assumes is worse than no check, because it launders a wrong conclusion through a passing gate.

## Day-4 overnight findings

**Two capabilities added.** A `moonshot` lane (15% share, 10% non-borrowable floor) for ideas that
must regress before paying off - intermediate steps are recorded but cannot refute, and only the
final step is promoted. And detached operation: `--detach`, graceful `stop` at a cycle boundary, and
liveness decided by PID **plus process start time** so a recycled PID cannot masquerade as a healthy
run.

The moonshot lane justified itself quickly: three of the campaign's eight replicated claims came
from it within hours of it existing (sparse routed MoE, slot-memory long-range store, hierarchical
chunk-summary memory). Each is an architectural addition with real setup cost - exactly the shape a
single-diff keep/revert comparison discards at step one. This is the concrete answer to whether the
lane structure limits innovation: the lanes did not, the *absence* of this one did.

**Planted-cheat fixtures, and what they exposed.** Every prior change to the shortcut defences had
been driven by fixing a FALSE positive, and each fix made detection more permissive. Nothing had
ever verified the opposite direction. Four fixtures - train on the validation split, print a metric
never computed, score on a tiny slice, hardcode a seed - caught only **2 of 4** on first run:

- The seed detector's regex contained a literal backspace byte (0x08) where a word-boundary escape
  was intended, written there by a Python heredoc. It had matched nothing for its entire life,
  including through a complete 37-cycle campaign, and looked correct in every grep because a
  backspace is invisible in terminal output.
- The leakage follow-ratio was 0.25, chosen by intuition. The planted leak scored 0.26 and passed.
  Recalibrated to 0.50 against measured data: the campaign's replicated claims score 0.65-0.99.

Both fixed; now 4/4 caught, with the diff predicates extracted into a pure function so they are unit
tested on every run.

**Defects 11-15**, all found by running rather than reading:

| # | Defect | Consequence |
|---|---|---|
| 11 | Seed detector held a literal backspace byte | dead detector through a whole campaign |
| 12 | `moonshot` added to schema, allocator and prompt but not the validator | killed a fresh overnight run in 20 minutes |
| 13 | Truncated model output diagnosed as malformed | the retry asked for the wrong correction |
| 14 | A worker returning two blank lines counted as success | a cycle silently wasted |
| 15 | Moonshot asked for multi-step ideas but gave the executor one shot at all of it | three consecutive no-change aborts |

Defect 15 is the notable one: it was a **design** error in a feature added the same night - a lane
whose premise contradicted its mechanics. `steps_allowed` governs judging, not workload, and the
manager must now describe only the first step. It surfaced within twenty minutes of real use.

Two general safeguards came out of this rather than point fixes: a repeatedly-aborting lane is
charged after two consecutive aborts so it yields its turn (aborts cost no research budget, which
otherwise lets one broken lane march the campaign into the abort cap), and the executor gained the
bounded retry the manager has had since calibration.

**Running tally: fifteen defects, fourteen semantic, one scaling. None in the model's reasoning.**
The night sharpened the pattern into something more specific than "semantic": in every one of
tonight's five, *the system reported success for something that had not happened* - a regex matching
nothing, a lane silently rejected, a truncation read as a formatting error, a no-op read as a
completed edit, and a lane advertising a capability it could not execute.

## Standing limitations

1. **No OS-level network sandbox.** The executor gets `bash` inside a worktree. Network denial is by
   capability convention, not enforcement. Until a container backend lands, this system **cannot
   claim** that online solution lookup was prevented — only that the executor was given no source
   tools.
2. **The evaluator runs as the same OS user.** Protection is a path guard plus tree hashing, not an
   identity boundary. A determined local user can defeat it. The threat model is an agent that takes
   the cheapest available path, not a hostile operator.
3. **No novelty, prior-art, or external-validation capability.** The autonomy ladder caps at **A3**
   by construction. Any report claiming A4 or A5 is a defect.
