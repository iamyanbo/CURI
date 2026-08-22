# Handoff — Adversarial Autoresearch

Updated 2026-08-22 after the Genkit/Google Cloud migration pass.

## Current state

- The active runtime is independent of the former agent harness. Manager, executor, and setup calls use Gemini through Genkit in fresh child processes.
- Local operation remains supported with Gemini API authentication, Git worktrees, local evaluators, SQLite, and the local dashboard.
- Search remains available through Google Search grounding plus bounded public HTTP, arXiv, and GitHub adapters. The finance domain deliberately disables it to protect its temporal holdout.
- The former implementation is archived at `C:\Users\yanbo\downloads\pi-autoresearch`. `README-ARCHIVE.md` documents exclusions; `ARCHIVE-SHA256.json` covers 8,970 files; the archived 1,660-event global chain was verified.
- The pre-migration baseline is Git commit `c1ccfa4`.

## Correctness changes completed

- Evaluators declare measurement resolution. The judge reports `NO_MEASURABLE_EFFECT` when a value is indistinguishable at that resolution instead of claiming exact equality.
- Temporal-fold replication measures candidate and baseline on the same held-back window.
- CUDA compilation uses the runtime architecture instead of hard-coded `sm_86`.
- The attention domain is explicitly fp32-only and rejects tensor-core, WMMA, MMA, TF32, and cuBLAS escape paths.
- Worker file tools reject traversal and protected paths. Process tools have no shell, block inline Python/Node execution and installers, and public fetches resolve DNS and re-check redirects against private/metadata addresses.

## Google Cloud pieces completed

- Transactional, hash-chained Firestore ledger and verified SQLite-to-Firestore migration.
- Local and GCS artifact stores with SHA-256 verification and create-only object writes.
- Versioned Cloud Run task protocol, L4 batch dispatcher, and protected evaluator entrypoint.
- CUDA 12.2 evaluator image and Terraform for required APIs, Artifact Registry, private bucket, Firestore, least-privilege evaluator identity, a three-task L4 job, and optional $25 alerts.
- Runtime doctor and fail-closed profile checks.

## Remaining production work

The hackathon path is usable, but two items are intentionally not represented as complete:

1. The authoritative coordinator still runs locally with SQLite. Firestore is implemented as a transactional ledger/migration target, not yet as a full replacement for every mutable SQL projection. A broad `ResearchStore` refactor is required before `campaign --store firestore` should be enabled.
2. Cloud Run is wired for protected batch evaluation through `cloud-evaluate`; the normal campaign replication loop has not yet been made asynchronous. Until that refactor, the cloud profile fails closed instead of silently falling back.

No GCP resources were created during this pass. The machine's selected project, `poised-journey-258020`, appeared unrelated and was left untouched. Create a dedicated hackathon project, attach billing, install Terraform, and follow `README.md`.

`npm audit --omit=dev` currently reports 59 transitive advisories (7 high, 52 moderate, 0 critical), primarily in Genkit's OpenTelemetry/Firebase dependency tree. The installed Genkit release offers no supported fix. Do not expose Genkit telemetry endpoints publicly; re-audit before deployment and upgrade when Google publishes a compatible release.

## Before the demo

1. Set a Gemini API key and run `npm test`, `npm run typecheck`, and the relevant domain doctor.
2. Run a short local attention campaign and save one good trace plus one rejected planted-cheat trace.
3. Create the dedicated cloud project, apply `infra/`, build/push the evaluator image, and confirm L4 quota in `us-central1`.
4. Run `cloud-evaluate` once before presentation day. Cloud GPU capacity is not a safe first-time live dependency.
5. Keep local mode as the live fallback. It is a supported execution profile, not a degraded simulation.
