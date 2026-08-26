/** Detached watcher lifecycle, isolated from the campaign daemon run file. */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { processStartId, type Liveness, type RunFile } from "../daemon.js";

function safeCampaign(campaignId: string): string {
  return campaignId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function watcherDir(stateDir: string, campaignId: string): string {
  return join(stateDir, "watchers", safeCampaign(campaignId));
}

function runPath(stateDir: string, campaignId: string): string {
  return join(watcherDir(stateDir, campaignId), "watcher.run.json");
}

function startLockPath(stateDir: string, campaignId: string): string {
  return join(watcherDir(stateDir, campaignId), "watcher.start.lock");
}

export function watcherStopPath(stateDir: string, campaignId: string): string {
  return join(watcherDir(stateDir, campaignId), "watcher.stop.json");
}

export function inspectWatcher(stateDir: string, campaignId: string): Liveness {
  const path = runPath(stateDir, campaignId);
  if (!existsSync(path)) return { state: "none" };
  let run: RunFile;
  try { run = JSON.parse(readFileSync(path, "utf8")) as RunFile; }
  catch { return { state: "none" }; }
  const current = processStartId(run.pid);
  if (current === null) return { state: "stale", run, reason: `watcher pid ${run.pid} is not running` };
  if (run.processStartId && current !== run.processStartId) {
    return { state: "stale", run, reason: `watcher pid ${run.pid} was reused` };
  }
  return { state: "running", run };
}

export function startWatcher(
  stateDir: string, campaignId: string, entryPath: string, projectRoot: string,
): { pid: number; logPath: string; alreadyRunning: boolean } {
  const live = inspectWatcher(stateDir, campaignId);
  if (live.state === "running") {
    return { pid: live.run.pid, logPath: live.run.logPath, alreadyRunning: true };
  }
  const dir = watcherDir(stateDir, campaignId);
  mkdirSync(dir, { recursive: true });
  const lockPath = startLockPath(stateDir, campaignId);
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch (error: any) {
    const current = inspectWatcher(stateDir, campaignId);
    if (current.state === "running") {
      return { pid: current.run.pid, logPath: current.run.logPath, alreadyRunning: true };
    }
    // A launcher killed in the critical section can leave only this tiny lock.
    // Reclaim it after a generous startup window; a live launch never holds it
    // for more than the synchronous spawn + run-file write below.
    const stale = existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 30_000;
    if (stale) {
      rmSync(lockPath, { force: true });
      return startWatcher(stateDir, campaignId, entryPath, projectRoot);
    }
    throw new Error(`watcher start is already in progress (${String(error?.code ?? error)})`);
  }
  try {
    const afterLock = inspectWatcher(stateDir, campaignId);
    if (afterLock.state === "running") {
      return { pid: afterLock.run.pid, logPath: afterLock.run.logPath, alreadyRunning: true };
    }
    if (afterLock.state === "stale") rmSync(runPath(stateDir, campaignId), { force: true });
    rmSync(watcherStopPath(stateDir, campaignId), { force: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = join(dir, `watcher-${stamp}.log`);
    const logFd = openSync(logPath, "a");
    const args = ["--import", "tsx", entryPath, "--campaign", campaignId, "--project-root", projectRoot];
    let child;
    try {
      child = spawn(process.execPath, args, {
        detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true,
        cwd: projectRoot, env: { ...process.env, AUTORESEARCH_WATCHER: "1" },
      });
    } finally {
      closeSync(logFd);
    }
    child.unref();
    const pid = child.pid!;
    const run: RunFile = {
      pid, startedAt: new Date().toISOString(), processStartId: processStartId(pid) ?? "",
      logPath, args,
    };
    writeFileSync(runPath(stateDir, campaignId), JSON.stringify(run, null, 2), "utf8");
    return { pid, logPath, alreadyRunning: false };
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

export function requestWatcherStop(stateDir: string, campaignId: string, reason: string): void {
  const dir = watcherDir(stateDir, campaignId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    watcherStopPath(stateDir, campaignId),
    JSON.stringify({ reason, requestedAt: new Date().toISOString() }), "utf8",
  );
}

export function watcherStopRequested(stateDir: string, campaignId: string): boolean {
  return existsSync(watcherStopPath(stateDir, campaignId));
}

export function clearWatcherRun(stateDir: string, campaignId: string): void {
  rmSync(runPath(stateDir, campaignId), { force: true });
}
