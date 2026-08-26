import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  livePidFiles, migrateState, planMigration, rewriteRecordedPaths, staleRecordedPaths,
} from "../src/research/migrate-state.js";
import { ResearchStore } from "../src/research/store.js";

const LEGACY = ".autoresearch";
const CURRENT = ".curi";

/** A project with a legacy state directory, a store, and recorded paths. */
function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "curi-migrate-"));
  const state = join(root, LEGACY);
  mkdirSync(join(state, "attempts"), { recursive: true });
  mkdirSync(join(state, "worktrees"), { recursive: true });

  const store = ResearchStore.open(join(state, "research.sqlite"));
  try {
    store.createDirection({
      id: "direction", title: "t", briefMarkdown: "b", constraintsMarkdown: "c",
      domainPath: join(root, "domain.json"),
    });
    const taskId = store.delegateTask({ directionId: "direction", mode: "exploration", markdown: "# Study" });
    store.db.prepare("UPDATE tasks SET workspace_path=? WHERE task_id=?")
      .run(join(state, "worktrees", "TASK-ws"), taskId);
    store.beginRun({ directionId: "direction", taskId, role: "executor",
      inputMarkdown: "brief", attemptDir: join(state, "attempts", "attempt-1") });
    // Source paths are stored *relative*, beginning with the directory name.
    // A rewrite anchored on a leading separator misses them entirely.
    store.db.prepare(
      `INSERT INTO sources (source_id,direction_id,provider,canonical_url,title,state,card_md,
        raw_path,normalized_path,created_at,updated_at)
       VALUES ('SRC-1','direction','arxiv','https://arxiv.org/abs/1','t','relevant','c',?,?,?,?)`,
    ).run(`${LEGACY}/sources/direction/SRC-1.raw`, `${LEGACY}/sources/direction/SRC-1.md`,
      new Date().toISOString(), new Date().toISOString());
  } finally { store.close(); }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the plan reports what would be rewritten without touching anything", () => {
  const { root, cleanup } = fixture();
  try {
    const plan = planMigration(root);
    assert.equal(plan.from, LEGACY);
    assert.equal(plan.to, CURRENT);
    assert.equal(plan.attemptDirs, 1);
    assert.equal(plan.workspacePaths, 1);
    assert.equal(existsSync(join(root, LEGACY)), true);
    assert.equal(existsSync(join(root, CURRENT)), false);
  } finally { cleanup(); }
});

test("migration moves the directory and rewrites recorded paths", () => {
  const { root, cleanup } = fixture();
  try {
    const result = migrateState(root);
    assert.equal(result.moved, true);
    assert.equal(existsSync(join(root, LEGACY)), false);
    assert.equal(existsSync(join(root, CURRENT)), true);

    const store = ResearchStore.open(join(root, CURRENT, "research.sqlite"));
    try {
      const stale = store.db.prepare(
        "SELECT COUNT(*) n FROM runs WHERE attempt_dir LIKE '%.autoresearch%'").get() as { n: number };
      assert.equal(stale.n, 0, "no run may still point into the old directory");
      const run = store.db.prepare("SELECT attempt_dir d FROM runs LIMIT 1").get() as { d: string };
      assert.match(run.d, /\.curi/);
      const task = store.db.prepare("SELECT workspace_path p FROM tasks LIMIT 1").get() as { p: string };
      assert.match(task.p, /\.curi/);
      // The rewritten path must point at something that exists, which is the
      // whole reason the move happens before the rewrite.
      assert.equal(existsSync(join(root, CURRENT, "worktrees")), true);
    } finally { store.close(); }
  } finally { cleanup(); }
});

test("migration refuses while a daemon is live", () => {
  const { root, cleanup } = fixture();
  try {
    // This process is unquestionably alive, which is what the check looks for.
    writeFileSync(join(root, LEGACY, "research-supervisor-direction.pid"), String(process.pid), "utf8");
    assert.equal(livePidFiles(root, LEGACY).length, 1);
    assert.throws(() => migrateState(root), /refusing to migrate while research is running/);
    // Refused means untouched, not half-done.
    assert.equal(existsSync(join(root, LEGACY)), true);
    assert.equal(existsSync(join(root, CURRENT)), false);
  } finally { cleanup(); }
});

test("a stale pid file does not block migration", () => {
  const { root, cleanup } = fixture();
  try {
    // A pid that cannot exist: the daemon is gone, the file was left behind.
    writeFileSync(join(root, LEGACY, "research-watcher-direction.pid"), "999999999", "utf8");
    assert.deepEqual(livePidFiles(root, LEGACY), []);
    assert.equal(migrateState(root).moved, true);
  } finally { cleanup(); }
});

test("migration refuses when the target already exists", () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, CURRENT));
    assert.throws(() => migrateState(root), /already exists/);
    assert.equal(existsSync(join(root, LEGACY)), true);
  } finally { cleanup(); }
});

test("registered worktrees are repaired at their new location", () => {
  const { root, cleanup } = fixture();
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(root, "file.txt"), "content", "utf8");
    git("add", "-A");
    git("commit", "-qm", "initial");
    const worktree = join(root, LEGACY, "worktrees", "wt");
    git("worktree", "add", "-q", "--detach", worktree);

    const plan = planMigration(root);
    assert.equal(plan.worktrees.length, 1, "the worktree inside the state directory is in the plan");

    const result = migrateState(root);
    assert.equal(result.repairFailures.length, 0, `repair failed: ${result.repairFailures.join("; ")}`);
    const listed = execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.match(listed, /\.curi/);
    assert.doesNotMatch(listed, /\.autoresearch/);
  } finally { cleanup(); }
});

test("relative source paths are rewritten, not just absolute ones", () => {
  // The case a separator-anchored rewrite silently skipped: 27 rows in a real
  // project were left pointing at a directory that no longer existed.
  const { root, cleanup } = fixture();
  try {
    migrateState(root);
    const store = ResearchStore.open(join(root, CURRENT, "research.sqlite"));
    try {
      const row = store.db.prepare("SELECT raw_path r, normalized_path n FROM sources").get() as
        { r: string; n: string };
      assert.equal(row.r, ".curi/sources/direction/SRC-1.raw");
      assert.equal(row.n, ".curi/sources/direction/SRC-1.md");
      assert.equal(staleRecordedPaths(store, LEGACY), 0);
    } finally { store.close(); }
  } finally { cleanup(); }
});

test("recorded paths can be repaired without moving anything", () => {
  // Finishes a migration whose directory move already happened.
  const { root, cleanup } = fixture();
  try {
    migrateState(root);
    const store = ResearchStore.open(join(root, CURRENT, "research.sqlite"));
    try {
      store.db.prepare("UPDATE sources SET raw_path=?").run(`${LEGACY}/sources/direction/SRC-1.raw`);
      assert.equal(staleRecordedPaths(store, LEGACY), 1);
      assert.equal(rewriteRecordedPaths(store, LEGACY, CURRENT) >= 1, true);
      assert.equal(staleRecordedPaths(store, LEGACY), 0);
    } finally { store.close(); }
  } finally { cleanup(); }
});
