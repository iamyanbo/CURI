# Lean research pipeline

```text
watcher -> orchestrator -> one executor -> orchestrator -> tentative understanding
```

The watcher discovers, retrieves, reads, and filters sources. It saves the
original link, retrieved content, content hash, and a free-form Markdown
synthesis. It does not propose experiments.

The orchestrator owns scientific direction. It reads source cards, prior
results, artifacts, components, and the repository, then writes one complete
research decision: the question, smallest discriminating experiment,
question-specific evaluator, fixed scientific requirements, and freedoms. The
executor chooses ordinary implementation details and works in an isolated
worktree, runs the requested checks, and returns a Markdown report. The runtime
independently reruns decisive `run_check` commands before handing everything
back to the orchestrator. Only one experiment executes at once.

The orchestrator may then revise a component's **Current Understanding** using
the exact outcome and source identifiers that support it. These revisions are
tentative until a human accepts them. This is the digestion boundary: abundant
experiments do not become durable knowledge merely because they completed.

## Research rather than hill climbing

The governing principle is: **not every study should use the same evaluator.**

There is no global score, incumbent, moving baseline, winner promotion, or
metric-sorted scheduler. Each claim names the method that can answer its own
question. Benchmarks, source synthesis, reproductions, mechanism traces,
ablations, robustness tests, boundary studies, profiling, integrations, and
artifact analyses are all valid evidence. Negative, bounded, refuted, and
inconclusive results are completed research.

Repeated tuning is allowed when it tests a mechanism hypothesis, but the
runtime never rewards or automatically schedules it. Anti-hill-climbing comes
from removing the incentive loop, not from adding another classifier or quota.
Larger experiments are staged only when a smaller returned result makes the
extra measured work informative; an LLM wall-clock estimate is never the gate.

## Persistent state

The live store contains directions, sources, optional components, tasks, runs,
commands, artifacts, outcomes, immutable synthesis revisions, human reviews,
and events. Components organize related work and drive dashboard navigation;
they never constrain what can be studied. Outcomes that no synthesis cites are
shown as undigested findings, not hidden or converted into a score.

All new work uses one neutral research-task action. The unchanged Markdown
brief decides whether the work is a reproduction, mechanism test, analysis,
implementation, integration, or another method. Scientific content is never
parsed into an agent-authored JSON schema.
