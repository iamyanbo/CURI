import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MIRROR_COLLECTIONS } from "../src/research/mirror.js";
import { buildPublishedRecord, redact } from "../src/research/publish.js";
import { ResearchStore } from "../src/research/store.js";

const BS = String.fromCharCode(92);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lean-publish-"));
  const store = ResearchStore.open(join(root, "research.sqlite"));
  store.createDirection({
    id: "direction", title: "Direction", briefMarkdown: "Investigate mechanisms.",
    constraintsMarkdown: "", domainPath: root,
  });
  return { root, store };
}

test("machine identity is stripped from anything published", () => {
  const windows = `wrote C:${BS}Users${BS}yanbo${BS}downloads${BS}study${BS}run.py`;
  assert.equal(redact(windows).includes("yanbo"), false);
  assert.equal(redact(windows).includes("C:" + BS), false);
  assert.match(redact(windows), /<workspace>/);
  assert.equal(redact("/home/alice/secret/run.py").includes("alice"), false);
  assert.equal(redact("/Users/bob/x").includes("bob"), false);
  // Ordinary research prose is untouched.
  assert.equal(redact("H2O retains 0% of needles at 12.5% budget"),
    "H2O retains 0% of needles at 12.5% budget");
});

test("the published record carries research and nothing about the host", () => {
  const { root, store } = fixture();
  try {
    const taskId = store.delegateTask({
      directionId: "direction", mode: "exploration",
      markdown: `# Study\nRun C:${BS}Users${BS}yanbo${BS}study${BS}bench.py on the local GPU.`,
    });
    store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator',workspace_path=? WHERE task_id=?")
      .run(`C:${BS}Users${BS}yanbo${BS}worktrees${BS}ws`, taskId);
    store.recordOutcome({ directionId: "direction", taskId, verdict: "bounded", markdown: "Bounded to L<=2048." });
    const runId = store.beginRun({
      directionId: "direction", taskId, role: "executor",
      inputMarkdown: `secret prompt naming C:${BS}Users${BS}yanbo and py -3.10`,
      attemptDir: `C:${BS}Users${BS}yanbo${BS}.autoresearch${BS}attempts${BS}x`,
    });
    store.finishRun({ runId, state: "succeeded", outputMarkdown: "done", inputTokens: 10, outputTokens: 2, costUsd: 0.01 });

    const record = buildPublishedRecord(store, "direction");
    const json = JSON.stringify(record);
    // The prompt is where the preflight sheet and worktree paths live, so it is
    // never published at all rather than being scrubbed.
    assert.equal(json.includes("secret prompt"), false);
    assert.equal(json.includes("input_md"), false);
    assert.equal(json.includes("attempt_dir"), false);
    assert.equal(json.includes("workspace_path"), false);
    assert.equal(json.includes("yanbo"), false);
    assert.equal(json.includes("C:" + BS), false);
    // The research itself survives.
    assert.equal(record.outcomes[0]!.verdict, "bounded");
    assert.match(String(record.tasks[0]!.brief_md), /Study/);
    assert.equal(record.runs[0]!.state, "succeeded");
    assert.equal(Number(record.spend.costUsd), 0.01);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("every published entity stays far below the Firestore document ceiling", () => {
  const { root, store } = fixture();
  try {
    store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "# Task\n" + "x".repeat(4_000) });
    const record = buildPublishedRecord(store, "direction");
    for (const [name, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        assert.ok(JSON.stringify(item).length < 1_000_000, `${name} document exceeds the 1 MB limit`);
      }
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the hosted mirror cannot reach local research state", () => {
  // The public process must not be able to open the SQLite store, spawn a
  // worker, or read a worktree, so the guarantee is enforced by its import
  // graph rather than by remembering not to call things.
  const mirror = readFileSync(join(process.cwd(), "src", "research", "mirror.ts"), "utf8");
  assert.doesNotMatch(mirror, /from "\.\/store\.js"/);
  assert.doesNotMatch(mirror, /from "\.\/runtime\.js"/);
  assert.doesNotMatch(mirror, /from "\.\/commands\.js"/);
  assert.doesNotMatch(mirror, /better-sqlite3|genkit-worker/);
  // Only a type import of the record shape is allowed, and types are erased.
  assert.match(mirror, /import type \{[^}]*PublishedRecord[^}]*\} from "\.\/publish\.js"/);
  const entry = readFileSync(join(process.cwd(), "src", "research", "mirror-entry.ts"), "utf8");
  assert.match(entry, /import \{ serveMirror \} from "\.\/mirror\.js"/);
  assert.doesNotMatch(entry, /cli|commands|runtime/);
});

test("the mirror serves nothing that could change state", () => {
  const mirror = readFileSync(join(process.cwd(), "src", "research", "mirror.ts"), "utf8");
  assert.match(mirror, /request\.method !== "GET"/);
  for (const route of ["/api/control", "/api/workspace-file", "/reviews"]) {
    assert.doesNotMatch(mirror, new RegExp(route.replace(/[/-]/g, "\$&")));
  }
});

test("published document ids are declared per collection, not guessed", () => {
  // Runs and commands both carry a task_id. A generic "first *_id field" rule
  // keyed every run of a task to the same document, so they overwrote each
  // other and the publish still reported success.
  const byName = new Map(MIRROR_COLLECTIONS.map((entry) => [entry.name, entry.idField]));
  assert.equal(byName.get("runs"), "run_id");
  assert.equal(byName.get("tasks"), "task_id");
  assert.equal(byName.get("outcomes"), "outcome_id");
  assert.equal(byName.get("syntheses"), "synthesis_id");
  assert.equal(byName.get("sources"), "source_id");
  // Rows with no natural identity fall back to a positional id rather than
  // colliding on a shared foreign key.
  assert.equal(byName.get("commands"), null);
  assert.equal(byName.get("componentRelations"), null);
});

test("several runs of one task keep distinct published identities", () => {
  const { root, store } = fixture();
  try {
    const taskId = store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "# Study" });
    store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator' WHERE task_id=?").run(taskId);
    for (const state of ["failed", "cancelled", "succeeded"]) {
      const runId = store.beginRun({ directionId: "direction", taskId, role: "executor", inputMarkdown: "brief" });
      store.finishRun({ runId, state: state as never, outputMarkdown: "" });
    }
    const record = buildPublishedRecord(store, "direction");
    const idField = MIRROR_COLLECTIONS.find((entry) => entry.name === "runs")!.idField!;
    const ids = record.runs.map((run) => String(run[idField]));
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, "three attempts on one task must not share a document id");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
