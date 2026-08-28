# CURI research runtime (v7)

## Commands

```powershell
npx tsx src/cli.ts research init --direction ID --title "Title" `
  --brief "Research purpose" --domain domains/example.domain.json `
  --fixed "human-authored constraint" --topic "watcher query"
npx tsx src/cli.ts research run --direction ID
npx tsx src/cli.ts research preflight --refresh
npx tsx src/cli.ts research stop --all --reason "operator requested"
npx tsx src/cli.ts research dashboard start --direction ID --port 7331
```

`research turn` runs one orchestrator turn. `research supervisor start` runs the
serial loop in the background. The watcher is independent and can be started,
stopped, or swept separately.

## Agent boundary

Agents select shallow action tools and attach unrestricted Markdown. Tool names
carry routing; the Markdown is stored verbatim. There is no researcher,
watcher, or executor JSON response, no scientific schema validator, and no
format-repair model. A turn with no action becomes a note.

The orchestrator may inspect the repository read-only. The executor can edit
only its isolated worktree and runs executables directly without a shell. Every
command, diff, changed-file hash, report, and trace is retained.

## Failures learned from archived pipelines

- STOP uses plain-text control files and interrupts model streams, backoff, and
  process trees without entering output recovery.
- Provider failures retry the same role; they never spawn a repair role.
- Completed tool actions persist even if later model output is empty.
- One executor task at a time removes scientific state races.
- Supervisor restart recovery is role-scoped and cannot rewrite a live watcher.
- A task keeps one worktree across its attempts. A provider or transport
  failure interrupts a turn without invalidating the files it wrote, so the
  next attempt resumes there instead of rediscovering the environment and
  reimplementing the study. Trust still comes from verification, not from the
  worktree: every decisive `run_check` is re-run independently by the runtime
  before the orchestrator interprets the result.
- Attempts are capped. A task that exhausts them is returned to the
  orchestrator with its partial artifacts and a runtime-authored report,
  rather than retried forever or dropped silently.
- A failed scientific check is evidence, not automatically a runtime failure.
- The watcher reads retrieved content before relevance admission and preserves
  original source links.
- A watcher model 429 stops the current read sweep, leaves the source retryable,
  and records backoff instead of filling `needs_review` with infrastructure errors.
- Component syntheses are immutable, provenance-linked, tentative by default,
  and accepted or rejected only through explicit human dashboard review.
- Agent tool calls are rendered as human-readable trace events; raw transport
  JSON is available only in an expandable diagnostic view.
- No scalar plot or universal evaluator can silently turn the loop back into
  benchmark hill climbing.

## Environment preflight

The runtime measures the machine before delegation and hands the same verified
sheet to the orchestrator and the executor: working interpreters and the exact
launcher form the sandbox accepts, accelerators and their memory, installed
packages, and the command-sandbox rules. Inspect or invalidate it with
`research preflight [--refresh]`; it is cached in `.curi/preflight.json`.

Environment discovery is a property of the machine, not a research question. An
executor that spends its turn probing interpreters and launcher syntax returns
no evidence, and before preflight every retry repeated that discovery.

## Delegation admission

Two objective checks run before a task is queued. They never interpret the
science; they enforce the structural difference between research and hill
climbing from the runtime's own records.

- A brief must cite at least one existing `COMP`, `OUT`, `SRC`, or `SYN`
  identifier once the direction holds any evidence, so a task is anchored to a
  question rather than to the last number.
- A brief that is a near-duplicate of an already-run task is refused unless it
  cites that task, which forces it to state which explanation the difference
  discriminates.

A refusal is written back as runtime feedback and appears in the orchestrator's
next context, so a refused move is corrected rather than silently repeated.

There are no pipeline-wide experiment-duration, GPU, or VRAM limits. Human
direction constraints and the task-specific Markdown plan govern resources.
The orchestrator delegates the minimum complete study that can answer the
current question, sized by the evidence the question requires rather than by a
rule to start small. It stages an investigation when an earlier result would
change how the later evidence is read.
