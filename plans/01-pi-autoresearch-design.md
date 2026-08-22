# Pi Auto-Research Extension — Design

Version: 0.3 (2026-08-20; lifecycle, bounded-concurrency, and memory revision)  
Status: adversarial revision; implementation-ready architecture, with domain and deployment adapters still open.

Read this with [02-adversarial-autoresearch-audit.md](./02-adversarial-autoresearch-audit.md). The audit is the evidence and claim ledger; this document is the resulting architecture. The normative high- and low-level implementation contract is [03-pi-autoresearch-technical-spec.md](./03-pi-autoresearch-technical-spec.md), which resolves this document's remaining runtime and packaging choices.

---

## 0. What we are building

A **Pi package** (`pi-autoresearch`) that turns Pi into a durable, falsification-oriented research operating system. It can gather public evidence, run experiments, maintain competing hypotheses, verify results, and resume safely for long periods.

It is deliberately not:

- one immortal model context;
- a prompt that says “never stop”;
- a hyperparameter sweeper presented as an inventor;
- a timer that counts training, queueing, or sleep as agent reasoning;
- a self-review loop that lets the generator certify its own claims.

The package combines **extensions** (state, tools, permissions, budgets, events), **skills** (domain methods), **bounded worker sessions**, **a deterministic supervisor**, and **an optional trace dashboard**.

The objective is **replicated, decision-relevant learning per unit of scarce resource**. Uptime, tokens, run count, benchmark movement, and model confidence are observability signals—not evidence of autonomy, novelty, or scientific progress.

“24/7” means the service can safely resume, monitor, and accept work at any time. It does not require the model to manufacture activity while training is running or when no justified next action exists.

---

## 1. Non-negotiable product invariants

1. **No claim without an artifact.** Every accepted empirical claim points to immutable inputs, code, environment, raw output, evaluator version, and decision rule.
2. **The actor cannot be the final judge.** Executors cannot edit evaluators, protected data, claim state, or audit records.
3. **Promotion rules are registered before results.** Post-result rationale may explain a decision but cannot change its gate.
4. **Negative evidence changes state.** Refutation, inconclusive evidence, and invalid implementation are different terminal states.
5. **Search remains plural.** The controller preserves competing mechanisms and falsification work; it does not always descend from one winner.
6. **Pure knob search is delegated.** When the action space is a fixed vector, use CMA-ES/TPE/random search as a baseline or worker and reserve model effort for representation, mechanism, and experiment design.
7. **Novelty is not self-declared.** It requires a dated search record, nearest-prior-art comparison, and eventually independent review.
8. **Wall-clock time is partitioned.** Reasoning/tool activity, environment execution, queueing, blocked time, recovery, and deliberate sleep are mutually exclusive.
9. **Humans are visible.** Interventions, restarts, prompt edits, evaluator changes, and source refreshes are first-class events.
10. **Stopping is allowed.** “No justified next action under the current budget” is an honest outcome, not a harness failure.
11. **Serial is the safe default.** Only the supervisor may spawn workers; delegation depth is one, nested spawning is forbidden, and concurrency must be justified by an independently auditable decomposition.
12. **A lease is not ownership without fencing.** Every side effect carries a current fencing token; a late or zombie worker cannot commit after reassignment.
13. **Memory is scoped, not ambient.** Scientific facts and lessons are project/campaign namespaced, evidence-linked, and never promoted into a global agent memory automatically.
14. **Motivation precedes machinery.** Mechanism hypotheses derive from an explicit first-principles map of primitives, constraints, assumptions, and falsifiers—not from paper-shaped analogy or available knobs.
15. **Complexity must earn its keep.** Every new role, store, router, memory layer, or concurrency feature needs a named failure target, an ablation, and a rollback path.
16. **Literal score success is not task success.** Every domain adapter defines
    forbidden shortcuts and tests for leakage, hardcoding, skipped verification,
    parser abuse, cache reuse, environment manipulation, and evaluator gaming.

---

## 2. Durable research workspace

The directory `<cwd>/.pi/research/` is the handoff boundary across context resets, crashes, models, and humans. Machine state is authoritative; Markdown files are projections for people.

```text
.pi/research/
  MISSION.md                 # user contract: objective, scope, risk, acceptance criteria
  PRINCIPLES.md              # primitives, invariants, constraints, assumptions, motivations
  PROJECT_ID                 # generated immutable identifier; never inferred from directory name
  state.sqlite               # canonical transactional state: events, revisions, leases,
                             #   commands, completions, claims, budgets, reservations
  STATUS.json                # generated state projection; never authoritative
  STATUS.md                  # generated human-readable projection; never authoritative

  contracts/                 # pre-result hypothesis and experiment contracts
    <contract-id>.json
  portfolio.json             # generated lanes/allocations/frontier projection
  graph/                     # immutable hypothesis/evidence DAG nodes
    <node-id>.json
  claims.jsonl               # exported append-only claim transitions for inspection

  evidence/
    manifests/               # hashes, code/env/data/evaluator versions, raw-output pointers
    raw/                     # stdout, metrics, traces, screenshots, tables
    derived/                 # plots and analyses reproducible from raw evidence
  runs/
    <run-id>/
      <attempt-id>/          # staged output; sealed manifest is the only acceptance boundary
  delivery/
    quarantine/              # late-fence, duplicate-conflict, malformed completions
  sources/
    index.jsonl              # URL/DOI, retrieval time, content hash, source type
    corpus/                  # saved primary sources or permitted extracts
    novelty-searches/        # queries, filters, nearest work, unresolved overlaps

  events.jsonl               # exported causal stream from the canonical event table
  time.jsonl                 # exported mutually exclusive time transitions
  interventions.jsonl        # exported human/operator actions
  budgets.json               # generated hard-ceiling/reservation projection
  rejected.jsonl             # exported dead ends and reopening conditions
  memory/
    reviewed-lessons.jsonl   # project-only; provenance, expiry, evidence, reviewer
  reports/                   # generated findings and limitations
```

SQLite transactions and unique constraints enforce aggregate revisions,
idempotency keys, budget reservations, and the command/completion outbox. One
supervisor holds an OS-level project lock and a database leadership epoch; a
second process cannot become a writer until the old epoch is fenced and external
work is reconciled. SQLite is local-only—multi-host workers communicate through
dispatch packages or an API, never a shared database file.

Files outside the database are either immutable/content-addressed inputs and
artifacts or generated projections. The supervisor rebuilds projections from
canonical tables and flags inconsistencies rather than trusting agent summaries
or partially appended JSONL.

---

## 3. Research representation: portfolio plus evidence DAG

A single winner-descending tree is too greedy. It encourages local hill-climbing, collapses diversity, and makes early measurement noise path-dependent.

Each campaign maintains four default lanes:

| Lane | Purpose | Default budget share |
|---|---|---:|
| Controls and replication | Verify baseline, evaluator, and known results | 25% |
| Exploitation | Improve the strongest supported direction | 30% |
| Mechanism exploration | Try structurally different representations or explanations | 30% |
| Falsification and red-team | Attack the leading claim and search for confounds | 15% |

The user can change shares, but no lane silently borrows protected falsification or replication budget.

A graph node is a hypothesis, experiment, artifact, observation, or claim. Edges are typed: `tests`, `supports`, `refutes`, `depends_on`, `replicates`, `confounds`, `derived_from`, or `supersedes`. Results are immutable; a corrected run becomes a new node linked to the invalid one.

### 3.1 First-principles map

Before proposing solutions, the manager writes `PRINCIPLES.md`:

- the concrete problem, affected user/system, and reason it matters;
- irreducible domain objects and measurable quantities;
- mathematical/physical/system invariants and resource constraints;
- boundary conditions and regimes where they may fail;
- assumptions labeled `empirical`, `mathematical`, `engineering`, or
  `conventional`;
- the simplest baseline implied by the primitives;
- unknowns with the highest decision value; and
- why an adaptive agent is warranted instead of a script, classical optimizer,
  or human-authored queue.

The file is versioned. A refuted premise invalidates dependent hypotheses through
the evidence DAG; it cannot be silently rewritten to preserve the current story.

### 3.2 Pre-registered contract

Before the executor can see the result, the manager writes:

```json
{
  "id": "H-...",
  "lane": "mechanism",
  "claim": "precise falsifiable statement",
  "motivation": "why solving this matters",
  "principle_refs": ["P-..."],
  "assumptions": [{"id": "A-...", "kind": "empirical", "statement": "..."}],
  "mechanism": "why the effect should occur",
  "causal_chain": ["intervention", "intermediate", "observable"],
  "expected_signatures": ["observable prediction"],
  "counterfactual": "what should happen if the proposed mechanism is absent",
  "refutation_conditions": ["observation that counts against it"],
  "known_confounds": ["leakage, evaluator drift, stochasticity"],
  "allowed_information": ["sealed training data, approved corpus"],
  "allowed_mutations": ["candidate source paths"],
  "forbidden_shortcuts": ["test access, hardcoding, parser/clock manipulation"],
  "oracle_query_budget": 0,
  "clean_replay_required": true,
  "baseline_ids": ["B-..."],
  "data_and_split_hashes": ["sha256:..."],
  "evaluator_id": "E-...",
  "primary_metric": {"name": "...", "direction": "max"},
  "promotion_rule": "effect + uncertainty + robustness threshold",
  "replication_rule": "seeds/reruns/regimes required",
  "budget": {"gpu_hours": 0, "tokens": 0, "runs": 0},
  "registered_at": "...",
  "registered_by": "manager-session-id"
}
```

Changing a contract closes it as amended and creates a new version. The dashboard shows whether the change occurred before or after any result became visible.

### 3.3 Claim state machine

```text
proposed
  → tested
      → provisionally_supported
          → replicated
              → externally_validated
      → refuted
      → inconclusive
      → implementation_invalid
      → shortcut_suspected
```

“Metric improved” and “mechanism supported” are separate claims. “Novel” and “useful outside the benchmark” have their own evidence requirements. A provisional claim may guide allocation but cannot appear as a final finding without its qualifier.

---

## 4. Authorities and permission boundaries

The MVP may use one model family, but roles run in separate sessions and receive different tools.

| Authority | Responsibility | Must not be able to do |
|---|---|---|
| Mission owner | Set goal, acceptable risk, hard budget, protected assets | Retroactively alter observed results |
| Supervisor | Reconcile external facts, own all spawn/cancel, manage fenced leases/wake-ups, enforce budgets | Invent hypotheses, delegate recursively, or approve claims |
| Manager | Maintain portfolio, justify decomposition, choose next contract, request bounded work | Spawn directly, edit protected evaluator, or certify its own result |
| Executor | Gather, implement, run, and return artifacts in a sandbox/worktree | Spawn agents, write claim state/audit log/protected data/evaluator, or write another attempt |
| Evidence auditor | Read-only reproduction, provenance and leakage checks | Modify candidate code or negotiate thresholds |
| Claim judge | Apply registered rules to audited evidence | Execute the candidate or waive a failed hard gate |

An authority is not necessarily another agent. In the normal quantitative path,
the supervisor and claim judge are deterministic code, provenance/leakage audit
is code-first, and only the manager and bounded executor require model calls.
A read-only model auditor is added only for qualitative evidence that executable
checks cannot decide. There are no permanently running role agents.

Manager and executor may share a model but not a context or credentials. When a
model auditor is required it remains isolated; high-risk domains require an
independently maintained evaluator and human sign-off. Role separation is a
permission and evidence property, not an excuse to multiply model instances.

---

## 5. Manage–Execute–Audit loop

One cycle is bounded and externally persisted:

```text
0. RECONCILE  Supervisor observes process/run facts, expires leases, hashes outputs,
              and appends time-state transitions. No LLM inference is needed.

1. MANAGE     Manager reads only durable state and the principles map, checks lane
              budgets and unresolved attacks, derives one motivated decision,
              and writes a pre-registered contract. It may request parallel work
              only with a decomposition proof accepted by the supervisor.

2. EXECUTE    Fresh worker receives the minimum contract, immutable input snapshot,
              scoped corpus, tools, and sandbox. It cannot spawn. It gathers,
              implements, or runs; it returns staged artifacts, not a verdict.
              Long jobs yield a handle and release the model.

3. AUDIT      Deterministic read-only checks validate hashes, evaluator integrity,
              data splits, leakage, completion, reproduction, and contract
              compliance. Spawn at most one model auditor only for residual
              qualitative questions.

4. JUDGE      Deterministic claim code applies the pre-registered rule. It records
              a structured transition and cannot “average away” a failed hard
              condition. A model may explain the result but cannot change it.

5. ALLOCATE   Manager updates beliefs and lane allocation. Refutation can prune,
              reopen premises, trigger a discriminating test, or expand literature
              search. A leading direction never consumes the protected attack budget.

6. PERSIST    Supervisor commits causal links, cost, time state, and intervention
              metadata before another worker is leased.
```

Wake-ups are event driven. Training completion, timeout, budget crossing, new human input, source changes, and audit completion enqueue work through a durable inbox. Delivery is at-least-once and deduplicated by idempotency key. Polling and deliberate backoff are labeled; an LLM does not remain alive to watch a process.

### 5.1 Decision types

- `REPAIR` — infrastructure or implementation invalid; capped per contract.
- `REPLICATE` — effect needs seed, regime, or independent-code confirmation.
- `DISCRIMINATE` — choose a test that separates competing mechanisms.
- `REFUTE` — spend protected budget attacking the leader.
- `EXPLORE` — sample a structurally different hypothesis family.
- `EXPLOIT` — improve a supported direction within its action-family budget.
- `DELEGATE_SEARCH` — send a fixed numerical space to a classical optimizer.
- `REPORT` — synthesize with calibrated claim labels.
- `STOP` — goal met, hard budget reached, safety gate triggered, or no justified action remains.

No generic `PROMOTE winner and descend` operation exists.

---

## 6. Evaluation and anti-Goodhart controls

### 6.1 Protected evaluation boundary

The extension stores evaluator code, hidden/protected cases, split definitions, and primary metric configuration outside executor write permissions. Before and after every run it verifies their hashes.

Any attempted modification:

1. invalidates the experiment;
2. emits a high-severity audit event;
3. pauses the affected campaign until a clean baseline is restored.

A task adapter must declare which assets are protected. If none can be protected, reports must state that evaluator gaming was not ruled out.

### 6.2 Shortcut threat model and clean replay

Protection extends beyond file immutability. Every task adapter declares:

- intended behavior and acceptable implementation degrees of freedom;
- allowed information, files, network destinations, mutations, processes, and
  external effects;
- prohibited shortcuts, including hidden/test access, hardcoded cases,
  assertion/test suppression, verification skipping, parser/stdout spoofing,
  clock/resource manipulation, seed/window selection, stale-cache or artifact
  substitution, symlink/path escape, and online solution lookup;
- visible and hidden oracle query/feedback policy;
- canary files, labels, paths, or network endpoints; and
- an independent replay/oracle strategy.

Gathering and execution use separate capabilities. Literature access is logged
and sealed before an experiment; execution is network-off unless the contract
requires a named destination. Evaluator, hidden data, clocks, resource meters,
and parsers run under a different identity outside the candidate filesystem.

Before promotion the harness freezes the candidate, scans its diff/dependencies,
checks file/process/network/canary traces, replays it in a clean cache-free
environment, runs limited-feedback hidden/OOD cases, and recomputes metrics with
an independent parser. Nonzero exit, missing cases, NaN/Inf, test-collection
abort, changed denominator, ambiguous output, or unexplained clean-replay drift
fails closed as `shortcut_suspected` or `implementation_invalid`—never as a win.

Action traces help diagnose cheating but are not a security boundary. Capability
containment and independent recomputation remain primary.

### 6.3 Minimum evidence gates

Empirical promotion normally requires:

- clean baseline reproduced in the same environment;
- raw output and exact command;
- code/environment/data/evaluator hashes;
- uncertainty appropriate to the domain, not a single lucky seed;
- pre-registered primary outcome;
- failure and missing-run accounting;
- robustness check outside the tuned condition;
- independent audit;
- passed shortcut/canary audit and clean-room replay;
- independent metric recomputation;
- comparison against an equal-budget non-agent baseline.

Mechanistic, novelty, and generalization claims require additional, separate evidence. Self-review is useful for generating attacks but never satisfies independent audit.

### 6.4 Anti-grinding rules

| Failure mode | Enforced response |
|---|---|
| Repeated small parameter edits | Action-family budget; compare with CMA-ES/TPE/random search; model loses the lane if it cannot add value |
| Early lucky winner | Minimum exploration floor, repeated trials, uncertainty-aware gate |
| One branch monopolizes budget | Portfolio caps and protected exploration/falsification allocations |
| Benchmark/evaluator editing | Permission boundary, hashes, automatic invalidation |
| Data leakage or cherry-picked window | Protected splits, temporal/out-of-distribution test, audit |
| Score shortcut without evaluator edit | Capability-minimal offline execution, canaries/access trace, clean replay, independent parser/oracle |
| Reviewer shopping | All reviews retained; hard objections cannot be outvoted by lenient prose |
| Premise-level criticism | Reopen hypothesis or run discriminating test; wording changes do not close it |
| Context drift | Fresh bounded workers; state reconstructed from verified artifacts |
| “Keep busy” behavior | Safe sleep/stop is valid; utilization is reported honestly |
| Repeated infrastructure failure | Repair cap, root-cause ticket, then block only that action family |
| Zombie or late worker | Backend reconciliation + renewable lease + fencing token; stale attempts cannot seal or spend more budget |
| Duplicate spawn/completion | Stable idempotency key, logical run/attempt split, durable outbox/inbox, compare-and-swap transition |
| Parallel error cascade | Concurrency 1 by default; supervisor-only depth-one spawn; untrusted child results; circuit breaker on error amplification/conflicts |
| Cross-project memory leak | Immutable project/campaign namespace; no global research memory injection; disk/artifacts outrank recalled prose |
| Overengineered harness | Complexity budget and component ablations; optional subsystems remain outside the minimal kernel |

---

## 7. Online evidence and novelty

The research layer supports arXiv, Crossref/OpenAlex, publisher pages, GitHub, issue trackers, technical blogs, and social incident reports. Connectors are pluggable; the state contract is not tied to a search vendor.

For each source, record:

- canonical locator and retrieval time;
- author/organization and source class;
- content hash or revision identifier;
- primary versus secondary status;
- which claim it supports, contradicts, or merely motivates;
- access limitations and retraction/correction state when available.

Social posts and README claims are leads, not validation. The agent should search for released traces, code, artifact manifests, independent reproductions, and counterexamples.

A novelty claim requires a saved query set, date range, databases searched, nearest neighbors, material differences, unresolved overlap, and a later refresh before publication. Rediscovery is labeled rediscovery unless priority is externally established.

Corpus retrieval quality and research truth are evaluated separately: citation coverage can be high while the hypothesis or experiment remains wrong.

---

## 8. Long-running operation

The supervisor-driven architecture is required from M1. An agent-driven endless session may be offered only as a debug mode and cannot produce verified-autonomy claims.

The Node supervisor:

- runs as a detachable service around Pi RPC/SDK workers;
- is the sole authority allowed to spawn, cancel, retry, or change concurrency;
- starts with one executor and prohibits recursive/nested delegation;
- uses fenced renewable leases and fresh contexts for manager, executor, auditor, and judge;
- launches local/SSH/Slurm/other jobs through adapters and stores durable handles;
- releases model sessions while the environment runs;
- reconciles process status from external facts after crashes;
- enforces global, lane, action-family, and per-contract budgets;
- resumes from append-only state, not conversational memory;
- supports pause, safe stop, and human override;
- never converts lack of useful work into synthetic agent activity.

Long tasks are decomposed by epistemic checkpoint, not arbitrary duration. Compaction may summarize conversation for convenience, but no summary can change research state.

### 8.1 Worker and run lifecycle

A logical run may have multiple attempts, but at most one current owner:

```text
queued → leased → starting → running → completing → sealed → audited → terminal
                  ↘ timed_out | cancelled | failed | orphaned | unknown
```

Each attempt records:

- `run_id`, `attempt_id`, lease ID, monotonically increasing fencing token;
- supervisor instance and campaign epoch;
- PID plus process group/Windows Job Object, container ID, or remote scheduler job ID;
- heartbeat sequence and last backend-confirmed state;
- start/run/cancel deadlines and termination grace;
- reserved tokens, compute, evaluator queries, and external side effects;
- immutable input hash and private staging directory.

Before spawn, the supervisor transactionally records intent and reserves budget.
Every backend labels the process/job with the idempotency key. The child wrapper
registers its PID/job identity before starting work. If the supervisor dies in
the ambiguous interval between spawn and handle persistence, restart searches
the backend and staging heartbeat by that label; it does not blindly retry.

A missed heartbeat does not authorize immediate replacement. The supervisor first asks the backend whether the worker/process tree is alive. Reassignment increments the fence; all subsequent writes, budget commits, and completion messages require the new value. Output from an old fence is preserved for diagnosis but cannot be sealed as evidence.

Workers stage artifacts and request sealing. The single-writer reducer verifies fence, contract, hashes, completion state, and budget reservation before one atomic compare-and-swap transition makes the manifest canonical. Partial or unsealed output is never accepted.

Shutdown order is: close admission, revoke leases, signal whole process trees, wait a bounded grace period, force-kill, reconcile remote jobs, record cleanup, and exit. Startup always reconciles canonical state with actual local/remote processes before spawning.

Supervisor leadership itself is fenced. The local process must hold the project
lock and current database epoch before reducing events; a restarted or duplicate
supervisor with an older epoch is read-only.

### 8.2 Delivery and race model

The system assumes at-least-once delivery. Spawn, cancel, and completion records use stable idempotency keys and durable outbox/inbox tables. A retry creates a new attempt under the same logical run; duplicate messages return the existing transition.

The reducer serializes state mutations. Versioned compare-and-swap prevents:

- two completions accepting the same run;
- pause racing with spawn;
- cancel racing with a late success;
- budget double-spend;
- two managers revising the same portfolio;
- result visibility preceding contract sealing;
- concurrent memory/lesson promotion; and
- stale workers committing after restart or lease reclamation.

External side effects that cannot be made idempotent require an explicit human-approved adapter or are forbidden.

### 8.3 Concurrency admission

Concurrency remains one unless all conditions hold:

1. inputs are immutable and tasks do not depend on tentative sibling output;
2. write sets, evaluator query budgets, and external resources are disjoint;
3. each output is independently auditable;
4. the merge/reduction rule is deterministic;
5. an equal-budget pilot shows net value after coordination and verification.

The collaboration topology is a supervisor-centered star, never a recursively growing tree. Child outputs are untrusted claims and cannot flow into another executor until audited. Sharing a model, prompt, parent, corpus, or blackboard means votes are correlated—not independent replication.

The circuit breaker returns to serial execution after a shared-state conflict, duplicate-work threshold, gateway saturation, unexplained divergence, or excessive error amplification. Parallelism is an optimization to earn, not a product feature to maximize.

### 8.4 Project memory and minimal kernel

The extension deliberately excludes global scientific memory, persona, messaging gateways, cron, self-modifying skills, and general personal-assistant state.

Every project receives an immutable random `project_id`; every campaign receives a `campaign_id` and objective revision. Reviewed lessons remain inside that project and include evidence references, provenance, freshness/expiry, and reviewer. Cross-project search is explicit and returns labeled, untrusted source material.

Status authority is ordered:

1. external process/evaluator facts and immutable artifacts;
2. current git and disk;
3. canonical campaign state;
4. reviewed project lessons;
5. retrieved sources;
6. conversation/session recall;
7. global user preferences, which can never establish a research fact.

Contradictions pause mutation until reconciled. Memory retrieves evidence; it does not outrank evidence.

---

## 9. Trace and dashboard

### 9.1 Canonical event envelope

```json
{
  "event_id": "ulid",
  "project_id": "...",
  "campaign_id": "...",
  "campaign_epoch": 7,
  "aggregate_revision": 42,
  "timestamp_start": "...",
  "timestamp_end": "...",
  "time_state": "agent_reasoning|tool_io|environment_compute|queue|blocked|sleep|recovery|human",
  "actor_role": "supervisor|manager|executor|auditor|judge|human",
  "actor_session_id": "...",
  "kind": "contract|source|run|artifact|audit|claim|budget|intervention|error",
  "parent_event_ids": ["..."],
  "contract_id": "...",
  "claim_id": "...",
  "run_id": "...",
  "attempt_id": "...",
  "lease_id": "...",
  "fencing_token": 9,
  "idempotency_key": "...",
  "backend_handle": {"kind": "local|ssh|slurm", "id": "..."},
  "summary": "...",
  "artifact_manifest": "...",
  "input_hashes": ["..."],
  "output_hashes": ["..."],
  "human_intervention_id": null,
  "schema_version": 1
}
```

Time intervals may not overlap for the same actor/resource. The supervisor derives totals from state transitions rather than model narration. Queueing, training, and sleeping never appear as reasoning time.

An event is accepted only by the single-writer reducer after schema, aggregate revision, campaign epoch, and fencing-token checks. Duplicate idempotency keys return the recorded result. Hash-chained or transactionally framed event storage detects partial tail writes after abrupt termination.

### 9.2 Views

The TUI provides phase, lane, active leases/jobs, budget, last audited claim, and stop reason.

The optional local dashboard provides:

- a wall-clock decomposition headed by active agent/tool time, environment compute, queue, blocked, sleep, recovery, and human time;
- intervention count and exact intervention points;
- portfolio lanes and typed evidence DAG—not a cosmetic “depth” tree;
- claim ladder with failed and unresolved gates;
- contract/result timing to expose post-hoc criteria changes;
- evaluator and dataset hash changes;
- shortcut audit: effective capabilities, forbidden accesses, canary hits,
  clean-replay status, hidden/OOD result, and independent metric comparison;
- equal-budget baseline comparison;
- live ownership: run/attempt, backend handle, heartbeat age, lease/fence, cancellation state, and orphan reconciliation;
- concurrency: active cap, delegation graph, duplicate work, state conflicts, coordination cost, and circuit-breaker state;
- event replay with links to immutable evidence;
- utilization denominators and missing telemetry.

A headline such as “9 days autonomous” is disallowed. The UI must say, for example, “service available 9d 4h; agent/tool active 10h 12m; compute 7d 18h; queued 11h; human interventions 14; telemetry coverage 99.2%.”

---

## 10. Honest success metrics

Campaign reports include:

- service availability;
- active manager/executor/auditor/judge time;
- environment compute and queue time;
- useful completed work units and invalid runs;
- intervention taxonomy and time-to-recovery;
- hypothesis families explored and effective diversity;
- fraction of leading claims subjected to a planned refutation;
- refutation-driven revision rate;
- replication and robustness pass rates;
- unsupported/fabricated citation rate;
- evaluator-integrity incidents;
- shortcut-suspected runs, forbidden access/canary hits, clean-replay failures,
  independent-parser discrepancies, and hidden-vs-visible generalization gap;
- orphan/zombie detections, stale-fence rejections, duplicate suppression, and cleanup failures;
- concurrency level, coordination overhead, shared-state conflicts, and downstream error amplification;
- memory contradictions and cross-project retrieval attempts;
- equal-budget performance versus random search, classical HPO, and a human-defined baseline where feasible;
- externally reviewed or independently reproduced findings.

“Autonomy duration” appears only with its operational definition and decomposition.

---

## 11. Package anatomy

```text
pi-autoresearch/
  package.json
  src/
    extension.ts
    workspace.ts             # schemas, atomic state, projections
    supervisor.ts            # leases, event wake-up, restart, reconciliation
    lifecycle.ts             # run/attempt state machine, heartbeat, fencing, termination
    reducer.ts               # single writer, CAS revisions, canonical sealing
    delivery.ts              # durable command/completion outbox, idempotency
    process-tree.ts          # process groups / Windows Job Objects / backend cancellation
    concurrency.ts           # admission proof, caps, circuit breaker, reservations
    portfolio.ts             # lanes, allocations, diversity policy
    graph.ts                 # typed immutable research/evidence DAG
    contracts.ts             # preregistration and versioning
    permissions.ts           # role capabilities and protected assets
    runner.ts                # local/SSH/Slurm adapter boundary
    evaluator.ts             # protected evaluator registry and hashes
    shortcuts.ts             # task threat model, capability policy, canaries, replay
    auditor.ts               # provenance, leakage, reproduction checks
    claims.ts                # state machine and rule application
    baselines.ts             # random/classical/equal-budget comparisons
    sources.ts               # literature/web provenance and novelty search
    memory.ts                # project-scoped reviewed lessons; explicit cross-project search
    budget.ts
    time.ts
    trace.ts
  skills/
    research-manager/SKILL.md
    experiment-design/SKILL.md
    falsification/SKILL.md
    literature/SKILL.md
    novelty-audit/SKILL.md
    evidence-audit/SKILL.md
    reporting/SKILL.md
    domains/<adapter>/SKILL.md
  prompts/
    manager.md
    executor.md
    auditor.md
    judge.md
  web/
  schemas/
  tests/
```

Methods live in skills because they evolve by domain. State transitions, permissions, budgets, hashes, evaluator gates, and time accounting live in code because model compliance is not an enforcement mechanism.

---

## 12. Implementation plan and exit gates

### M0 — Measurement and evaluator foundation

- Define schemas for events, time states, contracts, evidence manifests, claims,
  interventions, logical runs, attempts, leases, fences, budget reservations,
  commands, completions, and acknowledgements.
- Implement the single-writer reducer, CAS revisions, durable outbox/inbox,
  idempotency, staged artifact sealing, atomic projections, hash verification,
  and crash reconstruction.
- Implement local process-tree ownership, heartbeat/backend reconciliation,
  lease renewal/revocation, fencing, staged shutdown, and orphan quarantine.
- Build protected evaluator registry and role-capability tests.
- Create a synthetic suite containing evaluator-edit, test/label leakage,
  hardcoded cases, disabled assertions, aborted test collection, skipped
  verification, fabricated/stdout-spoofed metrics, NaN/parser abuse,
  clock/denominator manipulation, stale-cache/artifact reuse, web/git solution
  lookup, lucky-seed/cherry-pick, post-hoc threshold, stale-memory, and
  cross-project-contamination traps.
- Add deterministic fault injection at every lifecycle edge: kill supervisor or
  worker, freeze heartbeat while process stays live, duplicate/reorder messages,
  expire/reclaim a lease, deliver an old-fence result, partially write output,
  and race pause/cancel/budget exhaustion with completion.

**Exit gate:** the harness detects every seeded shortcut and state trap; a crash between any two
state writes reconstructs without an accepted phantom result; no zombie or
old-fence worker can commit; duplicate delivery produces one transition and one
charge; time categories sum to observed wall time within tolerance.

### M1 — Bounded research portfolio

- Package skeleton and Pi tools.
- Supervisor with fresh bounded manager/executor calls, deterministic
  audit/judge paths, optional one-off qualitative reviewer, executor concurrency
  fixed at one, and no nested spawn capability.
- Portfolio lanes, typed DAG, contracts, claim state machine, and hard budgets.
- First-principles map, assumption dependencies, project/campaign namespaces,
  authority-ranked reconciliation, and reviewed project-only lessons.
- Literature/source provenance and basic novelty-search records.
- TUI status and machine-readable report.

**Exit gate:** on held-out synthetic tasks, it maintains at least two mechanism families, performs a planned falsification, distinguishes refuted/inconclusive/invalid, and cannot self-certify.

### M2 — Compute and counterfactual evaluation

- Local and SSH runner first; Slurm/Modal/Kubernetes as adapters later.
- Event-driven job wake-up and recovery.
- Seed/regime replication, protected holdout, robustness tests.
- Capability-minimal offline execution, hidden evaluator service, canary/access
  telemetry, clean cache-free replay, and independent metric parser/oracle.
- Equal-budget random, CMA-ES/TPE, and fixed-policy baselines.
- One real reproduction campaign plus one open-ended improvement campaign.

**Exit gate:** no evaluator mutation or seeded shortcut goes undetected; every
accepted empirical claim reproduces from its manifest in a clean environment
and agrees with the independent parser/oracle; the controller beats or honestly
loses to the appropriate equal-budget baseline.

### M3 — Trace UI, gated parallelism, and external audit

- Dashboard with wall-time decomposition, interventions, evidence DAG, claims, and replay.
- Add concurrency admission only after the serial system passes M0–M2:
  supervisor-centered depth-one workers, immutable snapshots, disjoint write
  sets/resources, deterministic reduction, hard caps, and circuit breaker.
- Exportable evidence pack and public claim card.
- Independent reviewer workflow and campaign red-team.
- Soak testing across restarts and source/evaluator version changes.

**Exit gate:** an external reviewer can reconstruct every headline claim
without chat history; an overnight run resumes after injected crashes; the
public report never collapses compute time into agent activity; and under equal
budgets, admitted parallelism beats serial execution without increasing
invalid-result rate or error amplification past the registered limit. If it
does not, parallel mode remains disabled.

---

## 13. How to evaluate this harness

Do not compare only against another “never stop” prompt. Run equal-budget, repeated campaigns with blinded or protected evaluation:

1. plain Pi loop;
2. classical optimizer or deterministic workflow;
3. this harness without independent audit;
4. this harness without protected falsification budget;
5. full harness;
6. human-defined baseline where feasible;
7. full harness at executor concurrency `1`, `2`, `4`, and `8` on a genuinely
   decomposable task; and
8. a deliberately unsafe independent/nested-agent topology as a fault baseline.

Measure outcome quality, invalid-result rate, evaluator tampering, refutation
response, diversity, interventions, active time, compute, total cost,
coordination overhead, duplicate work, shared-state conflicts, orphan cleanup,
and root-to-downstream error amplification. Publish failed runs and denominator
definitions. Pre-register the comparison before running it.

The hypothesis to test is modest: **structured orchestration can improve the reliability and research value of long-horizon agent work under a fixed budget**. It is not assumed true merely because the dashboard looks active.

---

## 14. Remaining implementation choices

These choices do not weaken the epistemic floor:

1. First domain adapter: small-model training, systems optimization, literature synthesis, or another bounded domain.
2. Initial compute backends: local + SSH are the simplest default; add a scheduler only if the first campaign needs it.
3. Search providers: native APIs, CLI tools, or installed connectors behind one provenance interface.
4. Dashboard timing: TUI ships in M1; web UI can wait until M3.
5. Evaluator custody: local protected directory for a personal deployment; separate service/account for public claims.

Concurrency is not an open product choice: it remains `1` until M3 evidence
earns a higher per-campaign cap. Global research memory, recursive delegation,
and peer-to-peer spawning are intentionally out of scope.
