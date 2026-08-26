import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildResearchDashboardState, insideWorkspace } from "../src/research/server.js";
import { traceBreakdown, traceSegments } from "../src/research/trace.js";
import { ResearchStore } from "../src/research/store.js";

test("lean dashboard is valid and exposes research, components, piano roll and trace", () => {
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script); assert.doesNotThrow(() => new Function(script));
  for (const label of ["Live pipeline", "Watcher intake", "Runtime diagnostics",
    "Component system", "Current understanding", "Execution piano roll", "Live agent trace", "Original Markdown plan", "Orchestrator verdict"])
    assert.match(html, new RegExp(label));
  // The dashboard is navigated rather than scrolled: one long card pile buried
  // the research output under machinery.
  assert.match(html, /data-view="understanding"/);
  assert.match(html, /data-view="execution"/);
  assert.doesNotMatch(html, /best score|moving baseline|leaderboard|Current notebook|Protocols|Evidence ledger/i);
});

test("dashboard scopes execution by component and task", () => {
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  assert.match(html, /function filteredTasks/); assert.match(html, /function lanes/);
  assert.match(html, /componentId/); assert.match(html, /taskId/); assert.match(html, /data-lane/);
  // The review controls are withdrawn while the system runs as pure autonomous
  // research; the record still shows what stands and what superseded what.
  assert.doesNotMatch(html, /data-review=/);
  assert.doesNotMatch(html, /reviewSynthesis/);
  assert.match(html, /superseded as better evidence arrives/);
  assert.match(html, /undigested findings/);
  assert.match(html, /Raw internal event/);
});

test("dashboard derives tentative, accepted, and superseded knowledge without a score", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-dashboard-state-"));
  let first = ""; let second = "";
  const store = ResearchStore.open(join(root, ".autoresearch", "research.sqlite"));
  try {
    store.createDirection({ id: "direction", title: "Direction", briefMarkdown: "Understand mechanisms.",
      constraintsMarkdown: "", domainPath: root });
    const componentId = store.createComponent("direction", "Mechanism component");
    const taskId = store.delegateTask({ directionId: "direction", mode: "exploration",
      markdown: `Investigate ${componentId}` });
    store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator' WHERE task_id=?").run(taskId);
    const outcomeId = store.recordOutcome({ directionId: "direction", taskId, verdict: "supported", markdown: "Observed." });
    first = store.recordSynthesis({ directionId: "direction", markdown: `${componentId}\n${outcomeId}\nFirst.` });
    store.reviewSynthesis({ synthesisId: first, verdict: "accepted", noteMarkdown: "Reviewed." });
    second = store.recordSynthesis({ directionId: "direction", markdown: `${componentId}\n${outcomeId}\nRevised.` });
    store.reviewSynthesis({ synthesisId: second, verdict: "accepted", noteMarkdown: "Better account." });
  } finally { store.close(); }
  try {
    const state = buildResearchDashboardState(root) as Record<string, any>;
    assert.equal(state.syntheses.find((item: any) => item.synthesis_id === first)?.status, "superseded");
    assert.equal(state.syntheses.find((item: any) => item.synthesis_id === second)?.status, "accepted");
    assert.deepEqual(state.knowledge.undigestedOutcomeIds, []);
    assert.equal("score" in state.knowledge, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("piano roll segments separate tool time, reasoning, and time waiting on the model", () => {
  const steps = [
    { seq: 0, kind: "tool_call", toolName: "run", toolCallId: "a", atMs: 1_000 },
    { seq: 1, kind: "tool_call", toolName: "read", toolCallId: "b", atMs: 1_200 },
    { seq: 2, kind: "tool_result", toolName: "read", toolCallId: "b", atMs: 1_800 },
    { seq: 3, kind: "tool_result", toolName: "run", toolCallId: "a", atMs: 5_000, isError: true },
    { seq: 4, kind: "thinking", atMs: 6_000 },
  ];
  const segments = traceSegments(steps, 10_000);
  const run = segments.find((item) => item.label === "run")!;
  assert.equal(run.endMs - run.startMs, 4_000);
  assert.equal(run.isError, true);
  const breakdown = traceBreakdown(segments, 10_000);
  // The two tool calls overlap, so union coverage is 1000→5000 plus 5000→6000
  // of reasoning; the remaining 5s is unattributed waiting, not tool time.
  assert.equal(breakdown.waiting, 5_000);
  assert.equal(breakdown.errors, 1);
  assert.equal(breakdown.toolCalls, 2);
});

test("a tool call still open at the end is drawn as running, not dropped", () => {
  const segments = traceSegments([{ seq: 0, kind: "tool_call", toolName: "run", toolCallId: "a", atMs: 500 }], 90_000);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.endMs, 90_000);
  assert.equal(traceBreakdown(segments, 90_000).waiting, 500);
});

test("workspace previews cannot escape the task worktree", () => {
  const workspace = join(process.cwd(), ".autoresearch", "worktrees", "example");
  assert.equal(insideWorkspace(workspace, "../../../package.json"), null);
  assert.equal(insideWorkspace(workspace, process.cwd()), null);
  assert.equal(insideWorkspace(workspace, ""), null);
  assert.ok(insideWorkspace(workspace, "results/data.csv"));
});

test("the dashboard has a stop path, so stop --all means everything", () => {
  // It previously had none: `research stop --all` left the server running, and
  // its open database handle blocks a state-directory migration on Windows.
  const server = readFileSync(join(process.cwd(), "src", "research", "server.ts"), "utf8");
  const shutdown = server.slice(server.indexOf("await new Promise<void>((resolveClose)"));
  assert.match(shutdown, /requestedStop\(input\.projectRoot\)/);
  assert.match(shutdown, /clearInterval\(watch\)/);
});
