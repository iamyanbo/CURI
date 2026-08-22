# Adversarial Autoresearch

An autonomous experiment harness that tries to disprove its own results. Gemini proposes and implements bounded changes; protected, deterministic code measures them; a pure judge decides the verdict. Thresholds are registered before execution, negative results stay in the ledger, and only replicated claims may advance the baseline.

The active repository has no dependency on the former agent harness. Its complete pre-migration snapshot is preserved separately at `C:\Users\yanbo\downloads\pi-autoresearch`, including a SHA-256 manifest and verified SQLite event chain.

## Local quick start

Requirements: Node.js 22.19+, Git, Python for the example domains, and a Gemini API key. CUDA domains additionally require an NVIDIA GPU and `nvcc`.

```powershell
npm ci
$env:GEMINI_API_KEY = "..."
npm run typecheck
npm test
npx tsx src/cli.ts doctor --profile local
npx tsx src/cli.ts domain-doctor --domain domains/attention.domain.json
npx tsx src/setup.ts "optimize fused fp32 attention with CUDA"
npx tsx src/cli.ts campaign --campaign attention-demo --domain domains/attention.domain.json --hours 1 --max-cost 5
```

Local mode uses Gemini through Genkit, isolated child processes, local Git worktrees, local compute, and SQLite. It retains search: Google Search grounding, public-page retrieval with SSRF guards, arXiv search, and GitHub code search. Finance disables agent search because current web results would leak into its temporal holdout.

Run the read-only dashboard with:

```powershell
npx tsx src/ui/server.ts
```

Then open `http://127.0.0.1:4791`.

## Cloud evaluator path

Cloud mode uses Vertex AI authentication, Cloud Run Jobs with one L4 per task, a private versioned Cloud Storage bucket, and Firestore ledger support. Protected evaluator tasks never judge or promote a candidate; they only return measurements and checks to the coordinator.

1. Create a dedicated GCP project and attach billing. Do not reuse an unrelated project.
2. Build and push `Dockerfile.evaluator`, then pin its image digest in `infra/terraform.tfvars`.
3. Apply `infra/`. It enables APIs, creates Firestore, Artifact Registry, the private bucket, a least-privilege evaluator service account, the GPU job, and an optional $25 alert budget.
4. Authenticate locally with Application Default Credentials and set the outputs:

```powershell
gcloud auth application-default login
$env:GOOGLE_CLOUD_PROJECT = "your-new-hackathon-project"
$env:AR_ARTIFACT_BUCKET = "your-new-hackathon-project-autoresearch-artifacts"
$env:AR_EVALUATOR_JOB = "autoresearch-evaluator"
npx tsx src/cli.ts doctor --profile cloud
npx tsx src/cli.ts cloud-evaluate --profile cloud --domain domains/attention.domain.json --campaign attention-demo
```

`cloud-evaluate` is the current GPU batch boundary. The main campaign coordinator intentionally fails closed if asked to use `--compute cloud-run` or `--store firestore`; this prevents cloud-looking flags from silently writing authoritative state locally. Use `npm run migrate:firestore -- --project PROJECT --commit` to copy and verify an existing local ledger in an empty Firestore namespace.

## Hackathon runbook

- Demo the full scientific loop locally first; it is the reliable path.
- Use `cloud-evaluate` for the visible three-way L4 reproduction batch if quota and billing are ready.
- Keep `--max-cost` at or below `$20`; the Terraform budget alert is `$25`, but alerts are not hard spending caps.
- The software ceiling uses current standard token list prices and conservatively charges grounded search queries even while a free allowance may apply. Override rates only with `AR_INPUT_USD_PER_MILLION`, `AR_OUTPUT_USD_PER_MILLION`, and `AR_SEARCH_USD_PER_QUERY` after checking current billing.
- Pre-build and pin the evaluator image. Never compile the deployment image during the live demo.
- Show a planted cheat being rejected, a quantized no-effect verdict, a replicated claim, and the immutable event-chain verification.
- If cloud credentials or GPU capacity fail, continue the same campaign locally; the core semantics and search capabilities are identical.

## Useful commands

```text
npx tsx src/cli.ts init
npx tsx src/cli.ts cycle --campaign ID --domain PATH
npx tsx src/cli.ts campaign --campaign ID --domain PATH --hours N --max-cost N
npx tsx src/cli.ts status --campaign ID
npx tsx src/cli.ts verify --campaign ID
npx tsx src/cli.ts stop --campaign ID
npx tsx src/cli.ts doctor --profile local|cloud
npx tsx src/cli.ts domain-doctor --domain PATH
npx tsx src/cli.ts cloud-evaluate --profile cloud --domain PATH --campaign ID
```

See `SCOPE.md` for the trust boundary and `plans/06-findings.md` for the defect history that shaped it.
