import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEGACY_STATE_DIR, STATE_DIR, stateDirName, statePath } from "../src/research/paths.js";

const withRoot = (build: (root: string) => void, check: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "curi-paths-"));
  try { build(root); check(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("a fresh project uses the current name", () => {
  withRoot(() => {}, (root) => assert.equal(stateDirName(root), STATE_DIR));
});

test("a project that already has the legacy directory keeps it", () => {
  // A run in progress cannot be renamed underneath itself: the store records
  // attempt directories and git registers worktrees by absolute path, so an
  // existing directory is used as it is and moving it is a migration.
  withRoot((root) => mkdirSync(join(root, LEGACY_STATE_DIR)),
    (root) => assert.equal(stateDirName(root), LEGACY_STATE_DIR));
});

test("the current name wins when both exist", () => {
  withRoot((root) => { mkdirSync(join(root, LEGACY_STATE_DIR)); mkdirSync(join(root, STATE_DIR)); },
    (root) => assert.equal(stateDirName(root), STATE_DIR));
});

test("an explicit override beats both", () => {
  withRoot((root) => mkdirSync(join(root, LEGACY_STATE_DIR)), (root) => {
    assert.equal(stateDirName(root, { CURI_STATE_DIR: ".elsewhere" } as NodeJS.ProcessEnv), ".elsewhere");
  });
});

test("state paths are built from the resolved directory", () => {
  withRoot((root) => mkdirSync(join(root, LEGACY_STATE_DIR)), (root) => {
    assert.equal(statePath(root, "research.sqlite"), join(root, LEGACY_STATE_DIR, "research.sqlite"));
  });
});
