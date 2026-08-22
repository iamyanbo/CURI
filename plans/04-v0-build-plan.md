# pi-autoresearch v0 — 12-Day Build Plan

Status: plan of record for the hackathon window
Date: 2026-08-20
Supersedes: `03-pi-autoresearch-technical-spec.md` **for the v0 window only**. `03` remains the
long-term target; this document is the subset that ships in 12 days and becomes a daily driver.
Motivation and audit rationale remain `01` and `02`.

Design rule for this document: if it is longer than it needs to be, it has already failed. `03` is
1761 lines and unbuildable in the window. This is the executable subset.

---

## 0. Scope contract

**v0 is:** a local, single-user, single-machine research runtime that runs bounded Pi workers
against a deterministic CPU-ML task, pre-registers every experiment, judges results with
deterministic code, detects planted shortcuts, retains negative results, and reports its own
activity honestly.

**v0 is not:** multi-host, concurrent, GPU-capable, network-sandboxed at the OS level, or protected
against a hostile local user. Those are `03`'s job, not this window's.

### 0.1 Deliberate cuts from `03`

| Cut | Justification for a single-user local tool |
|---|---|
| Fencing tokens, supervisor epochs | One daemon, one machine. OS file lock + PID/start-time check. |
| Outbox/inbox delivery protocol | No network hop. Direct spawn + on-disk `completion.json` is durable. |
| `ar-process-host` (Rust) | Node `child_process` with detached process groups; documented Windows orphan risk. |
| HMAC-signed evaluations | Closes no threat when the daemon holds the key and spawns the evaluator itself. |
| 20-edge crash matrix | Reduced to 4 edges (§7.2). |
| Concurrency admission, decomposition proof, circuit breaker | Concurrency is fixed at 1. |
| Web viewer, SSH/Slurm/Docker/K8s backends | Local process only. |
| Separate-OS-identity evaluator | Protected directory + path guard + hash check; downgrade is recorded. |
| Migrations, rollback, upgrade, doctor | No installed base yet. |

### 0.2 Invariant enforcement table (ships as `SCOPE.md`)

The 16 invariants of `01:§1`, each marked `enforced` / `partial` / `deferred` with a reason. This
file is a demo asset, not an apology. Silently violating your own invariants is the exact failure
`02` was written to prevent.

Expected v0 status: enforced 1, 2, 3, 4, 5, 8, 9, 10, 11 · partial 6, 13, 16 · deferred 7, 12, 14, 15.

---

## 1. First domain: `tinyml` adapter

**Task.** Char-level language model on a fixed ~1 MB text corpus. PyTorch CPU, ~50k params. Metric:
validation bits-per-char on a held-out split. Target runtime **30–60 s per experiment.**

**Why this task.** It is the modded-nanogpt / Karpathy `autoresearch` lineage, so the baseline
comparison is direct and the audience already understands the setup. It has a real mechanism space
(optimizer, init, normalization, mixing architecture, tokenization) *and* a real parameter space
(lr, batch, weight decay), which is what makes the tuning-vs-mechanism classifier meaningful.

**Determinism contract.** Bitwise reproducibility is required and achievable here — this is why the
first domain is CPU. The runner sets:

```
OMP_NUM_THREADS=1, MKL_NUM_THREADS=1
torch.use_deterministic_algorithms(True)
torch.manual_seed(s); numpy.random.seed(s); random.seed(s)
DataLoader(num_workers=0, shuffle=deterministic generator)
```

Clean replay is then a hash comparison, not a statistics problem. `03`'s `requireCleanReplay: true`
becomes tractable instead of pathological. Any drift under identical seed and identical env hash is
a genuine red flag.

**Protected assets.** `.autoresearch-protected/` holds the evaluator, the held-out split, the hidden
OOD split, and the metric parser. The executor path guard rejects all writes there, and the daemon
hashes the tree before and after every run.

**Change classification.** `parameter` = edits confined to a declared config surface (lr, batch, wd,
steps, warmup). Everything else — optimizer implementation, init scheme, architecture, data
pipeline, loss — is `mechanism`. The classifier runs on the diff, not on the model's self-report.

---

## 2. Reduced schema — 14 tables

Fixes C1 (lanes), C3 (claim vocabulary), and C5 (human interventions) from the review of `03`.
Claims are folded into `hypotheses`: in v0 a hypothesis is the claim carrier.

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;

CREATE TABLE campaigns (
  campaign_id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','ready','running','paused','stopped','completed','failed')),
  base_revision TEXT NOT NULL,              -- current baseline commit; advanced only via §5
  revision INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL, created_at TEXT NOT NULL, stop_reason TEXT);

CREATE TABLE principles (
  principles_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  revision INTEGER NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
  rationale TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(campaign_id, revision));

CREATE TABLE hypotheses (
  hypothesis_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  principles_id TEXT NOT NULL REFERENCES principles,
  lane TEXT NOT NULL CHECK (lane IN ('control','exploit','mechanism','falsify')),   -- C1 fix
  title TEXT NOT NULL, mechanism TEXT NOT NULL, motivation TEXT NOT NULL,
  falsifier TEXT NOT NULL, change_class TEXT NOT NULL,
  -- C3 fix: one vocabulary, matching 01:§3.3 and the A0-A5 ladder
  status TEXT NOT NULL CHECK (status IN ('proposed','tested','provisionally_supported',
     'replicated','externally_validated','refuted','inconclusive',
     'implementation_invalid','shortcut_suspected','abandoned')),
  belief_advisory REAL,                     -- model-proposed; scheduler MUST NOT read
  belief_derived REAL,                      -- computed by registered rule over verified evidence
  revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE contracts (
  contract_id TEXT PRIMARY KEY, hypothesis_id TEXT NOT NULL REFERENCES hypotheses,
  revision INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('registered','superseded','cancelled')),
  primary_metric TEXT NOT NULL, direction TEXT NOT NULL,
  baseline_hash TEXT NOT NULL, dataset_hash TEXT NOT NULL, split_hash TEXT NOT NULL,
  evaluator_hash TEXT NOT NULL, seed_policy_json TEXT NOT NULL,
  threshold_json TEXT NOT NULL, budget_json TEXT NOT NULL,
  refutation_json TEXT NOT NULL, shortcut_checks_json TEXT NOT NULL,
  contract_hash TEXT NOT NULL UNIQUE, registered_at TEXT NOT NULL,
  UNIQUE(hypothesis_id, revision));

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  hypothesis_id TEXT REFERENCES hypotheses, contract_id TEXT REFERENCES contracts,
  kind TEXT NOT NULL CHECK (kind IN ('manager','executor','compute','evaluation','replay','report')),
  state TEXT NOT NULL CHECK (state IN ('queued','active','succeeded','failed','cancelled','exhausted')),
  max_attempts INTEGER NOT NULL DEFAULT 3, attempt_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, terminal_at TEXT);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs,
  attempt_no INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN
    ('planned','starting','running','sealed','succeeded','failed','cancelled','lost','quarantined')),
  pid INTEGER, process_start_id TEXT, spawn_nonce TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL, model_spec_json TEXT, exit_code INTEGER,
  failure_code TEXT, started_at TEXT, completed_at TEXT, UNIQUE(run_id, attempt_no));

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY, artifact_hash TEXT NOT NULL, campaign_id TEXT NOT NULL REFERENCES campaigns,
  attempt_id TEXT NOT NULL REFERENCES attempts, kind TEXT NOT NULL,
  relative_path TEXT NOT NULL, byte_length INTEGER NOT NULL,
  manifest_json TEXT NOT NULL, sealed_at TEXT NOT NULL,
  UNIQUE(attempt_id, kind, artifact_hash));

CREATE TABLE evaluations (
  evaluation_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  attempt_id TEXT NOT NULL REFERENCES attempts, contract_id TEXT NOT NULL REFERENCES contracts,
  candidate_hash TEXT NOT NULL, evaluator_hash TEXT NOT NULL, environment_hash TEXT NOT NULL,
  result_json TEXT NOT NULL, primary_value REAL, baseline_value REAL,
  passed_primary INTEGER NOT NULL, passed_replay INTEGER NOT NULL,
  passed_leakage INTEGER NOT NULL, passed_shortcut INTEGER NOT NULL,
  accepted_at TEXT NOT NULL, UNIQUE(attempt_id, result_json));

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  hypothesis_id TEXT REFERENCES hypotheses, attempt_id TEXT REFERENCES attempts,
  evaluation_id TEXT REFERENCES evaluations, source_id TEXT REFERENCES sources,
  artifact_id TEXT REFERENCES artifacts,
  kind TEXT NOT NULL CHECK (kind IN ('metric','counterexample','replication','provenance',
     'leakage','shortcut','negative_result','observation')),
  polarity TEXT NOT NULL CHECK (polarity IN ('supports','weakens','refutes','neutral')),
  statement TEXT NOT NULL, strength_rule TEXT NOT NULL,   -- rule id, not a model-authored float
  status TEXT NOT NULL CHECK (status IN ('proposed','verified','rejected','superseded')),
  created_at TEXT NOT NULL);

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  provider TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT,
  retrieved_at TEXT NOT NULL, content_hash TEXT NOT NULL, raw_artifact_id TEXT REFERENCES artifacts,
  source_class TEXT NOT NULL, reliability TEXT NOT NULL CHECK (reliability IN ('primary','secondary','lead')),
  metadata_json TEXT NOT NULL, UNIQUE(campaign_id, canonical_url, content_hash));

CREATE TABLE budgets (
  campaign_id TEXT NOT NULL REFERENCES campaigns,
  lane TEXT NOT NULL, category TEXT NOT NULL,
  allocated REAL NOT NULL, consumed REAL NOT NULL DEFAULT 0,
  reserved_floor REAL NOT NULL DEFAULT 0,          -- falsify-lane floor is non-borrowable
  PRIMARY KEY (campaign_id, lane, category));

CREATE TABLE human_interventions (                  -- C5 fix: the honesty metric gets a home
  intervention_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  kind TEXT NOT NULL CHECK (kind IN ('start','pause','resume','stop','scope_change',
     'budget_change','config_change','manual_fix','hint','approval','restart')),
  changed_frontier INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL, occurred_at TEXT NOT NULL);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
  campaign_id TEXT REFERENCES campaigns, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL, event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN
    ('supervisor','manager','executor','compute','evaluator','human','system')),
  attempt_id TEXT REFERENCES attempts, idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
  prev_chain_hash TEXT, chain_hash TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL);

CREATE TABLE intervals (
  interval_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns,
  attempt_id TEXT REFERENCES attempts, resource_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('model_reasoning','tool_execution','compute',
     'evaluation','queue','blocked','sleep','supervisor','human','unknown')),
  started_at TEXT NOT NULL, ended_at TEXT, metadata_json TEXT NOT NULL);

CREATE INDEX idx_runs_sched ON runs(campaign_id, state, created_at);
CREATE INDEX idx_intervals_res ON intervals(campaign_id, resource_id, started_at);
CREATE INDEX idx_evidence_hyp ON evidence(hypothesis_id, status, kind);
CREATE INDEX idx_events_seq ON events(campaign_id, seq);
```

Note on `events`: `03` had `UNIQUE(aggregate_kind, aggregate_id, aggregate_revision)`, which breaks
any transaction emitting two events for one aggregate. Dropped here; ordering comes from `seq` and
integrity from `chain_hash`.

### 2.1 Interval algebra (specify once, test as a property)

Per `resource_id`, intervals are half-open `[start, end)` and MUST NOT overlap. Model reasoning is
provider-request-to-final-response **minus** observed tool spans. Compute is process spawn to
terminal observation. Any unaccounted gap becomes an explicit `unknown` interval — never dropped.

Property test: for every campaign, `Σ(categories) == span` exactly, with `unknown` reported in the
decomposition. This is the invariant behind the whole honest-accounting claim, so it gets a test.

---

## 3. The loop

```
RECONCILE  (no model)  adopt/kill orphans by pid+start-time, close stale intervals
 -> SELECT    (no model)  lane floors, budgets, admissible hypotheses -> next decision
 -> MANAGE    (model)     one bounded call: context packet in, proposal bundle out
 -> REGISTER  (no model)  validate + freeze contract; hash everything; THEN work may start
 -> EXECUTE   (model)     one bounded call in a clean worktree: candidate diff, no verdict
 -> CLASSIFY  (no model)  diff -> change_class; reject protected-path writes
 -> RUN       (no model)  spawn training; release the model while it runs
 -> EVALUATE  (no model)  protected evaluator, independent parser
 -> REPLAY    (no model)  clean re-run, bitwise compare
 -> SHORTCUT  (no model)  §6 checks
 -> JUDGE     (no model)  pure function: (evaluation, contract) -> status
 -> SEAL      (no model)  artifacts + evidence become immutable
 -> back to SELECT
```

Two rules carry most of the value:

1. **Only MANAGE and EXECUTE call a model.** Everything else is deterministic code. This is what
   makes the time decomposition honest and the cost bearable.
2. **No timer ever says "continue."** Timers emit typed events only. When all runs are terminal and
   no hypothesis is admissible, a `campaign_idle` event triggers **one** bounded "propose or stop"
   manager call, capped at 3 consecutive. Then the campaign stops and says why. This closes the
   idle-deadlock gap in `03:§12`.

### 3.1 Lane policy

Default allocation over the campaign run budget: `control` 25% · `exploit` 30% · `mechanism` 30% ·
`falsify` 15%. The `falsify` floor is non-borrowable — no lane can consume it, ever, including when
it is the only lane with budget left. Unlike `03:1128`, this holds from the first hypothesis rather
than from the third: early commitment is precisely when falsification matters most.

Parameter-only experiments draw from `exploit` and are capped at 20% of total runs. When that quota
is exhausted the manager must propose a mechanism-class change or stop for lack of a motivated path.

---

## 4. Worker protocol (minimal)

**Verified against the installed Pi 0.76.0 on 2026-08-20** — every flag below exists, so the SDK
`ResourceLoader` surgery of `03:§11.1` is unnecessary. Workers are plain child processes:

```
pi --mode json --session-dir <attempt>/pi-session \
   --no-extensions -e <autoresearch-worker> \
   --no-skills --no-prompt-templates --no-themes --no-context-files \
   --tools <role allowlist> --model <provider/id:thinking>
```

Run it with a temp `HOME` as belt-and-braces, and assert the resolved resource manifest is empty at
startup — fail closed if anything unexpected loaded.

- `command.json` written atomically before spawn: role, context packet path + hash, role prompt path
  + hash, model, tool allowlist, budgets, output dir, response schema.
- `completion.json` written atomically on exit, including controlled failures.
- Manager tools: `state_read`, `evidence_query`, `source_search`, `source_fetch`,
  `hypothesis_propose`, `contract_propose`, `run_propose`.
- Executor tools: `state_read`, `evidence_query`, read/grep/find, edit/write/bash **in the candidate
  worktree only**, `artifact_stage`. **No source tools** — C4 fix: online lookup during
  implementation is a forbidden shortcut, so the executor cannot reach the network by design.
- Neither role can spawn, fork, or write canonical state. Everything mutating is a *proposal*; the
  reducer alone makes anything canonical.

---

## 5. Baseline advance

`01:§5.1` removed winner-descend without replacing it, which means a campaign can never compound.
v0 adds an explicit gated operation:

`campaigns.base_revision` advances only when a hypothesis reaches `replicated` (≥3 seeds, clean
replay passed, all shortcut checks passed, delta beyond the pre-registered threshold) **and** the
advance is recorded as a decision event. Open lanes rebase onto the new base; any in-flight contract
whose `baseline_hash` no longer matches is closed as `superseded` and must be re-registered.

Human approval on advance is configurable; default on for v0 so you see every compounding step.

---

## 6. Shortcut fixtures — the demo core

Four planted cheats, each a candidate diff that improves the visible metric while violating the task:

1. **Label leak** — folds validation text into the training stream.
2. **Hardcoded eval** — special-cases the known validation batch.
3. **Parser spoof** — prints a fabricated metric line to stdout that a naive parser would trust.
4. **Seed shopping** — silently sweeps seeds and reports only the best.

Detection order: diff/dependency scan → protected-tree hash check → independent parser recompute →
clean bitwise replay → hidden/OOD split → seed-policy conformance. Anything unexplained fails closed
as `shortcut_suspected`. The candidate and its trace are **kept and displayed**, never deleted — a
caught cheat is evidence, and it is the most interesting thing on screen.

Acceptance: all four are caught, none becomes supporting evidence, and each produces a legible
one-line explanation of *which* check caught it.

---

## 7. Testing

### 7.1 Property and unit

Interval sum (§2.1) · contract immutability after registration · judge purity (same inputs → same
status) · diff classifier against a labeled fixture set · path-guard escape via symlink/junction ·
lane-floor non-borrowability · duplicate completion → one seal.

### 7.2 Crash matrix — 4 edges, not 20

Kill the daemon (a) before spawn, (b) after spawn but before the handle is recorded, (c) after
`completion.json` is written but before ingest, (d) mid-seal. Each restarts, reconciles, and asserts:
one canonical disposition, no unowned live process, no double budget commit, explicit recovery trace.

### 7.3 The counterfactual (this is the demo)

Same task, same total run budget, three arms:

| Arm | Expected outcome |
|---|---|
| Karpathy-style keep/revert loop | Accepts at least one cheating candidate; reports a great number |
| v0 harness, shortcut checks disabled | Accepts it too — proves the checks are what matter, not the orchestration |
| v0 harness, full | Rejects all four; final claim card reports a smaller, true improvement |

Pre-register this comparison before running it. Publish all three arms, including the one where the
harness looks worse on the headline metric. That is the point.

---

## 8. Claim card

Emitted per campaign, machine-generated, never hand-edited:

```
CAMPAIGN  tinyml-speedrun-003              STATUS  stopped: portfolio exhausted
SPAN      14h 22m
  model reasoning   1h 04m   (7.4%)      compute        9h 51m  (68.6%)
  tool execution      38m    (4.4%)      evaluation     1h 12m   (8.4%)
  queue/blocked       47m    (5.5%)      sleep/unknown    50m    (5.7%)
HUMAN     6 interventions (1 changed the frontier)
RUNS      147 total · 12 invalid · 4 shortcut_suspected · 38 negative results retained
CLAIMS    1 replicated · 2 provisionally_supported · 5 refuted · 3 inconclusive
BASELINE  equal-budget random search: 1.194 bpc | this campaign: 1.171 bpc
LADDER    A3 — validated improvement. NOT A4: no prior-art search performed (novelty deferred, SCOPE.md)
```

The ladder line must name the *highest level the evidence supports* and state what is missing for the
next one. A card that cannot justify its level fails the build.

---

## 9. Day plan

| Day | Ship |
|---|---|
| 1 | Pi-worker isolation spike (temp HOME + manifest check). Store + 14 tables + event chain + intervals. |
| 2 | Full loop end to end on `tinyml`, foreground, no daemon. Manager and executor prompts. |
| 3 | Lanes/budgets, 4 cheat fixtures, judge, claim card, `/research status`. **First overnight run.** |
| 4 | Daemon (file lock, detached, resume), 4-edge crash tests, baseline advance. **Second overnight run.** |
| 5 | Source/provenance plane. `SCOPE.md`. |
| 6–9 | **Daily use on real work.** Fix only what breaks. Keep a defect log — it becomes demo credibility. |
| 10 | Feature freeze. Counterfactual three-arm run (§7.3). |
| 11 | TUI timeline, demo campaign rehearsal. |
| 12 | Writeup, buffer. |

Estimated size: store+schema 400 · events/intervals 250 · loop/scheduler 400 · worker 350 ·
evaluator+judge 300 · shortcut checks 250 · sources 300 · CLI/status 300 · daemon 250 ≈ **2,800 LOC**.

---

## 10. Demo arc (3 minutes)

1. **15s** — "Every autoresearch demo shows an agent that ran for days. None of them show what it
   actually did." Show a naive loop headline: *9 days autonomous, 10,000 experiments.*
2. **45s** — Start the keep/revert baseline on the char-LM task. It finds a big win, fast. Show the
   winning diff: it leaked the validation set. The loop had no way to know.
3. **60s** — Same task, v0 harness. Contract registered *before* the run. Candidate arrives, checks
   run, `shortcut_suspected` — with the one-line reason. The cheat stays visible in the trace.
4. **45s** — The claim card. Smaller number, but every line traceable to an artifact, with the honest
   time decomposition and the autonomy level it can actually defend.
5. **15s** — `SCOPE.md`: 16 invariants, 9 enforced, 7 deferred, each with a reason. "This is the thing
   the field isn't doing."

---

## 11. Day-1 checklist

- [ ] Confirm Pi 0.76.0 worker isolation: temp `HOME` + empty session dir suppresses all ambient
      extensions/skills/prompts. Log the resolved resource manifest and assert it is empty.
- [ ] Confirm bitwise determinism of the `tinyml` runner across two identical invocations.
- [ ] Decide the exact corpus and split, and freeze their hashes.
- [ ] Stand up the store, event chain, and interval recorder with the §2.1 property test.
- [ ] Write `SCOPE.md` with the invariant table filled in as of day 1, and update it as things land.
