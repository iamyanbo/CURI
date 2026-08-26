import { spawn } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { runNextExecutorTask, runOrchestratorTurn } from "./orchestrator.js";
import {
  cancellableDelay, clearResearchStops, requestedStop, watcherStopFile,
} from "./control.js";
import { startMirrorSync } from "./mirror-sync.js";
import { ResearchStore, researchNow } from "./store.js";
import { watcherSweep as sweep } from "./watcher.js";

export function researchStateDir(projectRoot: string): string { return join(projectRoot, ".autoresearch"); }
export function researchDbPath(projectRoot: string): string { return join(researchStateDir(projectRoot), "research.sqlite"); }
export function openResearchStore(projectRoot: string): ResearchStore { return ResearchStore.open(researchDbPath(projectRoot)); }
export function researchSupervisorFile(projectRoot: string, directionId: string): string {
  return join(researchStateDir(projectRoot), `research-supervisor-${directionId}.pid`);
}
export function researchWatcherFile(projectRoot: string, directionId: string): string {
  return join(researchStateDir(projectRoot), `research-watcher-${directionId}.pid`);
}
export function researchDashboardFile(projectRoot: string, directionId: string): string {
  return join(researchStateDir(projectRoot), `research-dashboard-${directionId}.pid`);
}

function livePid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    process.kill(pid, 0); return pid;
  } catch { return null; }
}

export function researchSupervisorStatus(projectRoot: string, directionId: string): Record<string, unknown> {
  const path = researchSupervisorFile(projectRoot, directionId); const pid = livePid(path);
  return pid ? { running: true, pid } : { running: false, stalePidFile: existsSync(path) };
}

export function researchWatcherStatus(projectRoot: string, directionId: string): Record<string, unknown> {
  const path = researchWatcherFile(projectRoot, directionId); const pid = livePid(path);
  return pid ? { running: true, pid } : { running: false, stalePidFile: existsSync(path) };
}

export function researchDashboardStatus(projectRoot: string, directionId: string): Record<string, unknown> {
  const path = researchDashboardFile(projectRoot, directionId); const pid = livePid(path);
  return pid ? { running: true, pid } : { running: false, stalePidFile: existsSync(path) };
}

export function archiveLegacyState(projectRoot: string): string | null {
  const root = resolve(projectRoot); const state = resolve(join(root, ".autoresearch"));
  if (relative(root, state) !== ".autoresearch") throw new Error("unexpected research state path");
  if (!existsSync(state)) return null;
  const archiveRoot = resolve(join(root, ".autoresearch-legacy"));
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(archiveRoot, stamp);
  renameSync(state, target); mkdirSync(state, { recursive: true });
  return target;
}

export function clearRunStops(projectRoot: string): void {
  clearResearchStops(projectRoot);
  const watcher = watcherStopFile(projectRoot); if (existsSync(watcher)) unlinkSync(watcher);
}

export function reconcileSupervisorState(store: ResearchStore, directionId: string): void {
  const now = researchNow();
  store.db.prepare(
    `UPDATE runs SET state='failed',failure='PROCESS_LOST_ON_RESTART',completed_at=?
     WHERE direction_id=? AND role IN ('orchestrator','executor','verifier')
       AND state IN ('active','waiting_external')`,
  ).run(now, directionId);
  store.db.prepare("UPDATE tasks SET state='queued',updated_at=? WHERE direction_id=? AND state='running'")
    .run(now, directionId);
  // An attempt interrupted by an operator stop leaves its task cancelled with
  // its worktree intact, and it used to stay stranded until someone re-queued it
  // by hand. Exactly one such task is revived: the most recent one that actually
  // began work, and only when nothing else is live — a direction may hold only
  // one queued or running task, and older cancellations were deliberate.
  store.db.prepare(
    `UPDATE tasks SET state='queued',updated_at=?
     WHERE task_id = (
       SELECT task_id FROM tasks
       WHERE direction_id=? AND state='cancelled' AND workspace_path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM outcomes WHERE outcomes.task_id=tasks.task_id)
       ORDER BY updated_at DESC LIMIT 1)
       AND NOT EXISTS (
         SELECT 1 FROM tasks live WHERE live.direction_id=? AND live.state IN ('queued','running'))`,
  ).run(now, directionId, directionId);
}

export function reconcileWatcherState(store: ResearchStore, directionId: string): void {
  store.db.prepare(
    `UPDATE runs SET state='failed',failure='PROCESS_LOST_ON_RESTART',completed_at=?
     WHERE direction_id=? AND role='watcher' AND state IN ('active','waiting_external')`,
  ).run(researchNow(), directionId);
}

/**
 * Spend ceiling for a direction, in dollars; 0 runs until stopped. The lean
 * research loop had no budget of its own — the ceiling existed only on the
 * legacy campaign path — so an unattended overnight run could consume a whole
 * grant with nothing to halt it.
 */
export function continuousFile(projectRoot: string): string {
  return join(researchStateDir(projectRoot), "continuous");
}

/**
 * Whether a direction the orchestrator paused should be resumed automatically.
 *
 * Pausing is a research judgement and stays that way: the orchestrator still
 * decides it has reached a milestone, and the decision is recorded. This only
 * governs whether an unattended run stops there or takes up the next question,
 * which is a deployment choice rather than a scientific one.
 */
export function continuousMode(projectRoot: string): boolean {
  return existsSync(continuousFile(projectRoot));
}

export function costCeilingFile(projectRoot: string): string {
  return join(researchStateDir(projectRoot), "cost-ceiling");
}

/**
 * The ceiling is read fresh on every loop iteration, and a control file wins
 * over the environment. A daemon reads `.env` once at startup, so an
 * environment-only budget could not be changed without killing a running
 * experiment to restart the process — the same reason stops are files here.
 */
export function researchCostCeiling(projectRoot?: string | null, env: NodeJS.ProcessEnv = process.env): number {
  const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
  if (projectRoot) {
    const path = costCeilingFile(projectRoot);
    if (existsSync(path)) {
      try {
        const fromFile = positive(Number(readFileSync(path, "utf8").trim()));
        if (fromFile > 0) return fromFile;
      } catch { /* fall through to the environment */ }
    }
  }
  return positive(Number(env.AR_MAX_COST_USD ?? 0));
}

export function directionSpendUsd(store: ResearchStore, directionId: string): number {
  return Number((store.db.prepare("SELECT COALESCE(SUM(cost_usd),0) spend FROM runs WHERE direction_id=?")
    .get(directionId) as { spend: number }).spend);
}

/**
 * How long to wait before waking an orchestrator that had nothing to do. Starts
 * at a minute so a genuine change is picked up quickly, and reaches half an hour
 * when nothing in the direction is moving.
 */
export function idleBackoffMs(consecutiveIdleTurns: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, consecutiveIdleTurns));
}

function providerDelay(failures: number, rateLimited: boolean): number {
  if (rateLimited) return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(failures, 5));
  return failures <= 2 ? 1_000 : 5 * 60_000;
}

export async function runResearchLoop(input: {
  projectRoot: string; directionId: string; model?: string; maxTurns?: number;
}): Promise<{ turns: number; stopped: string }> {
  const store = openResearchStore(input.projectRoot);
  let turns = 0; let consecutiveProviderFailures = 0;
  try {
    while (true) {
      const stop = requestedStop(input.projectRoot);
      if (stop) return { turns, stopped: `${stop.mode}: ${stop.reason}` };
      const ceiling = researchCostCeiling(input.projectRoot);
      if (ceiling > 0) {
        const spend = directionSpendUsd(store, input.directionId);
        if (spend >= ceiling) {
          store.appendEvent(input.directionId, null, "direction.cost_ceiling", "system",
            `Recorded spend $${spend.toFixed(2)} reached the $${ceiling.toFixed(2)} ceiling. Raise AR_MAX_COST_USD to continue.`);
          return { turns, stopped: `cost ceiling reached: $${spend.toFixed(2)} of $${ceiling.toFixed(2)}` };
        }
      }
      const direction = store.direction(input.directionId);
      if (!direction || direction.status !== "active") return { turns, stopped: direction?.status ?? "missing direction" };
      const queued = store.db.prepare("SELECT 1 FROM tasks WHERE direction_id=? AND state='queued' LIMIT 1")
        .get(input.directionId);
      if (queued) {
        const executed = await runNextExecutorTask({ store, projectRoot: input.projectRoot,
          directionId: input.directionId, model: input.model });
        if (executed && !executed.result.ok) {
          if (executed.result.failure === "STOP_REQUESTED") return { turns, stopped: "now: operator requested" };
          consecutiveProviderFailures++;
          const rate = Boolean(executed.result.failure?.startsWith("PROVIDER_RATE_LIMITED"));
          if (!await cancellableDelay(input.projectRoot, providerDelay(consecutiveProviderFailures, rate))) {
            return { turns, stopped: "now: operator requested" };
          }
          continue;
        }
        consecutiveProviderFailures = 0;
        continue;
      }
      const turn = await runOrchestratorTurn({ store, projectRoot: input.projectRoot,
        directionId: input.directionId, model: input.model });
      turns++;
      if (!turn.result.ok) {
        if (turn.result.failure === "STOP_REQUESTED") return { turns, stopped: "now: operator requested" };
        consecutiveProviderFailures++;
        const rate = Boolean(turn.result.failure?.startsWith("PROVIDER_RATE_LIMITED"));
        if (!await cancellableDelay(input.projectRoot, providerDelay(consecutiveProviderFailures, rate))) {
          return { turns, stopped: "now: operator requested" };
        }
        continue;
      }
      consecutiveProviderFailures = 0;
      if (turn.paused) return { turns, stopped: "orchestrator paused direction" };
      if ((input.maxTurns ?? 0) > 0 && turns >= input.maxTurns!) return { turns, stopped: "turn limit reached" };
      if (!turn.taskId) {
        // No busy self-dialogue. A new source, executor result, operator turn,
        // or the next supervisor interval can wake the orchestrator.
        return { turns, stopped: "idle: no experiment delegated" };
      }
    }
  } finally { store.close(); }
}

function startDetached(projectRoot: string, args: string[], pidPath: string, logPath: string): { running: boolean; pid: number } {
  const existing = livePid(pidPath); if (existing) return { running: true, pid: existing };
  mkdirSync(researchStateDir(projectRoot), { recursive: true });
  // Output used to be discarded, so a daemon that died on startup left an empty
  // log, a removed pid file, and no explanation anywhere. Both streams now append
  // to the daemon's own log.
  writeFileSync(logPath, `starting ${researchNow()}: ${args.join(" ")}\n`, "utf8");
  const logFd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, ["--import", "tsx", join(projectRoot, "src", "cli.ts"), ...args], {
      cwd: projectRoot, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd], env: process.env,
    });
  } finally { closeSync(logFd); }
  if (!child.pid) throw new Error("failed to start detached research process");
  child.unref(); writeFileSync(pidPath, String(child.pid), "utf8");
  appendFileSync(logPath, `started ${child.pid} ${researchNow()}\n`, "utf8");
  return { running: true, pid: child.pid };
}

export function startResearchSupervisor(input: { projectRoot: string; directionId: string; model?: string }) {
  const args = ["research", "supervisor", "daemon", "--direction", input.directionId];
  if (input.model) args.push("--model", input.model);
  return startDetached(input.projectRoot, args, researchSupervisorFile(input.projectRoot, input.directionId),
    join(researchStateDir(input.projectRoot), `research-supervisor-${input.directionId}.log`));
}

export async function runResearchSupervisor(input: { projectRoot: string; directionId: string; model?: string }): Promise<void> {
  const pidPath = researchSupervisorFile(input.projectRoot, input.directionId);
  writeFileSync(pidPath, String(process.pid), "utf8");
  // The public record is republished from here rather than by hand, so the
  // mirror shows the direction as it is now instead of as it was whenever
  // someone last ran `research publish`. No-op unless a project is configured.
  const stopMirrorSync = startMirrorSync({ projectRoot: input.projectRoot, directionId: input.directionId });
  try {
    const recoveryStore = openResearchStore(input.projectRoot);
    try { reconcileSupervisorState(recoveryStore, input.directionId); } finally { recoveryStore.close(); }
    // An idle turn means the orchestrator had nothing to delegate. Re-asking a
    // minute later with an unchanged context buys the same answer at full price,
    // and a turn is not cheap: context grows with every source, outcome and
    // synthesis. So idle turns back off, and the backoff resets the moment the
    // direction actually changes — a new source, a returned task, anything that
    // appends an event.
    // "Run continuously" means stay available for work, not keep poking the
    // orchestrator. A pause and an idle turn are the same signal — there is
    // nothing worth doing right now — so both back off on the same curve and
    // both reset the moment the direction actually changes. Without this, a
    // direction the orchestrator judged finished would be re-asked every few
    // seconds at the price of a full turn each time.
    let quietTurns = 0;
    let lastSeenEvent = -1;
    while (!requestedStop(input.projectRoot)) {
      const result = await runResearchLoop({ ...input });
      const paused = result.stopped === "paused" || result.stopped === "orchestrator paused direction";
      const idle = result.stopped.startsWith("idle");
      if (!paused && !idle) break;
      if (paused && !continuousMode(input.projectRoot)) break;

      const store = openResearchStore(input.projectRoot);
      let latestEvent = lastSeenEvent;
      try {
        latestEvent = Number((store.db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM events WHERE direction_id=?")
          .get(input.directionId) as { seq: number }).seq);
        if (paused) {
          // The pause stands in the record; continuous mode only decides whether
          // the direction is taken up again once something has moved on.
          store.db.prepare("UPDATE directions SET status='active',updated_at=? WHERE direction_id=?").run(researchNow(), input.directionId);
          store.appendEvent(input.directionId, null, "direction.resumed", "system",
            "Continuous mode took the paused direction up again. The pause and its reasoning remain recorded.");
        }
      } finally { store.close(); }

      quietTurns = latestEvent > lastSeenEvent ? 0 : quietTurns + 1;
      lastSeenEvent = latestEvent;
      if (!await cancellableDelay(input.projectRoot, idleBackoffMs(quietTurns))) break;
    }
  } finally {
    // One last publish, so the record the mirror serves is the state the run
    // actually ended in rather than the state at the previous tick.
    await stopMirrorSync();
    try { unlinkSync(pidPath); } catch { /* best effort */ }
  }
}

export function startWatcherDaemon(input: { projectRoot: string; directionId: string; model?: string }) {
  const args = ["research", "watch", "daemon", "--direction", input.directionId];
  if (input.model) args.push("--model", input.model);
  return startDetached(input.projectRoot, args, researchWatcherFile(input.projectRoot, input.directionId),
    join(researchStateDir(input.projectRoot), `research-watcher-${input.directionId}.log`));
}

export function startResearchDashboard(input: { projectRoot: string; directionId: string; port: number }) {
  return startDetached(input.projectRoot,
    ["research", "dashboard", "daemon", "--direction", input.directionId, "--port", String(input.port)],
    researchDashboardFile(input.projectRoot, input.directionId),
    join(researchStateDir(input.projectRoot), `research-dashboard-${input.directionId}.log`));
}

export async function runWatcherDaemon(input: { projectRoot: string; directionId: string; model?: string }): Promise<void> {
  const pidPath = researchWatcherFile(input.projectRoot, input.directionId);
  writeFileSync(pidPath, String(process.pid), "utf8");
  try {
    const recoveryStore = openResearchStore(input.projectRoot);
    try { reconcileWatcherState(recoveryStore, input.directionId); } finally { recoveryStore.close(); }
    while (!existsSync(watcherStopFile(input.projectRoot)) && !requestedStop(input.projectRoot)) {
      const store = openResearchStore(input.projectRoot);
      const ceiling = researchCostCeiling(input.projectRoot);
      if (ceiling > 0 && directionSpendUsd(store, input.directionId) >= ceiling) { store.close(); return; }
      let interval = 3600;
      try {
        const result = await sweep({ store, ...input });
        interval = Number((store.db.prepare("SELECT interval_seconds FROM watcher_config WHERE direction_id=?")
          .get(input.directionId) as { interval_seconds: number } | undefined)?.interval_seconds ?? 3600);
        if (result.backoffUntil) {
          const remaining = Math.ceil((Date.parse(result.backoffUntil) - Date.now()) / 1000);
          interval = Math.max(30, Math.min(interval, remaining));
        }
      } finally { store.close(); }
      const deadline = Date.now() + Math.max(30, interval) * 1000;
      while (Date.now() < deadline) {
        if (existsSync(watcherStopFile(input.projectRoot)) || requestedStop(input.projectRoot)) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(1_000, deadline - Date.now())));
      }
    }
  } finally { try { unlinkSync(pidPath); } catch { /* best effort */ } }
}

export async function watcherSweep(input: { projectRoot: string; directionId: string; model?: string; maxRead?: number }) {
  const store = openResearchStore(input.projectRoot);
  try { return await sweep({ store, ...input }); } finally { store.close(); }
}
