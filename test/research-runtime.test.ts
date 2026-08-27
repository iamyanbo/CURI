import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkSynthesis } from "../src/research/delegation.js";

import Database from "better-sqlite3";

import { antiHillClimbInvariantSource, applyOrchestratorActions } from "../src/research/orchestrator.js";
import {
  continuousFile, continuousMode, costCeilingFile, directionSpendUsd, idleBackoffMs,
  reconcileSupervisorState, researchCostCeiling,
} from "../src/research/runtime.js";
import { MARKDOWN_RESEARCH_CONTRACT } from "../src/research/contracts.js";
import { requestResearchStop, requestedStop } from "../src/research/control.js";
import { RESEARCH_SCHEMA_VERSION, ResearchStore } from "../src/research/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lean-research-"));
  const store = ResearchStore.open(join(root, "research.sqlite"));
  store.createDirection({ id: "direction", title: "Direction", briefMarkdown: "Investigate systems, not scores.",
    constraintsMarkdown: "- preserve correctness", domainPath: join(root, "domain.json") });
  return { root, store };
}

test("lean store contains no program, study, protocol, claim, or notebook machinery", () => {
  const { root, store } = fixture();
  try {
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(x => x.name);
    for (const removed of ["research_programs", "studies", "protocols", "claims", "researcher_notebook",
      "implementation_packets", "assemblies", "evidence_items"]) assert.ok(!tables.includes(removed), removed);
    for (const kept of ["directions", "sources", "components", "tasks", "runs", "commands", "artifacts", "outcomes", "events"])
      assert.ok(tables.includes(kept), kept);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Markdown is preserved verbatim and never parsed as JSON", () => {
  const { root, store } = fixture();
  try {
    const markdown = "# Claim\n```cuda\nif (x) { broken: \"json }\n```\nUnicode → research";
    const taskId = store.delegateTask({ directionId: "direction", mode: "claim", markdown });
    const row = store.db.prepare("SELECT brief_md FROM tasks WHERE task_id=?").get(taskId) as { brief_md: string };
    assert.equal(row.brief_md, markdown);
    assert.match(MARKDOWN_RESEARCH_CONTRACT, /unrestricted Markdown/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("one experiment may be queued or running at a time", () => {
  const { root, store } = fixture();
  try {
    const first = store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "Explore mechanism A" });
    assert.throws(() => store.delegateTask({ directionId: "direction", mode: "claim", markdown: "Test mechanism B" }), /UNIQUE/);
    store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator' WHERE task_id=?").run(first);
    assert.doesNotThrow(() => store.delegateTask({ directionId: "direction", mode: "claim", markdown: "Test mechanism B" }));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("bounded and negative outcomes are terminal research rather than runtime failure", () => {
  const { root, store } = fixture();
  try {
    const taskId = store.delegateTask({ directionId: "direction", mode: "claim", markdown: "Test all regimes" });
    store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator' WHERE task_id=?").run(taskId);
    store.recordOutcome({ directionId: "direction", taskId, verdict: "bounded", markdown: "Works only for D <= 64." });
    const task = store.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(taskId) as { state: string };
    const outcome = store.db.prepare("SELECT verdict,report_md FROM outcomes WHERE task_id=?").get(taskId) as { verdict: string; report_md: string };
    assert.equal(task.state, "concluded"); assert.equal(outcome.verdict, "bounded"); assert.match(outcome.report_md, /D <= 64/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("anti-hill-climb invariant removes score scheduling and universal evaluation", () => {
  const source = antiHillClimbInvariantSource();
  assert.match(source, /No global research score/);
  assert.match(source, /No task is selected by metric ordering/);
  assert.match(source, /Every claim chooses the evaluation method/);
  const runtime = readFileSync(join(process.cwd(), "src", "research", "runtime.ts"), "utf8");
  assert.doesNotMatch(runtime, /baseline.advance|best[_ ]score|sort\([^)]*metric/i);
});

test("source cards preserve links while accepting free-form synthesis", () => {
  const { root, store } = fixture();
  try {
    const sourceId = store.addSource({ directionId: "direction", provider: "test", url: "https://example.com/paper", title: "Paper" })!;
    store.reviewSource(sourceId, "relevant", "# Finding\nA mechanism with caveats; no fixed headings required.");
    const source = store.context("direction").sources[0]!;
    assert.equal(source.canonical_url, "https://example.com/paper");
    assert.equal(source.state, "relevant"); assert.match(source.card_md!, /caveats/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("orchestrator prompt keeps research design out of the executor", () => {
  const prompt = readFileSync(join(process.cwd(), "prompts", "researcher.md"), "utf8");
  assert.match(prompt, /Never delegate source discovery/);
  assert.match(prompt, /you synthesize the returned cards and choose the concrete\s+experiment yourself/);
  // The sizing rule is sufficiency, not smallness: pinning "smallest experiment"
  // here is what pushed the orchestrator toward narrow tuning loops.
  assert.doesNotMatch(prompt, /smallest experiment/);
  assert.match(prompt, /minimum complete study that can answer the current\s+question/);
  assert.match(prompt, /Justify the size by the evidence the question\s+requires/);
  assert.match(prompt, /not an LLM wall-clock guess/);
  assert.match(prompt, /the executor owns ordinary\s+implementation choices/);
  assert.match(prompt, /only implements, runs, and reports/);
});

test("a same-turn watcher request defers execution until evidence arrives", () => {
  const { root, store } = fixture();
  try {
    const runId = store.beginRun({ directionId: "direction", role: "orchestrator", inputMarkdown: "turn" });
    const applied = applyOrchestratorActions(store, "direction", runId, [
      { name: "request_watch", markdown: "Find primary prior art", atMs: 1 },
      { name: "delegate_task", markdown: "Ask executor to retrieve and design the study", atMs: 2 },
    ]);
    assert.equal(applied.taskId, null);
    assert.equal(store.context("direction").tasks.length, 0);
    assert.equal(store.context("direction").watcherRequests.length, 1);
    assert.match(String(store.context("direction").notes[0]?.body_md), /executor does not perform literature retrieval/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("new research tasks use one neutral delegation action", () => {
  const { root, store } = fixture();
  try {
    const runId = store.beginRun({ directionId: "direction", role: "orchestrator", inputMarkdown: "turn" });
    const applied = applyOrchestratorActions(store, "direction", runId, [
      { name: "delegate_task", markdown: "# Reproduce mechanism\nUse a question-specific correctness suite.", atMs: 1 },
    ]);
    assert.ok(applied.taskId);
    assert.equal(store.context("direction").tasks[0]?.task_kind, "research");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("component understanding is tentative, provenance-linked, revisioned, and human-reviewed", () => {
  const { root, store } = fixture();
  try {
    const componentId = store.createComponent("direction", "# Attention mechanisms\nReusable attention work.");
    const sourceId = store.addSource({ directionId: "direction", provider: "test",
      url: "https://example.com/source", title: "Source" })!;
    store.reviewSource(sourceId, "relevant", "Relevant primary evidence.");
    const taskId = store.delegateTask({ directionId: "direction", mode: "claim",
      markdown: `# Boundary test\nComponent ${componentId}; source ${sourceId}` });
    store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator' WHERE task_id=?").run(taskId);
    const runId = store.beginRun({ directionId: "direction", role: "orchestrator", inputMarkdown: "interpret" });
    const outcomeId = store.recordOutcome({ directionId: "direction", taskId, runId, verdict: "bounded",
      markdown: "The mechanism holds only in the tested regime." });
    const synthesisId = store.recordSynthesis({ directionId: "direction", runId,
      markdown: `# Current understanding\n${componentId} is bounded by ${outcomeId}, consistent with ${sourceId}.` });
    let context = store.context("direction");
    assert.equal(context.syntheses[0]?.component_id, componentId);
    assert.deepEqual(context.synthesisOutcomes.map((item) => item.outcome_id), [outcomeId]);
    assert.deepEqual(context.synthesisSources.map((item) => item.source_id), [sourceId]);
    assert.equal(context.synthesisReviews.length, 0, "agent synthesis must begin tentative");
    store.reviewSynthesis({ synthesisId, verdict: "accepted", noteMarkdown: "Evidence and scope are clear." });
    context = store.context("direction");
    assert.equal(context.synthesisReviews[0]?.verdict, "accepted");
    assert.throws(() => store.db.prepare("UPDATE component_syntheses SET body_md='rewrite' WHERE synthesis_id=?")
      .run(synthesisId), /append-only/);
    const next = store.recordSynthesis({ directionId: "direction", markdown: `# Revised understanding\n${componentId}\n${outcomeId}` });
    const revision = store.db.prepare("SELECT supersedes_synthesis_id FROM component_syntheses WHERE synthesis_id=?")
      .get(next) as { supersedes_synthesis_id: string };
    assert.equal(revision.supersedes_synthesis_id, synthesisId);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("v6 research databases migrate in place with a recoverable backup", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-research-v6-"));
  const path = join(root, "research.sqlite");
  const original = ResearchStore.open(path);
  original.createDirection({ id: "direction", title: "Direction", briefMarkdown: "Preserve this history.",
    constraintsMarkdown: "", domainPath: root });
  original.delegateTask({ directionId: "direction", mode: "exploration", markdown: "Legacy task" });
  original.close();
  const legacy = new Database(path);
  legacy.exec(`
    DROP TRIGGER immutable_synthesis_review_delete;
    DROP TRIGGER immutable_synthesis_review_update;
    DROP TRIGGER immutable_synthesis_delete;
    DROP TRIGGER immutable_synthesis_update;
    DROP TABLE synthesis_reviews;
    DROP TABLE synthesis_components;
    DROP TABLE synthesis_sources;
    DROP TABLE synthesis_outcomes;
    DROP TABLE component_syntheses;
    ALTER TABLE watcher_config DROP COLUMN max_read;
    ALTER TABLE tasks DROP COLUMN task_kind;
    DELETE FROM research_schema_meta WHERE version > 6;
    INSERT INTO research_schema_meta(version,applied_at,checksum) VALUES (6,'legacy','legacy');
  `);
  legacy.close();
  const migrated = ResearchStore.open(path);
  try {
    assert.equal(migrated.context("direction").tasks[0]?.brief_md, "Legacy task");
    assert.equal(migrated.context("direction").tasks[0]?.task_kind, "exploration");
    assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE name='component_syntheses'").get());
    // Every migration in the chain runs, so a database several versions behind
    // arrives at the current schema rather than being rejected.
    assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE name='synthesis_components'").get());
    assert.equal(Number((migrated.db.prepare("SELECT MAX(version) v FROM research_schema_meta").get() as { v: number }).v),
      RESEARCH_SCHEMA_VERSION);
    assert.ok(existsSync(`${path}.v6.bak`));
    assert.ok(existsSync(`${path}.v7.bak`));
  } finally { migrated.close(); rmSync(root, { recursive: true, force: true }); }
});

test("STOP control is plain text and independent of agent schemas", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-stop-"));
  try {
    requestResearchStop(root, "now", "operator requested");
    assert.deepEqual(requestedStop(root), { mode: "now", reason: "operator requested" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("supervisor recovery never rewrites an independently running watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-recovery-"));
  const store = ResearchStore.open(join(root, "research.sqlite"));
  try {
    store.createDirection({ id: "direction", title: "Direction", briefMarkdown: "b", constraintsMarkdown: "c", domainPath: root });
    const watcher = store.beginRun({ directionId: "direction", role: "watcher", inputMarkdown: "watch" });
    const orchestrator = store.beginRun({ directionId: "direction", role: "orchestrator", inputMarkdown: "decide" });
    reconcileSupervisorState(store, "direction");
    const rows = store.db.prepare("SELECT run_id,state,failure FROM runs ORDER BY started_at").all() as Array<{ run_id: string; state: string; failure: string | null }>;
    assert.deepEqual(rows.find((row) => row.run_id === watcher), { run_id: watcher, state: "active", failure: null });
    assert.deepEqual(rows.find((row) => row.run_id === orchestrator), { run_id: orchestrator, state: "failed", failure: "PROCESS_LOST_ON_RESTART" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a direction stops when recorded spend reaches the ceiling", () => {
  const { root, store } = fixture();
  try {
    assert.equal(researchCostCeiling(null, { AR_MAX_COST_USD: "0" } as NodeJS.ProcessEnv), 0);
    assert.equal(researchCostCeiling(null, { AR_MAX_COST_USD: "not-a-number" } as NodeJS.ProcessEnv), 0);
    assert.equal(researchCostCeiling(null, { AR_MAX_COST_USD: "12.5" } as NodeJS.ProcessEnv), 12.5);
    assert.equal(directionSpendUsd(store, "direction"), 0);
    const runId = store.beginRun({ directionId: "direction", role: "orchestrator", inputMarkdown: "turn" });
    store.finishRun({ runId, state: "succeeded", outputMarkdown: "done", costUsd: 4.25 });
    assert.equal(directionSpendUsd(store, "direction"), 4.25);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("restart revives one stopped attempt without breaking the single-live-task rule", () => {
  const { root, store } = fixture();
  try {
    const older = store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "# Older" });
    store.db.prepare("UPDATE tasks SET state='cancelled',workspace_path='ws-old' WHERE task_id=?").run(older);
    const newer = store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "# Interrupted" });
    store.db.prepare("UPDATE tasks SET state='cancelled',workspace_path='ws-new',updated_at='2099-01-01' WHERE task_id=?")
      .run(newer);
    // Several cancelled tasks must not all be revived: the partial unique index
    // permits only one queued or running task per direction.
    assert.doesNotThrow(() => reconcileSupervisorState(store, "direction"));
    const states = new Map((store.db.prepare("SELECT task_id,state FROM tasks WHERE direction_id='direction'")
      .all() as Array<{ task_id: string; state: string }>).map((row) => [row.task_id, row.state]));
    assert.equal(states.get(newer), "queued");
    assert.equal(states.get(older), "cancelled");
    // Running it again while that task is live must change nothing.
    assert.doesNotThrow(() => reconcileSupervisorState(store, "direction"));
    assert.equal((store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE state='queued'").get() as { n: number }).n, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a cancelled task that never opened a workspace stays cancelled", () => {
  const { root, store } = fixture();
  try {
    const taskId = store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "# Never started" });
    store.db.prepare("UPDATE tasks SET state='cancelled' WHERE task_id=?").run(taskId);
    reconcileSupervisorState(store, "direction");
    const row = store.db.prepare("SELECT state FROM tasks WHERE task_id=?").get(taskId) as { state: string };
    assert.equal(row.state, "cancelled");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a cost ceiling can be changed while the pipeline runs", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-budget-"));
  try {
    const env = { AR_MAX_COST_USD: "5" } as NodeJS.ProcessEnv;
    assert.equal(researchCostCeiling(root, env), 5);
    // The control file wins, so a budget change needs no process restart and
    // cannot cost a running experiment.
    mkdirSync(join(root, ".autoresearch"), { recursive: true });
    writeFileSync(costCeilingFile(root), "20\n", "utf8");
    assert.equal(researchCostCeiling(root, env), 20);
    writeFileSync(costCeilingFile(root), "nonsense", "utf8");
    assert.equal(researchCostCeiling(root, env), 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an orchestrator with nothing to do backs off instead of re-asking every minute", () => {
  // A turn costs real money and grows with the direction, so an unchanged
  // context must not be re-queried at a fixed short interval overnight.
  assert.equal(idleBackoffMs(0), 60_000);
  assert.equal(idleBackoffMs(1), 120_000);
  assert.equal(idleBackoffMs(3), 480_000);
  assert.equal(idleBackoffMs(10), 30 * 60_000);
  assert.equal(idleBackoffMs(-5), 60_000);
  // Ten hours idle must cost a handful of turns, not hundreds.
  let elapsed = 0; let turns = 0;
  for (let i = 0; elapsed < 10 * 3_600_000; i++) { elapsed += idleBackoffMs(i); turns++; }
  assert.ok(turns < 30, `expected far fewer than 30 idle turns overnight, got ${turns}`);
});

test("outcomes must state the envelope their evidence covers", () => {
  // Verdicts that read as proofs corrupt every synthesis that cites them, so
  // the scope of the evidence has to be stated and the verdict chosen against it.
  const prompt = readFileSync(join(process.cwd(), "prompts", "researcher.md"), "utf8");
  assert.match(prompt, /envelope its evidence\s+actually covers/);
  assert.match(prompt, /sample\s+size per condition/);
  assert.match(prompt, /Reserve `record_supported` for a claim whose falsifier was actually tested/);
  assert.match(prompt, /does not "prove"/);
});

test("components can be related, so the thread map is a graph and not a list", () => {
  const { root, store } = fixture();
  try {
    const a = store.createComponent("direction", "Eviction policies");
    const b = store.createComponent("direction", "Precision representations");
    const runId = store.beginRun({ directionId: "direction", role: "orchestrator", inputMarkdown: "turn" });
    applyOrchestratorActions(store, "direction", runId, [
      { name: "relate_components", markdown: `${a} supplies the memory budget that ${b} then spends.`, atMs: 1 },
    ]);
    const rel = store.context("direction").componentRelations[0] as Record<string, unknown>;
    assert.equal(rel.from_component_id, a);
    assert.equal(rel.to_component_id, b);
    // A relationship naming only one component is refused with feedback rather
    // than recorded as a dangling edge.
    applyOrchestratorActions(store, "direction", runId, [
      { name: "relate_components", markdown: `${a} matters a great deal.`, atMs: 2 },
    ]);
    assert.equal(store.context("direction").componentRelations.length, 1);
    assert.match(String(store.context("direction").notes[0]?.body_md), /name two existing COMP identifiers/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("continuous mode is a deployment choice that never rewrites the pause itself", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-continuous-"));
  try {
    assert.equal(continuousMode(root), false);
    mkdirSync(join(root, ".autoresearch"), { recursive: true });
    writeFileSync(continuousFile(root), "on", "utf8");
    assert.equal(continuousMode(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("continuous running is availability, not a prompt that forbids stopping", () => {
  // The orchestrator keeps pause_research and the prompt never tells it to keep
  // going; continuous mode is a deployment choice made outside the model.
  const prompt = readFileSync(join(process.cwd(), "prompts", "researcher.md"), "utf8");
  assert.doesNotMatch(prompt, /never stop|do not stop|keep going|continue forever|always delegate/i);
  assert.match(prompt, /or pause instead of launching another/);

  // A direction taken up again after a pause backs off on the same curve as an
  // idle turn, so "forever" cannot become a paid poll every few seconds.
  const runtime = readFileSync(join(process.cwd(), "src", "research", "runtime.ts"), "utf8");
  assert.match(runtime, /idleBackoffMs\(quietTurns\)/);
  assert.doesNotMatch(runtime, /cancellableDelay\(input\.projectRoot, 15_000\)/);
  // Ten hours with nothing happening costs a handful of turns, paused or idle.
  let elapsed = 0; let turns = 0;
  for (let i = 0; elapsed < 10 * 3_600_000; i++) { elapsed += idleBackoffMs(i); turns++; }
  assert.ok(turns < 30, `expected few turns while quiet, got ${turns}`);
});

test("a relationship recorded twice updates the edge instead of adding one", () => {
  // The orchestrator re-states a relationship on every turn it still holds. One
  // live direction reached 44 rows describing 8 pairs, and the thread graph drew
  // all 44 — an unreadable tangle rather than a map.
  const root = mkdtempSync(join(tmpdir(), "lean-research-rel-"));
  const store = ResearchStore.open(join(root, "research.sqlite"));
  try {
    store.createDirection({ id: "direction", title: "D", briefMarkdown: "b",
      constraintsMarkdown: "", domainPath: root });
    const a = store.createComponent("direction", "# A\n\nThread A.");
    const b = store.createComponent("direction", "# B\n\nThread B.");
    const first = store.relateComponents("direction", `${a} constrains ${b}: early account.`);
    const second = store.relateComponents("direction", `${a} constrains ${b}: revised account.`);
    assert.equal(first, second, "the pair keeps one identity");
    const rows = store.db.prepare("SELECT relationship_md FROM component_relations").all() as
      Array<{ relationship_md: string }>;
    assert.equal(rows.length, 1);
    // The latest account wins: understanding of a relationship is meant to evolve.
    assert.match(rows[0]!.relationship_md, /revised account/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a schema migration refuses to run while other daemons are live", () => {
  // A version bump applied under a running dashboard took it to HTTP 500: the
  // old code opens the migrated database and rejects it as incompatible. The
  // migration is the thing that must yield, not the running process.
  const root = mkdtempSync(join(tmpdir(), "lean-research-guard-"));
  const path = join(root, "research.sqlite");
  const created = ResearchStore.open(path);
  created.close();
  const legacy = new Database(path);
  legacy.exec("DELETE FROM research_schema_meta WHERE version > 8; INSERT OR REPLACE INTO research_schema_meta(version,applied_at,checksum) VALUES (8,'legacy','legacy');");
  legacy.close();
  // A pid file naming this process: unquestionably alive, and not our own pid
  // from the store's point of view only if it differs, so use the parent shell's
  // check indirectly by writing our own and asserting the exclusion instead.
  writeFileSync(join(root, "research-dashboard-direction.pid"), String(process.pid), "utf8");
  const ownProcessIgnored = ResearchStore.open(path);
  ownProcessIgnored.close();

  // A different live pid does block it.
  writeFileSync(join(root, "research-dashboard-direction.pid"), String(process.ppid), "utf8");
  const stale = new Database(path);
  stale.exec("DELETE FROM research_schema_meta WHERE version > 8; INSERT OR REPLACE INTO research_schema_meta(version,applied_at,checksum) VALUES (8,'legacy','legacy');");
  stale.close();
  assert.throws(() => ResearchStore.open(path), /refusing to migrate the research database/);
  rmSync(root, { recursive: true, force: true });
});

test("a synthesis that restates the standing account without new evidence is refused", () => {
  // Two live directions produced successive syntheses sharing 43-59% of their
  // content words, each superseding the last, at the cost of a full generation
  // per turn. A revision must add evidence or change the account.
  const standing = "The eviction policy fails on non-local retrieval because attention mass never marks "
    + "the isolated fact during prefill. Evidence: OUT-aaaa1111. Costs dominate at longer contexts.";
  const restated = "The eviction policy fails for non-local retrieval since attention mass does not mark "
    + "the isolated fact during prefill. Evidence: OUT-aaaa1111. Costs dominate at longer context lengths.";
  const refused = checkSynthesis({ markdown: restated, prior: { synthesisId: "SYN-1", bodyMarkdown: standing } });
  assert.equal(refused.admitted, false);
  assert.match(String(refused.feedbackMarkdown), /cites no outcome that one did not already cite/);

  // The same restatement is admitted once it brings a finding the standing
  // account does not cover.
  const withNew = `${restated} A later study, OUT-bbbb2222, narrows this to 4-bit values.`;
  assert.equal(checkSynthesis({ markdown: withNew, prior: { synthesisId: "SYN-1", bodyMarkdown: standing } }).admitted, true);

  // And a genuinely different account of the same evidence is admitted.
  const different = "Quantization error in keys disperses attention through the softmax, which is a different "
    + "mechanism from value error accumulating additively. OUT-aaaa1111 is consistent with both readings.";
  assert.equal(checkSynthesis({ markdown: different, prior: { synthesisId: "SYN-1", bodyMarkdown: standing } }).admitted, true);

  // The first synthesis in a direction has nothing to repeat.
  assert.equal(checkSynthesis({ markdown: standing, prior: null }).admitted, true);
});

test("the orchestrator context shows standing understanding, not superseded drafts", () => {
  // Prior syntheses were three quarters of the context, including drafts already
  // replaced, while the direction brief was one percent.
  const source = readFileSync(join(process.cwd(), "src", "research", "orchestrator.ts"), "utf8");
  const context = source.slice(source.indexOf("function orchestratorContext"), source.indexOf("const digested"));
  assert.match(context, /supersedes_synthesis_id/);
  assert.match(context, /live\.slice\(0, 8\)/);
  assert.match(context, /body_md\), 1_200\)/);
});
