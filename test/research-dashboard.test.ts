import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildResearchDashboardState, insideWorkspace, researchDashboardAsset } from "../src/research/server.js";
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
  assert.match(html, /model \/ provider/);
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

test("component writeups render as full-width prose without repeating the card title", () => {
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  assert.match(html, /\.component-writeup\{width:100%;max-width:none;/);
  assert.match(html, /class="prose component-writeup" id="comp-desc"/);
  assert.match(html, /prose\(\$\('#comp-desc'\),stripLeadingHeading\(c\.description_md\|\|''\)\)/);
});

test("dashboard Markdown and math assets are served instead of falling back to code blocks", () => {
  const marked = researchDashboardAsset("/vendor/marked.js");
  assert.ok(marked && marked.body.length > 1_000);
  assert.match(marked.contentType, /javascript/);
  assert.match(researchDashboardAsset("/vendor/katex.css")?.contentType ?? "", /css/);
  assert.equal(researchDashboardAsset("/vendor/fonts/../../package.json"), null);
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
  // The first second produced the tool request, the two tools overlap from
  // 1000→5000, and reasoning covers 5000→6000. Only the final 4s is uncovered.
  assert.equal(breakdown.waiting, 4_000);
  assert.equal(breakdown.model, 1_000);
  assert.equal(breakdown.errors, 1);
  assert.equal(breakdown.toolCalls, 2);
});

test("context compaction is visible as its own execution interval", () => {
  const segments = traceSegments([
    { seq: 0, kind: "compaction", atMs: 2_000, content: "epoch 1" },
    { seq: 1, kind: "text", atMs: 3_000, content: "continued" },
  ], 3_000);
  assert.equal(segments[0]?.kind, "compaction");
  assert.equal(traceBreakdown(segments, 3_000).compaction, 2_000);
});

test("a tool call still open at the end is drawn as running, not dropped", () => {
  const segments = traceSegments([{ seq: 0, kind: "tool_call", toolName: "run", toolCallId: "a", atMs: 500 }], 90_000);
  assert.equal(segments.length, 2);
  const running = segments.find((item) => item.kind === "tool")!;
  assert.equal(running.endMs, 90_000);
  const breakdown = traceBreakdown(segments, 90_000);
  assert.equal(breakdown.model, 500);
  assert.equal(breakdown.waiting, 0);
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

test("a relationship label states the claim, not the identifiers", () => {
  // The orchestrator opens a relationship with bookkeeping. Labelling an edge
  // with the first line drew "COMP-acdf0c7f-2b9` -> `COMP" and nothing else.
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  const source = html.slice(html.indexOf("function relationClaim(md){"), html.indexOf("function components()"));
  const relationClaim = new Function(`${source}; return relationClaim;`)() as (md: string) => string;

  // A heading is the best summary the orchestrator writes.
  assert.equal(
    relationClaim("`COMP-a1b2c3` -> `COMP-d4e5f6`\n# Asymmetric Precision Enables Retention\n\nDetail follows."),
    "Asymmetric Precision Enables Retention");
  // Otherwise the first real sentence, with the pair prefix removed.
  assert.equal(
    relationClaim("`COMP-a1b2c3` -> `COMP-d4e5f6`: Eviction and quantization are complementary; more follows."),
    "Eviction and quantization are complementary;");
  // Inline citations are stripped rather than truncating the claim at their dot.
  const cited = relationClaim("Speculation bypasses the crossover (`OUT-26b612f4-330`, `OUT-1032553e-994`), enabling the scheduler in `COMP-b0fb403e-5ba`.");
  assert.doesNotMatch(cited, /COMP-|OUT-|SRC-|SYN-/);
  assert.match(cited, /Speculation bypasses the crossover, enabling the scheduler/);
  // A relationship with nothing but bookkeeping still yields a label.
  assert.equal(relationClaim("`COMP-a1b2c3` relates to `COMP-d4e5f6`."), "relationship recorded");
});

test("the published mirror offers no control it cannot honour", () => {
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  const bar = html.slice(html.indexOf("function traceView"), html.indexOf("host.scrollTop="));
  // Following keeps the newest step in view as it arrives. A published trace is
  // a finished snapshot, so the button could never do anything there.
  assert.match(bar, /S&&S\.published\?''/);
  // And turning it on scrolls immediately rather than only setting a flag.
  assert.match(bar, /follow\)\{const h=\$\('#trace'\);h\.scrollTop=h\.scrollHeight\}/);
});

test("cited evidence names the study and opens it", () => {
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  const understanding = html.slice(html.indexOf('<span class="t-micro">evidence</span>'),
    html.indexOf("no sources cited"));
  // Every cited outcome rendered as the literal word "finding", so nine of them
  // were nine identical chips with the identifier hidden in a tooltip.
  assert.doesNotMatch(understanding, />finding</);
  assert.match(understanding, /data-outcome=/);
  // A source with no recorded URL is not an anchor: it looked clickable and went
  // nowhere.
  assert.match(understanding, /src&&src\.canonical_url/);
  assert.match(understanding, /no link recorded/);
});

test("a published record offers no control that would 405", () => {
  // On the mirror the supervisor is reported as not running, which rendered a
  // "Resume research" button and a continuous toggle. Both POST to /api/control,
  // which a mirror answers 405 — so on camera they stick at "starting…".
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  const panel = html.slice(html.indexOf("function nowPanel()"), html.indexOf("function overview("));
  assert.match(panel, /const published=Boolean\(S&&S\.published\)/);
  assert.match(panel, /\+\(published\?''/);
  // And the handlers must tolerate the buttons being absent.
  assert.match(panel, /if\(continuousBtn\)/);
  assert.match(panel, /if\(resume\)/);
});

test("the piano roll draws tiles a reader can hit", () => {
  // Measured on a real record: the median step is under two seconds, which is
  // four hundredths of a pixel on a multi-hour axis. Drawing each at a clickable
  // minimum produced a smear of overlapping identical blocks.
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  const lane = html.slice(html.indexOf("function rollLane"), html.indexOf("function execution()"));
  assert.match(lane, /MERGE_PCT/);
  assert.match(lane, /last\.count\+\+/);
  // A failure must never vanish into a merged neighbour.
  assert.match(lane, /if\(s\.isError\)last\.isError=true/);
  // Clicking anywhere on a lane selects the nearest step rather than requiring a
  // pixel-perfect hit.
  const roll = html.slice(html.indexOf("roll.querySelectorAll('[data-lane]')"));
  assert.match(roll, /bestD/);
  // And idle stretches are collapsed with a visible break, not silently.
  assert.match(html, /class="gapmark"/);
});

test("long syntheses are folded, not dumped", () => {
  // The median synthesis on a real record is 8,066 characters and the longest is
  // 14,013. Twenty-eight of those rendered in full is a wall nobody scans.
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  assert.match(html, /\.prose\.clamped\{max-height/);
  assert.match(html, /data-expand-syn=/);
  // Folded by default, and the fold is reversible per synthesis.
  const view = html.slice(html.indexOf("function understanding()"), html.indexOf("function components()"));
  assert.match(view, /expanded\.has\('syn:'\+s\.synthesis_id\)\?''\:'clamped'/);
  assert.match(view, /expanded\.has\(key\)\?expanded\.delete\(key\)\:expanded\.add\(key\)/);
});

test("the window buttons work on a record that has finished", () => {
  // Anchored on the wall clock, every window on a record that ended hours ago
  // selected nothing, fell through to fit, and looked dead.
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  const fn = html.slice(html.indexOf("function rollWindow(ls)"), html.indexOf("function buildTimeMap"));
  assert.match(fn, /Math\.max\(\.\.\.ls\.map\(l=>l\.endMs\)\)/);
  assert.doesNotMatch(fn.split("if(zoom==='fit')")[1] ?? "", /from:now-zoom/);
});

test("a task card renders from a published record", () => {
  // The local API sends command arguments as JSON text and the published record
  // sends them parsed; parsing the wrong one threw inside the template and left
  // the whole card blank on the mirror.
  const html = readFileSync(join(process.cwd(), "src", "research", "dashboard.html"), "utf8");
  assert.match(html, /function cmdArgs\(c\)/);
  assert.match(html, /Array\.isArray\(c\.args\)/);
  assert.doesNotMatch(html, /JSON\.parse\(c\.args_json\)\.join/);
});
