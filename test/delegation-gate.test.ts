import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { briefSimilarity, checkDelegation } from "../src/research/delegation.js";
import {
  antiHillClimbInvariantSource, applyOrchestratorActions, budgetedAttempts, resumeContext, runNextExecutorTask,
} from "../src/research/orchestrator.js";
import { candidateInvocations, renderPreflightMarkdown } from "../src/research/preflight.js";
import { ResearchStore, researchNow } from "../src/research/store.js";
import { validateProcess } from "../src/worker/genkit-worker.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lean-delegation-"));
  const store = ResearchStore.open(join(root, "research.sqlite"));
  store.createDirection({
    id: "direction", title: "Direction", briefMarkdown: "Investigate mechanisms, not scores.",
    constraintsMarkdown: "", domainPath: join(root, "domain.json"),
  });
  return { root, store };
}

function withFixture(fn: (context: ReturnType<typeof fixture>) => void | Promise<void>) {
  return async () => {
    const context = fixture();
    try { await fn(context); } finally {
      context.store.close();
      rmSync(context.root, { recursive: true, force: true });
    }
  };
}

test("the first task in an empty direction needs no citation", withFixture(({ store }) => {
  const verdict = checkDelegation({
    markdown: "# Reproduce the reported eviction result\nNo evidence exists yet.",
    knownIdentifiers: [], priorTasks: [],
  });
  assert.equal(verdict.admitted, true);
  assert.ok(store);
}));

test("a task detached from recorded evidence is refused with feedback", () => {
  const verdict = checkDelegation({
    markdown: "# Improve the cache policy\nTry a slightly larger budget and keep whichever scores better.",
    knownIdentifiers: ["OUT-1234abcd", "COMP-5678efgh"], priorTasks: [],
  });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.feedbackMarkdown!, /cites no recorded evidence/);
  assert.match(verdict.feedbackMarkdown!, /OUT-1234abcd/);
});

test("citing a recorded outcome admits the task", () => {
  const verdict = checkDelegation({
    markdown: "# Test whether allocation, not scoring, explains OUT-1234abcd\nCompeting explanations follow.",
    knownIdentifiers: ["OUT-1234abcd"], priorTasks: [],
  });
  assert.equal(verdict.admitted, true);
});

test("a near-duplicate of an already-run task is refused unless it names that task", () => {
  const brief = "# Sweep eviction budgets\nMeasure perplexity across budgets sixteen, thirty two, and sixty four"
    + " on the same context length with the same needle positions and the same three seeds."
    + " Report perplexity and wall clock time for every cell.";
  const priorTasks = [{ taskId: "TASK-aaaa1111", briefMarkdown: brief }];
  const repeated = `${brief}\nUse budget one hundred and twenty eight as well. Follows OUT-1234abcd.`;
  const refused = checkDelegation({ markdown: repeated, knownIdentifiers: ["OUT-1234abcd"], priorTasks });
  assert.equal(refused.admitted, false);
  assert.match(refused.feedbackMarkdown!, /identical to TASK-aaaa1111/);

  const justified = checkDelegation({
    markdown: `${repeated}\nThis extends TASK-aaaa1111 to test the saturation hypothesis it left open.`,
    knownIdentifiers: ["OUT-1234abcd"], priorTasks,
  });
  assert.equal(justified.admitted, true);
});

test("similarity ignores identifiers and short connective words", () => {
  assert.ok(briefSimilarity("measure eviction quality under pressure", "measure eviction quality under pressure") > 0.99);
  assert.ok(briefSimilarity("measure eviction quality", "implement counter-causal attention") < 0.3);
});

test("a refused delegation queues no task and leaves runtime feedback", withFixture(({ store }) => {
  store.recordOutcome({ directionId: "direction", taskId: store.delegateTask({
    directionId: "direction", mode: "exploration", markdown: "# Seed task",
  }), verdict: "bounded", markdown: "Bounded to the tested regime." });
  store.db.prepare("UPDATE tasks SET state='concluded' WHERE direction_id='direction'").run();

  store.db.prepare(
    `INSERT INTO runs(run_id,direction_id,role,state,input_md,started_at)
     VALUES ('RUN-test','direction','orchestrator','succeeded','context',?)`,
  ).run(researchNow());
  const applied = applyOrchestratorActions(store, "direction", "RUN-test", [
    { name: "delegate_task", markdown: "# Raise the score\nTune the knob until the number improves.", atMs: 0 },
  ]);
  assert.equal(applied.taskId, null);
  const queued = store.db.prepare("SELECT COUNT(*) count FROM tasks WHERE state='queued'").get() as { count: number };
  assert.equal(queued.count, 0);
  const note = store.db.prepare("SELECT body_md FROM notes WHERE role='runtime' ORDER BY created_at DESC LIMIT 1")
    .get() as { body_md: string } | undefined;
  assert.match(note!.body_md, /cites no recorded evidence/);
}));

test("a task that exhausts its attempts is returned to the orchestrator as evidence", withFixture(async ({ root, store }) => {
  const taskId = store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "# Study" });
  store.db.prepare("UPDATE tasks SET workspace_path=? WHERE task_id=?").run(join(root, "worktree"), taskId);
  for (let attempt = 0; attempt < 3; attempt++) {
    store.db.prepare(
      `INSERT INTO runs(run_id,direction_id,task_id,role,state,input_md,output_md,failure,started_at)
       VALUES (?,?,?,'executor','failed','brief','',?,?)`,
    ).run(`RUN-${attempt}`, "direction", taskId, "PROVIDER_ERROR:transport", researchNow());
  }
  // Returns before any model call: the runtime stops retrying rather than
  // spending a fourth attempt on the same failure.
  const executed = await runNextExecutorTask({ store, projectRoot: root, directionId: "direction" });
  assert.equal(executed, null);
  const task = store.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(taskId) as { state: string };
  assert.equal(task.state, "awaiting_orchestrator");
  const note = store.db.prepare("SELECT body_md FROM notes WHERE role='runtime' ORDER BY created_at DESC LIMIT 1")
    .get() as { body_md: string };
  assert.match(note.body_md, /exhausted its 3 executor attempts/);
}));

test("preflight advertises only invocations the executor sandbox accepts", () => {
  for (const invocation of candidateInvocations(process.cwd())) {
    assert.doesNotThrow(() => validateProcess(process.cwd(), invocation.executable,
      [...invocation.args, "study/run.py"]));
  }
});

test("the environment sheet states the sandbox rules the executor used to discover by trial", () => {
  const markdown = renderPreflightMarkdown({
    collectedAt: "2026-01-01T00:00:00.000Z",
    host: { platform: "win32", arch: "x64", cpus: 8, totalMemoryGb: 64, node: "v22.0.0" },
    tools: { git: "git version 2.45.0" },
    interpreters: [{
      invocation: { executable: "py", args: ["-3.10"] }, version: "3.10.11",
      executablePath: "C:\\Python310\\python.exe", packages: { torch: "2.5.1" },
      accelerator: { cuda_available: true, torch_cuda_version: "12.4", devices: [{ name: "RTX 4090", total_memory_gb: 24, capability: "8.9" }] },
    }],
    accelerators: ["NVIDIA GeForce RTX 4090, 24564 MiB, 560.94"],
    sandbox: ["Inline code is rejected: `python -c`, `python -m`, and `node -e` are unavailable."],
  });
  assert.match(markdown, /py -3\.10 <script\.py>/);
  assert.match(markdown, /CUDA 12\.4 available/);
  assert.match(markdown, /python -c/);
});

test("the invariants name the mechanical anti-hill-climbing rules the runtime enforces", () => {
  const source = antiHillClimbInvariantSource();
  assert.match(source, /must cite the recorded evidence/);
  assert.match(source, /near-duplicate/);
  assert.match(source, /Study size is justified by the evidence/);
});

test("an interrupted run informs the resume context but is not charged as an attempt", () => {
  const runs = [
    { run_id: "RUN-fail", state: "failed", failure: "PROVIDER_ERROR:transport", output_md: "died mid-write", started_at: "1" },
    { run_id: "RUN-stop", state: "cancelled", failure: "STOP_REQUESTED", output_md: "", started_at: "2" },
    { run_id: "RUN-lost", state: "failed", failure: "PROCESS_LOST_ON_RESTART", output_md: "", started_at: "3" },
    { run_id: "RUN-compact", state: "failed", failure: "CONTEXT_COMPACTION_FAILED", output_md: "", started_at: "4" },
  ];
  // Only a genuine failure spends the budget; operator stops and lost processes
  // must not retire a task that was never actually tried three times.
  const charged = budgetedAttempts(runs);
  assert.equal(charged.length, 1);
  assert.equal(charged[0]!.run_id, "RUN-fail");

  // The resume context is deliberately wider: every earlier run left files in
  // the shared worktree, so the next attempt has to be told they exist.
  const context = resumeContext("nonexistent-worktree", runs, charged.length + 1);
  assert.match(context, /Resumed attempt 2 of 3/);
  for (const label of ["Earlier run 1", "Earlier run 2", "Earlier run 3", "Earlier run 4"])
    assert.match(context, new RegExp(label));
  assert.match(context, /interrupted by the operator or the runtime/);
  assert.equal(resumeContext("nonexistent-worktree", [], 1), "");
});
