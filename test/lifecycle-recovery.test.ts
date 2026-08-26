/**
 * Regression tests for the four ways an unattended run could stall or leak.
 *
 * Each of these was observed on a live overnight campaign: a scout that
 * outlived its campaign, an executor cycle abandoned on one recoverable model
 * fault, a child process that never returned, and a build tool launched without
 * a host compiler.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executorCorrection, isRetryableExecutorFailure } from "../src/loop/cycle.js";
import { environmentFor, needsBuildEnv } from "../src/config/msvc-env.js";
import { scoutableStatus } from "../src/scout.js";
import { Store } from "../src/store/store.js";
import { runProcess } from "../src/worker/genkit-worker.js";

function withStore<T>(run: (store: Store, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ar-lifecycle-"));
  const store = Store.open(join(root, "state.sqlite"));
  try { return run(store, root); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

function insertCampaign(store: Store, campaignId: string, status: string): void {
  store.db.prepare(
    `INSERT INTO campaigns (campaign_id, title, objective, status, base_revision, revision, config_json, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(campaignId, campaignId, "objective", status, "0".repeat(40), 0, "{}", new Date().toISOString());
}

test("a scout keeps running only while its campaign can still receive literature", () => {
  withStore((store) => {
    insertCampaign(store, "live-001", "running");
    insertCampaign(store, "paused-001", "paused");
    insertCampaign(store, "done-001", "stopped");
    insertCampaign(store, "failed-001", "failed");

    assert.equal(scoutableStatus(store, "live-001"), "running");
    // A paused campaign can resume, so its scout should still be there.
    assert.equal(scoutableStatus(store, "paused-001"), "paused");
    assert.equal(scoutableStatus(store, "done-001"), null);
    assert.equal(scoutableStatus(store, "failed-001"), null);
    // The case that leaked for days: a scout for a campaign that never existed.
    assert.equal(scoutableStatus(store, "never-created"), null);
  });
});

test("a recoverable executor fault is retried; an environment limit is not", () => {
  // One malformed tool call from the model ended a 21-minute attempt and
  // abandoned the cycle. These must buy the second attempt.
  assert.equal(isRetryableExecutorFailure("PROVIDER_ERROR:SyntaxError: Expected ',' or ']'"), true);
  assert.equal(isRetryableExecutorFailure("VALIDATION_EMPTY_RESPONSE"), true);
  assert.equal(isRetryableExecutorFailure("unknown"), true);
  // These would recur immediately and only spend the budget twice.
  assert.equal(isRetryableExecutorFailure("PROVIDER_RATE_LIMITED:429 too many requests"), false);
  assert.equal(isRetryableExecutorFailure("PROCESS_TIMEOUT"), false);
});

test("the executor correction names the real reason for the retry", () => {
  const h = { domain: { candidateFiles: ["kernel.cu"] } };
  const noChange = executorCorrection(null, h, "nvcc --version");
  assert.match(noChange, /changed no files/);

  const failed = executorCorrection("PROVIDER_ERROR:SyntaxError", h, "nvcc --version");
  assert.match(failed, /ended before it finished \(PROVIDER_ERROR:SyntaxError\)/);
  // Telling an executor whose attempt died that it "changed no files" would
  // send it looking for the wrong problem.
  assert.doesNotMatch(failed, /changed no files/);
  // Its partial work survives in the worktree and it must be told so.
  assert.match(failed, /still in the worktree/);
});

test("only host-compiler drivers pay for build environment resolution", () => {
  assert.equal(needsBuildEnv("nvcc"), true);
  assert.equal(needsBuildEnv("nvcc.exe"), true);
  assert.equal(needsBuildEnv("CMake"), true);
  assert.equal(needsBuildEnv("python"), false);
  assert.equal(needsBuildEnv("git"), false);
  // A tool that needs nothing extra is handed the worker's own environment.
  assert.equal(environmentFor("git"), process.env);
});

test("a build tool's environment carries a compiler path when the machine has one", () => {
  const resolved = environmentFor("nvcc");
  const path = resolved.PATH ?? resolved.Path ?? "";
  assert.ok(path.length > 0, "a build tool must always receive a usable PATH");
  if (process.platform === "win32" && resolved !== process.env) {
    // Discovery succeeded, so the MSVC host compiler must now be reachable —
    // this is exactly what "Cannot find compiler 'cl.exe' in PATH" reported.
    assert.ok(/VC\\Tools\\MSVC|VC\/Tools\/MSVC/i.test(path), "resolved PATH should include the MSVC toolset");
  }
});

test("a child process that produces nothing is terminated rather than left to hang", async () => {
  // Closing stdin already stops a child from waiting on operator input, but any
  // silent non-terminating process stalls a cycle the same way, so the bound is
  // on silence itself rather than on one of its causes.
  const root = mkdtempSync(join(tmpdir(), "ar-hang-"));
  try {
    writeFileSync(join(root, "wait.py"), "import time\ntime.sleep(600)\n", "utf8");
    process.env.AR_TOOL_INACTIVITY_MS = "2000";
    const started = Date.now();
    const result = await runProcess(root, "python", ["wait.py"]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `watchdog should fire quickly, took ${elapsed}ms`);
    assert.match(result.stderr, /no output for/);
    assert.notEqual(result.exitCode, 0);
  } finally {
    delete process.env.AR_TOOL_INACTIVITY_MS;
    rmSync(root, { recursive: true, force: true });
  }
});
