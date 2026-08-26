import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  commitCandidate, commitProgramCheckpoint, createWorktree, diffAgainstHead,
  ensureRepo, git, removeWorktree,
} from "../src/core/workspace.js";

test("new files survive dependent program checkpoints and final promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-program-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  let first = "";
  let second = "";
  try {
    const baseline = ensureRepo(repo, (dir) => writeFileSync(join(dir, "entry.txt"), "baseline\n"));
    first = createWorktree(repo, worktrees, "first", baseline);
    writeFileSync(join(first, "novel.txt"), "milestone one\n");
    const firstDiff = diffAgainstHead(first);
    assert.deepEqual(firstDiff.changedPaths, ["novel.txt"]);
    assert.match(firstDiff.diffText, /milestone one/);
    removeWorktree(repo, first);
    first = "";

    const checkpoint = commitProgramCheckpoint(
      repo, worktrees, baseline, firstDiff.diffText, "milestone one", "abcdef1234567890",
    );
    assert.equal(checkpoint.ok, true);
    if (!checkpoint.ok) return;

    second = createWorktree(repo, worktrees, "second", checkpoint.revision);
    writeFileSync(join(second, "novel.txt"), "milestone two\n");
    const secondDiff = diffAgainstHead(second);
    removeWorktree(repo, second);
    second = "";

    const promoted = commitCandidate(repo, worktrees, checkpoint.revision, secondDiff.diffText, "complete program");
    assert.equal(promoted.ok, true);
    if (promoted.ok) {
      assert.equal(git(["show", `${promoted.revision}:novel.txt`], repo), "milestone two");
      assert.equal(git(["show", `${promoted.revision}:entry.txt`], repo), "baseline");
    }
  } finally {
    if (first) removeWorktree(repo, first);
    if (second) removeWorktree(repo, second);
    rmSync(root, { recursive: true, force: true });
  }
});
