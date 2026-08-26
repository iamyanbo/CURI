# Scope and trust boundary

CURI is a bounded autonomous experimentation system, not proof that arbitrary scientific claims are true.

## Enforced by code

- Manager and executor are separate, fresh Genkit processes with explicit tools and deadlines.
- Candidate changes happen in isolated Git worktrees and are reduced to sealed diffs.
- Protected evaluator paths are unavailable to workers.
- Support/refute thresholds are registered before an experiment.
- Model prose and self-reported metrics never choose a verdict.
- The pure judge distinguishes integrity failures, shortcuts, leakage, refutation, measurable support, and effects below measurement resolution.
- Replication semantics belong to the domain: seed, resample, temporal fold, or independent run.
- Temporal folds use a paired baseline from the same time window.
- Planted cheats exercise the exact defensive checks a domain claims to have.
- Events form a verifiable SHA-256 chain; Firestore appends serialize through a transactional global head.
- Cloud evaluator tasks can measure and check, but cannot promote baselines or mutate the scientific ledger.
- Cost, cycle, repair, and wall-clock ceilings stop unattended campaigns.

## Not guaranteed

- A generated evaluator is not automatically scientifically adequate. A domain expert must review its metric, holdout, causal assumptions, and cheat fixtures.
- Budget alerts are notifications, not hard billing caps. The coordinator's `--max-cost` is the active software ceiling.
- Web evidence may be incomplete or wrong. Search results are leads, not experimental evidence.
- Process isolation is capability reduction, not a hardened hostile-code sandbox. Run untrusted candidates inside an OS/container sandbox with restricted egress.
- Statistical replication does not establish external validity.
- Firestore is not yet the live projection store for a normal campaign; only the ledger and migration path are implemented.
- Cloud Run batch evaluation is not yet called automatically by the normal campaign loop.

## Domain-specific limits

- Attention and CUDA results are hardware-specific. The attention contract is fp32-only; its current roofline model must be reviewed for any GPU family not represented by the tested evaluator.
- The finance example uses synthetic daily equities and Sharpe-like scoring. It demonstrates temporal leakage defenses, not a production trading strategy.
- TinyML results depend on the fixed corpus, model, and evaluator contract.

The guiding rule is simple: the protected evaluator is the research contribution. The orchestration around it is only trustworthy to the extent that evaluator encodes the right failure modes.
