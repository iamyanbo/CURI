/**
 * Detached campaign supervision — the minimum needed to leave a run overnight.
 *
 * This is NOT the fenced, epoch-managed daemon of `plans/03` §9. For one user on
 * one machine that machinery defends against threats that do not exist. What an
 * overnight run actually needs is four things:
 *
 *   1. survive the terminal closing;
 *   2. refuse to start twice against the same database;
 *   3. stop gracefully on request, at a cycle boundary, without losing work;
 *   4. tell you honestly whether it is alive, finished, or dead.
 *
 * Liveness is decided by PID *plus process start time*. A bare PID is not proof:
 * PIDs are reused, and a stale lock file naming a recycled PID would otherwise
 * look like a healthy campaign forever.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface RunFile {
  pid: number;
  startedAt: string;
  processStartId: string;
  logPath: string;
  args: string[];
}

const RUN_FILE = "campaign.run.json";
const STOP_FILE = "campaign.stop";

function runFilePath(stateDir: string): string {
  return join(stateDir, RUN_FILE);
}
export function stopFilePath(stateDir: string): string {
  return join(stateDir, STOP_FILE);
}

/**
 * A stable identity for a running process, so a recycled PID cannot be mistaken
 * for the original. On Windows this is the creation time from WMIC/CIM; on Unix
 * it is the start ticks field from /proc. Absent either, identity is unknown and
 * we say so rather than guessing.
 */
export function processStartId(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command",
         `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      ).trim();
      return out || null;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return after[19] ?? null;    // starttime field
  } catch {
    return null;
  }
}

export type Liveness =
  | { state: "running"; run: RunFile }
  | { state: "stale"; run: RunFile; reason: string }
  | { state: "none" };

export function inspect(stateDir: string): Liveness {
  const path = runFilePath(stateDir);
  if (!existsSync(path)) return { state: "none" };

  let run: RunFile;
  try {
    run = JSON.parse(readFileSync(path, "utf8")) as RunFile;
  } catch {
    return { state: "none" };
  }

  const current = processStartId(run.pid);
  if (current === null) {
    return { state: "stale", run, reason: `pid ${run.pid} is not running` };
  }
  if (run.processStartId && current !== run.processStartId) {
    // The PID exists but belongs to a different, later process.
    return { state: "stale", run, reason: `pid ${run.pid} was reused by another process` };
  }
  return { state: "running", run };
}

export function clearRunFile(stateDir: string): void {
  rmSync(runFilePath(stateDir), { force: true });
}

/** Ask a running campaign to stop at the next cycle boundary. */
export function requestStop(stateDir: string, reason: string): void {
  writeFileSync(stopFilePath(stateDir), JSON.stringify({ reason, requestedAt: new Date().toISOString() }), "utf8");
}

export function stopRequested(stateDir: string): { reason: string } | null {
  const path = stopFilePath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { reason: string };
  } catch {
    return { reason: "stop requested" };
  }
}

export function clearStopRequest(stateDir: string): void {
  rmSync(stopFilePath(stateDir), { force: true });
}

/**
 * Re-launch this CLI detached, with output to a log file, and record identity.
 * Returns the pid of the detached child.
 */
export function detach(stateDir: string, cliPath: string, args: string[]): { pid: number; logPath: string } {
  const live = inspect(stateDir);
  if (live.state === "running") {
    throw new Error(
      `a campaign is already running (pid ${live.run.pid}, started ${live.run.startedAt}). ` +
      `Use \`stop\` first, or read its log at ${live.run.logPath}`,
    );
  }
  if (live.state === "stale") {
    clearRunFile(stateDir);
  }
  clearStopRequest(stateDir);

  mkdirSync(join(stateDir, "logs"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(stateDir, "logs", `campaign-${stamp}.log`);
  const fd = openSync(logPath, "a");

  // The CLI is TypeScript, so the detached child needs the same loader this
  // process is using. Bare `node cli.ts` cannot resolve a .ts import and the
  // child dies instantly with ERR_MODULE_NOT_FOUND.
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, AUTORESEARCH_DETACHED: "1" },
  });
  child.unref();

  const pid = child.pid!;
  const run: RunFile = {
    pid,
    startedAt: new Date().toISOString(),
    processStartId: processStartId(pid) ?? "",
    logPath,
    args,
  };
  writeFileSync(runFilePath(stateDir), JSON.stringify(run, null, 2), "utf8");
  return { pid, logPath };
}

/** Record this process as the campaign owner (called by the detached child). */
export function claimOwnership(stateDir: string, logPath: string, args: string[]): void {
  const run: RunFile = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    processStartId: processStartId(process.pid) ?? "",
    logPath,
    args,
  };
  writeFileSync(runFilePath(stateDir), JSON.stringify(run, null, 2), "utf8");
}
