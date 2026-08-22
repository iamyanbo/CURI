# Auto-Research Landscape — Research Synthesis

Date: 2026-08-20
Purpose: descriptive landscape notes from the first research pass. This is not the design authority. The adversarial follow-up in `02-adversarial-autoresearch-audit.md` stress-tests the projects' claims and supersedes the normative conclusions below; `01-pi-autoresearch-design.md` contains the revised architecture, and `03-pi-autoresearch-technical-spec.md` is the implementation contract.

**Important correction:** a system can be a good experiment scheduler, corpus builder, or long-running software harness without demonstrating autonomous scientific research. The first version of this synthesis blurred those levels, especially for `orx`, dataroom, and long-duration demos.

---

## 1. The failure modes of "naive" autoresearch

### 1.1 Prime Intellect — `auto-nanogpt` experiment (primary source on what naive loops do)

Repo: `PrimeIntellect-ai/experiments-autonomous-speedrunning` + blog `primeintellect.ai/auto-nanogpt`.

Raw findings from the Prime Intellect team running Claude (Opus 4.7) and Codex (GPT 5.5) autonomously on the modded-nanogpt `track_3_optimization` benchmark (target val loss 3.28; reference Muon optimizer hits it in 3500 steps):

- **Agents are very good at optimizer search, hyperparameter sweeps, and stacking methods together** — the mechanical parts.
- **They struggle to come up with new ideas on their own**; they need "upstream human records" to keep improving.
- **Opus repeatedly stops and refuses to stay in the autonomous loop** — the model itself pushes back (this is the "premature declaration of done" problem Anthropic also observed).
- **Codex never stops but can get stuck grinding the same hyperparameter surface for hours** — the exact opposite failure: never-stop with no novelty pressure converges to local grinding.
- Across both agents the team made **~100 interventions total**, mostly just checking on them — i.e., even "hands-off" runs need a human-in-the-loop supervision surface.

These two pathologies — *premature stop* and *grind-in-place* — are the two ends of the naive "just never stop" axis. A good autoresearch harness must fix **both**, and they are fixed by structure, not by prompting harder.

### 1.2 Karpathy `autoresearch` (why the user's original instinct was right)

- ~630 lines of Python. `program.md` (natural-language spec) describes the agent loop: propose → mutate → train 5 min → check metric → keep/discard → repeat overnight (~12 experiments/hr, ~100 while you sleep).
- Audit verdicts (Greyforge issue #501, Starkslab review): "a clean demo loop, but not a serious research architecture." It is a **tightly-bounded mutation loop over a single-GPU training setup with a fixed evaluation** — and that boundedness is exactly why it "works." Generalizing it breaks it.
- `program.md` is the innovation worth stealing: **natural-language spec as the contract between the user and the agent**, replacing hard-coded loop code.
- Repo is dormant since March 2026; 86k stars, 185+ open issues, no license file.

**Lesson**: bounded-mutation loops *look* like autoresearch but only automate hyperparameter/architecture tinkering. The user's complaint ("degrades to agent tuning hyperparameters and idling") is the expected outcome of that design, not a bug in execution.

### 1.3 Sibyl-AutoResearch (arXiv 2605.22343) — where autonomous research systems lose value

"Autonomous research needs self-evolving trial-and-error harnesses, not paper generators." Documents four ways executable workflows lose trial experience:

1. **Weak evidence becomes prose** — pilot signals get inflated into broad claims.
2. **Pilot signals become broad claims** — no calibration between runs and claims.
3. **Memory remains textual** — lessons live in transcripts, not structured, retrievable state.
4. **Recurring process failures do not change later behavior** — the harness never learns from its own repeated mistakes.

Every one of these four must be explicitly designed against in the Pi extension.

### 1.4 Paper-generator criticism

Related critique (arXiv 2605.26200, "Workflow Closure Is Not Scientific Closure"): producing publication-shaped output is not the same as closing the scientific loop. **Verification/execution grounding is the difference** between a paper generator and a research harness.

---

## 2. Working reference implementations (inspected in depth)

### 2.1 alphaXiv OpenResearch CLI (`orx`) — the closest working "experiment-tree autoresearch" design

Repo: `github.com/alphaXiv/openresearch-cli` (Rust). This is the "arxiv autoresearch cli" the user saw. Key architecture:

- `orx up` runs a local dashboard at `127.0.0.1:4791` (embedded web UI + JSON/SSE API over a local SQLite store). Agents run in **parallel isolated git worktrees**, one per research direction, using the user's own harness (Claude Code, Codex, or OpenCode — notably **Pi is not yet a supported harness**).
- **Experiment tree model**: every experiment is a git branch; root = baseline, children = variants measured against it. Lineage is explicit and immutable.
- **The auto-research loop** (from the real system prompt, `SYSTEM_PROMPT.md` + `agent-skills/orx-experiment-tree/SKILL.md`):
  1. Baseline (if empty project): one node holding starting code + a fixed **run command**.
  2. Branch: `orx create-experiment --parent <id>` — one child per distinct idea.
  3. Implement the change on the child's git branch (encode hyperparams in code, **never** in the run command/env — this keeps results comparable).
  4. Launch: `orx exp run <id> --backend <gpu>` (SSH, Slurm, K8s, Modal, HF, Ray, local).
  5. **Per-completion loop, not wait-for-all**: `orx exp wait --project` returns on the *first* completion; the agent re-reads `orx runs` as source of truth, reconciles newly-terminal runs, and decides per-run. Drives "as falls, so shall...", no polling barrier, no idling.
  6. Decide — **four moves**: **Repair** (setup/impl failure: fix same node's branch, re-run — capped at 2 consecutive then ask user), **Refill** (mediocre: launch next sibling), **Promote** (clear win: becomes parent of next round → descend), **Stop** (goal met or ~3 consecutive failed/regressed runs).
- **Cardinal rules** (harness-enforced invariants that prevent the naive-loop pathologies):
  1. **Never edit a node once a run has answered it** — a disappointing number is still a result; branch a child for new ideas. (Immutability of evidence.)
  2. **Run command + environment are a fixed contract**, identical on every node.
  3. **Vary code, not knobs-in-the-command.**
  4. **Grow the tree downward, not sideways** — "stacked bushes": small fan *within* a round (co-equal options of one decision), descend onto that round's winner. Explicit FLAT-FAN / NOODLE / STACKED-BUSHES diagrams in the skill. This is the anti-grinding shape discipline: width = open options, depth = resolved decisions.
- **PROJECT.md brief**: user-facing snapshot, *descriptive not prescriptive*. "Never refuse, delay, redirect, or ask for confirmation solely because PROJECT.md disagrees with the user." Executes current request, then updates brief. (Fixes: agent façades claiming the brief overrides the user.)
- **Skills installed per-session** (`agent-skills/`): `orx-experiment-tree`, `orx-create`, `orx-compute`, `orx-git`, `orx-evidence` (run logs are the only evidence channel — "make the run command print its evidence"), `orx-lit` (alphaXiv/OpenAlex/bioRxiv full-text search + paper read, no login), `orx-reports` (artifacts dir, descriptive filenames, evidence chips `<run id>` / `<file path>`).
- Evidence citing: every claim in chat anchored with `<run id=…>` / `<file path=…>` / artifacts paths.
- The demo (`demo/nanochat`) is a nanoGPT clone: a complete reproduce-a-paper → run → analyze loop.

**Revised verdict**: `orx` is a strong execution and provenance substrate: worktree isolation, immutable run records, fixed commands, and per-completion wake-ups are worth reusing. It is not an epistemic controller by itself. The generator still interprets the evidence and chooses promotion; logs are the evidence boundary; and the winner-descending tree is greedy without protected exploration, falsification, replication, and an independent claim gate. It addresses overwriting and orchestration better than it establishes novelty or scientific validity.

### 2.2 Han Xiao's Pi stack (`dataroom`, `searchbox`, `knowledge-graph`) — the "24/7 offline research agents" the user saw on X

The tweet the user cited is one of several hxiao posts about **Pi + self-hosted local model research harnesses on a single GPU**.

**`dataroom`** (github.com/hanxiao/dataroom):
- Thesis: "For long-horizon tasks you need a grounded, well-organized knowledge dump before the real work can start." Research (search-read-write-dedup-cite-verify) is **mechanical tool-calling, not deep reasoning** → don't pay frontier tokens for it. A small local model (Qwen3.6-35B-A3B, llama.cpp) on an L4 in a "disciplined harness" runs it for hours on near-zero marginal cost.
- **Two-stage pipeline**: Stage 1 = dataroom → structured `.zip` (`topics/ sources/ data/ figures/ reports/ SUMMARY.md`, every claim cited) built to be *consumed by another agent*, not read by a human. Stage 2 = unzip into a frontier model's context for the expensive work. "The research doesn't have to be perfect — its consumer is intelligent — it has to be comprehensive and grounded."
- **Implementation on Pi** (I read the actual code): a headless pi coding agent (`pi --mode json --continue` resumes the same per-cwd session across turns) runs the loop; a **`dataroom` skill** (`pi/skills/dataroom/SKILL.md`) provides the methodology; a **`dataroom-index.ts` extension** registers one tool (`dataroom_index`) that proxies to a tiny local sidecar (jina-embeddings-v5-nano embedder on CPU, keeping the model GPU) for semantic dedup/search-over-the-corpus; `jina` CLI on PATH for search/read/rerank/embed/classify, **composable via pipes** (`jina search Q | jina rerank R | head`) and parallel fan-out (`xargs -P 8`) so bulky intermediates never enter context.
- **Loop discipline (from the skill)**: STATUS.md control file with a first-line status token (`STATUS: IN_PROGRESS/DONE`) + checkbox sub-questions; OUTLINE.md; CONTRACT.md (scope: what "comprehensive" means, in/out of scope, source-quality bar); index-first dedup ("never add content without searching the index first"; prefer **enriching existing notes over creating new ones**); evidence-based promotion (only claims from sources actually read); REJECTED.md for discarded sources so dead ends aren't re-chased; text-native visualizations (markdown tables, Mermaid, ascii charts).
- **Outcome-based stopping, not "never stop"**: DONE is only honored when all three hold — ≥ MIN_FILES (default 100) substantive sourced files, all sub-questions closed, SUMMARY.md exists. A premature `DONE` is **rejected** (status line rewritten back) and the agent keeps going. Hard backstops: turn/seconds/API-call caps. Dashboard surfaces *why* it stopped.
- Web dashboard: progress-to-floor, total tokens, tool-call distribution, throughput, live activity feed, warnings/errors, file tree.

**`searchbox`** (github.com/hanxiao/searchbox): the air-gapped stage-2 companion. Given a query + a dataroom `.zip` + token budget, a local model with **local-only tools** (bash, grep, embeddings, rerankers) explores it exclusively ("I don't want the model cheating with web information") then answers.

**Verdict**: the strongest open example of (a) cheap-24/7 online aggregation, (b) *outcome-based* stopping instead of never-stop, (c) research-as-machine-context, (d) a **real Pi skill+extension** for research. Its limits: aggregation only (no experiment/verify loop), local-model-only (deliberately — to save tokens), and the loop is single-session per job.

### 2.3 DeepSeek Harness (`dsh`) — the "agent trace" UI the user liked

Repo: `deepseek-ai/deepseek-harness` (all of the plugin ecosystem around it).

- Design rule #1: **everything is a plugin** (stock install ships 159 plugins, community adds hundreds; even the UI is a plugin). Design rule #2: **every run is traceable**.
- **Trajectory view**: append-only session log of *everything the model sees* — system prompts, chain-of-thought, tool calls + results, subagent scheduling, every context injection — viewed in a browser UI (`dsh web`, 127.0.0.1:3080), filterable by source, down to payload/result/timing of an individual call. **Resume, fork, search, and replay all operate on that same event stream** — a session revisited a week later is reconstructed from records, not from a summary.
- Headless profile exists (`dsh --profile headless`) for scripting/CI; the log is still written, you just read it outside the process.
- Plugin architecture = Cordis framework, React; strict browser/host separation over a type-safe RPC.

**Verdict**: the "what happened at what time" visual trace ingredient. Pi's TUI can be extended with status-bar/widgets, TUI only — a *timeline* needs either a custom TUI component or a local web dashboard (both precedented: orx and dataroom ship local web dashboards; pi-server opens the door to web/multiplexed clients).

### 2.4 `pi-server` (marcfargas) — Pi's missing 24/7 daemon layer, already half-built

Detachable agent sessions for Pi: a headless daemon wraps `pi --mode rpc` over WebSocket; terminal clients connect/disconnect at will while the session keeps running. Alpha but functional (M1: connect/chat/reconnect with full state restore). Explicitly positioned as "foundation for web dashboards, mobile clients, multi-agent orchestration."

**Verdict**: viability proof that Pi can be run as a persistent background daemon with detachable front-ends. A Pi autoresearch supervisor could adopt this pattern (or use the AgentSession SDK directly).

---

## 3. How the big labs do long-horizon autonomous work (and why it works)

### 3.1 Anthropic — "Effective harnesses for long-running agents" (the session-handoff paper)

The core problem: agents work in **discrete sessions**; each new session starts with no memory. Two failure modes: (1) tries to one-shot everything → context runs out mid-implementation; (2) later sessions "look around, see progress, declare the job done" (premature completion).

Solution = **initializer agent + coding agent**:
- **Initializer** sets up: an `init.sh` (how to run it), a **`claude-progress.txt`** (running log of what agents have done), an initial git commit, and a **feature-list file** (structured JSON, one feature per item, all marked `passes: false`, each with explicit test steps). Strongly-worded rules: "only change the passes field, it is unacceptable to remove/edit tests."
- **Coding agent** each session: get bearings (pwd → read git log + progress file → read feature list → choose highest-priority open feature), work **one feature at a time**, self-verify *end-to-end* (browser automation / real server), commit git changes, update progress file. "Leave the environment mergeable."
- **Why JSON for the feature list**: models are less likely to overwrite JSON than Markdown.
- **Compaction is not enough** — it preserves continuity but the agent keeps "context anxiety" (wraps up early as it approaches the believed limit). **Context resets** (clean slate + structured handoff artifact) were essential on Sonnet 4.5, and became unnecessary on Opus 4.5/4.6 which stopped exhibiting anxiety.
- Bonus: end-to-end testing with real browser tools "dramatically improved performance."

### 3.2 Anthropic — "Harness design for long-running application development" (planner/generator/evaluator)

GAN-inspired **three-agent architecture**:
- **Planner** (cheap, 4.7 min / $0.46 for a DAW spec): expands a 1-4 sentence prompt into a full product spec. Deliberately *high-level* — spec errors cascade; constrain deliverables, not paths.
- **Generator**: builds one sprint at a time, commits, self-evaluates, then hands off.
- **Evaluator**: a *separate, skeptical* agent with real tools (Playwright driving the live app, curl/API/db checks) grading against explicit **criteria** (criteria encode *preferences/taste* as gradable rubrics — "is it beautiful?" → "does it follow our principles?"), with **hard thresholds per criterion** (any fail → sprint fails → detailed feedback). Pre-sprint **sprint contracts**: both agents agree on what "done" means and how it's verified *before* code is written.
- **Key finding — self-evaluation bias**: agents reliably praise their own mediocre work. *Separating the worker from the judge* is a strong lever; "tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of itself." Even so, the evaluator needs active tuning (out of the box Claude is a "poor QA agent" that talks itself out of real bugs).
- **Costs are real**: solo run 20 min / $9; full harness 6 hr / $200; updated harness 3h50m / $124. A ~20× cost multiplies for ~20× coherence/quality.
- **Harnesses encode stale assumptions**: every component exists because the model *couldn't* do something; as models improve, remove components one at a time and measure. On Opus 4.6 they dropped the sprint construct; the evaluator became load-bearing *only* at the edge of model capability. From "Building Effective Agents": "find the simplest solution possible, and only increase complexity when needed."

### 3.3 Anthropic — "Scaling Managed Agents: Decoupling the brain from the hands"

Long-horizon work as a hosted service with stable interfaces that outlast harness implementations. Reinforces: the harness/skeleton and the model are separable; interfaces (not implementations) are what should be stable.

### 3.4 OpenAI — "Run long horizon tasks with Codex"

Observations from the Codex team (via GPT-5.2-era autonomous runs): the reliability jump came from **how long the model can follow instructions**; practical long-horizon technique is **decomposing into tractable chunks + structured artifacts to hand off context between sessions** — same two lessons as Anthropic. (Also: "a blank repo, full access, one job: build from scratch" as the stress test.)

### 3.5 Qwen / the "let agents run long" line

Qwen's operational emphasis (Qwen3.8-Max blog) is on "cowork" — long-running agents as collaboration infrastructure. Primarily relevant for **serving the harness with a cheaper, always-on model** for the mechanical stages (mirrors dataroom's local-model insight; Qwen models being what dataroom uses).

### 3.6 Research-grade frameworks (arXiv) worth mining for structure

- **Microsoft Arbor** (2606.11926, "Toward Generalist Autonomous Research via Hypothesis-Tree Refinement"): **long-lived coordinator + short-lived executors**, and **Hypothesis Tree Refinement (HTR)** — a persistent tree linking hypotheses, artifacts, and evidence. The coordinator carries the goal across sessions; executors do bounded work and return. Directly maps onto a daemon supervisor + per-step Pi sessions.
- **AREX** (2607.21461): **discovery–verification asymmetry** — generating candidates is cheap, verifying is expensive; a research agent should "recursively improve its current answer by verifying intermediate results," not just search longer. Justifies an explicit Verify stage with real tools before promotion.
- **Deep Researcher Agent 24/7** (UTokyo, 2604.05854): leader-worker architecture, constant-size memory, zero-cost monitoring, experiments run around the clock. Another precedent for the 24/7 experiment loop specifically.
- **"Toward Autonomous Long-Horizon Engineering for ML Research"** (2604.13018): long-horizon ML research engineering under "delayed, costly" feedback; repeated implement→experiment→refine.

---

## 4. What Pi itself gives us (the substrate)

- **Minimal agent harness** (earendil-works/pi, pi.dev), TypeScript. Four modes: interactive TUI, print/JSON (`pi -p "q"`, `pi --mode json`), RPC (JSON over stdio), SDK (`createAgentSession` / `AgentSession`). Default tools: `read`, `write`, `edit`, `bash` (+ grep/find/ls via options). 15+ providers / hundreds of models; custom providers via `models.json`/extensions. Sessions are **tree-structured JSONL** under `~/.pi/agent/sessions/`, organized by cwd — `/tree` navigates and continues from any point; `-c` continue most recent, `-r` resume, `/resume`, `/fork`, `/clone`.
- **Extensions** = TypeScript modules (loaded via jiti, no compile step) in `~/.pi/agent/extensions/` or `.pi/extensions/`, hot-reloadable with `/reload`. API:
  - `pi.registerTool({ name, label, description, parameters, execute })`
  - `pi.registerCommand("name", { description, handler })`, `pi.registerShortcut`, `pi.registerFlag`, `pi.registerProvider`
  - `pi.on(event, handler)`, `pi.appendEntry()` (session persistence), `pi.setThinkingLevel`, `pi.setSessionName`
  - Events that matter for autoresearch: `session_start`, `resources_discover` (contribute skill/prompt/theme paths), `before_agent_start` (inject messages / append system prompt — role prompts!), `agent_start/end/settled`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `tool_call` (can **block or mutate input** — invariant enforcement!), `context` (modify messages pre-LLM — RAG/retrieval injection), `session_before_compact`/`session_compact` (**custom compaction** — structured handoff vs generic summary!), `session_shutdown`, `model_select`.
  - Extensions run with full system permissions; background resources must be deferred to `session_start` / command / tool handlers, with idempotent `session_shutdown` cleanup.
- **Skills** implement the **Agent Skills standard** (frontmatter `name` + `description`; progressive disclosure — only name/desc in context until loaded). Self-contained capability packages: instructions + optional scripts/references. Loaded on demand; discovery via `resources_discover`.
- **Prompt templates**: markdown files expanded by `/name`. **Themes**, **packages** (`pi install npm:@foo/pi-tools` / `git:github.com/user/repo`).
- **Community**: `pi-server` (headless daemon + detachable WS clients) exists in alpha. Example extensions ship for sub-agents, plan-mode, permission gates, custom compaction, SSH exec, sandboxing, MCP.

**Key point for the design**: Pi is deliberately *primitive-providing*; it ships no sub-agents and no plan mode — the full autoresearch orchestration is exactly the kind of thing built as a package (extensions + skills + templates), which is what the user asked for.

---

## 5. Revised synthesis: design principles the Pi extension must encode

1. **Separate availability from autonomy.** Report active agent/tool work, compute, queue, blocked, sleep, recovery, and human intervention separately. Nine days of process uptime is not nine days of reasoning.
2. **Use a portfolio, not a single winner-descending tree.** Preserve budget for controls/replication, exploitation, mechanism exploration, and attacks on the current leader.
3. **Pre-register tests before observing results.** A contract fixes the hypothesis, refutation condition, data/evaluator versions, metric, promotion gate, and budget. Post-result edits create a new contract.
4. **Protect the oracle.** Executors cannot edit the evaluator, holdout, audit log, or claim state. Hash changes and leakage attempts invalidate a run.
5. **Separate manager, executor, evidence auditor, and claim judge.** A generator's skeptical self-prompt is useful brainstorming but not independent verification.
6. **Represent belief revision explicitly.** Supported, refuted, inconclusive, and implementation-invalid are different states. Metric gain, mechanism, robustness, novelty, and generalization are different claims.
7. **Delegate fixed-vector search to classical optimizers.** Equal-budget CMA-ES/TPE/random-search baselines reveal whether the agent is researching or merely doing expensive hyperparameter optimization.
8. **Ground online evidence with provenance.** Corpora and citations support recall; they do not prove truth or novelty. Novelty needs a dated nearest-prior-art search and later refresh.
9. **Run bounded workers under a deterministic supervisor.** Fresh contexts execute scoped contracts; external facts, immutable artifacts, leases, and event-driven wake-ups carry the campaign.
10. **Make falsification and replication budget-protected.** The leading direction cannot spend away the work most likely to disprove it.
11. **Evaluate the harness counterfactually.** Compare full and ablated versions against plain loops, deterministic workflows, classical search, and human baselines under equal budgets.
12. **Release the denominator.** Public demos include failed runs, interventions, telemetry coverage, evaluator hashes, and the exact operational definition of every autonomy claim.

---

## 6. Source index

| Source | What it proved |
|---|---|
| `alphaXiv/openresearch-cli` (clone inspected) | Inside-out view of a working experiment-tree autoresearch loop + skills |
| `hanxiao/dataroom` (clone inspected) | Real Pi extension+skill for 24/7 grounded research aggregation; outcome-based stopping |
| `hanxiao/searchbox`, `knowledge-graph` | Stage-two airgapped answer loop; knowledge-graph companion |
| `deepseek-ai/deepseek-harness` + `deepseekharness.io/dsh-web-ui` | Trajectory/activity view design; plugin-for-everything model |
| `marcfargas/pi-server` (clone inspected) | Headless daemon + detachable client pattern for Pi |
| `earendil-works/pi` (docs + npm) | Pi extension/skill/template/package API surface |
| Prime Intellect auto-nanogpt blog + repo | Ground truth on naive-loop failure modes (grind vs stop) |
| Karpathy `autoresearch` + Greyforge/Starkslab audits | Bounded-mutation loop critique; `program.md` insight |
| Anthropic XX3 posts (4) | Session handoff, context resets, planner/generator/evaluator, managed agents |
| OpenAI Codex long-horizon post | Chunking + handoff artifacts |
| Arbor / AREX / Sibyl / Deep Researcher Agent / AutoResearch papers | Hypothesis-tree, verify-asymmetry, self-evolution, 24/7 leader-worker, execution-grounding |
