import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HeartbeatPhase =
  | "starting" | "model_wait" | "model_stream" | "tool_running"
  | "checkpoint" | "waiting_external" | "completed" | "failed";

export interface OperationHeartbeat {
  kind: "model" | "tool" | "process";
  name: string;
  pid?: number;
  processStartId?: string | null;
}

export interface HeartbeatSnapshot {
  version: 1;
  heartbeatId: string;
  campaignId: string | null;
  cycleId: string | null;
  attemptId: string | null;
  pid: number;
  processStartId: string | null;
  startedAt: string;
  observedAt: string;
  lastActivityAt: string;
  lastProgressAt: string;
  activitySeq: number;
  progressSeq: number;
  phase: HeartbeatPhase;
  note: string;
  operation: OperationHeartbeat | null;
}

export interface HeartbeatAssessment {
  state: "healthy" | "slow" | "review_due" | "completed" | "failed";
  safeToInterrupt: boolean;
  activityAgeMs: number;
  progressAgeMs: number;
  reason: string;
}

export interface HeartbeatPolicy {
  activityReviewMs: Partial<Record<HeartbeatPhase, number>>;
  progressReviewMs: number;
}

/**
 * Review thresholds are rolling no-progress windows, never runtime ceilings.
 * Crossing one asks for evidence; it does not authorize killing or replaying.
 */
export const DEFAULT_HEARTBEAT_POLICY: HeartbeatPolicy = {
  activityReviewMs: {
    starting: 10 * 60_000,
    model_wait: 30 * 60_000,
    model_stream: 15 * 60_000,
    tool_running: 30 * 60_000,
    checkpoint: 10 * 60_000,
    waiting_external: 25 * 60 * 60_000,
  },
  progressReviewMs: 45 * 60_000,
};

function isoNow(): string { return new Date().toISOString(); }

/** Atomic replacement prevents a monitor from reading half-written JSON. */
export function writeHeartbeat(path: string, snapshot: HeartbeatSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.heartbeat-${process.pid}-${randomUUID()}.tmp`);
  const content = JSON.stringify(snapshot, null, 2);
  writeFileSync(temp, content, "utf8");
  try {
    // Windows scanners and dashboard readers can hold the destination for a
    // short interval. A telemetry lock must not turn a healthy model attempt
    // into a failed scientific cycle, so retry transient rename failures.
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        renameSync(temp, path);
        return;
      } catch (error: any) {
        lastError = error;
        const code = String(error?.code ?? "");
        if (!["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(code)) throw error;
        // This is synchronous code by design; the wait is capped below 250ms
        // and avoids introducing async state into every heartbeat call.
        const delay = 20 * (attempt + 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
    // Keep the last valid heartbeat if the lock persists. The heartbeat is
    // advisory evidence; failing it must never kill the worker it monitors.
    void lastError;
  } finally {
    try { unlinkSync(temp); } catch { /* already renamed or scanner-held */ }
  }
}

export function readHeartbeat(path: string): HeartbeatSnapshot | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as HeartbeatSnapshot; }
  catch { return null; }
}

export class ProgressHeartbeat {
  readonly path: string;
  private snapshot: HeartbeatSnapshot;

  constructor(path: string, identity: {
    campaignId?: string; cycleId?: string; attemptId?: string; processStartId?: string | null;
  } = {}) {
    this.path = path;
    const now = isoNow();
    this.snapshot = {
      version: 1, heartbeatId: randomUUID(),
      campaignId: identity.campaignId ?? null,
      cycleId: identity.cycleId ?? null,
      attemptId: identity.attemptId ?? null,
      pid: process.pid, processStartId: identity.processStartId ?? null,
      startedAt: now, observedAt: now,
      lastActivityAt: now, lastProgressAt: now,
      activitySeq: 0, progressSeq: 0,
      phase: "starting", note: "worker starting", operation: null,
    };
    this.flush();
  }

  activity(phase: HeartbeatPhase, note: string, operation: OperationHeartbeat | null = null): void {
    const now = isoNow();
    this.snapshot = {
      ...this.snapshot, observedAt: now, lastActivityAt: now,
      activitySeq: this.snapshot.activitySeq + 1, phase, note, operation,
    };
    this.flush();
  }

  progress(phase: HeartbeatPhase, note: string, operation: OperationHeartbeat | null = null): void {
    const now = isoNow();
    this.snapshot = {
      ...this.snapshot, observedAt: now, lastActivityAt: now, lastProgressAt: now,
      activitySeq: this.snapshot.activitySeq + 1,
      progressSeq: this.snapshot.progressSeq + 1,
      phase, note, operation,
    };
    this.flush();
  }

  complete(note = "worker completed"): void { this.progress("completed", note, null); }
  fail(note: string): void { this.activity("failed", note, null); }
  current(): HeartbeatSnapshot { return { ...this.snapshot }; }
  private flush(): void { writeHeartbeat(this.path, this.snapshot); }
}

/**
 * Publish the phase of a blocking local operation. Some domain adapters use
 * spawnSync, so the child PID and incremental stdout are unavailable until it
 * returns. The owning PID still proves liveness; prolonged silence therefore
 * becomes review_due, never an automatic kill.
 */
export function observeBlockingOperation<T>(
  path: string,
  identity: { campaignId?: string; cycleId?: string; attemptId?: string; processStartId?: string | null },
  name: string,
  run: () => T,
): T {
  const heartbeat = new ProgressHeartbeat(path, identity);
  heartbeat.activity("tool_running", `${name} running`, { kind: "process", name });
  try {
    const result = run();
    heartbeat.complete(`${name} completed`);
    return result;
  } catch (error) {
    heartbeat.fail(`${name} threw: ${String(error).slice(0, 500)}`);
    throw error;
  }
}

export function assessHeartbeat(
  snapshot: HeartbeatSnapshot,
  options: { nowMs?: number; processAlive?: boolean; operationAlive?: boolean | null;
    policy?: HeartbeatPolicy } = {},
): HeartbeatAssessment {
  const now = options.nowMs ?? Date.now();
  const activityAgeMs = Math.max(0, now - Date.parse(snapshot.lastActivityAt));
  const progressAgeMs = Math.max(0, now - Date.parse(snapshot.lastProgressAt));
  const result = (state: HeartbeatAssessment["state"], safeToInterrupt: boolean, reason: string) =>
    ({ state, safeToInterrupt, activityAgeMs, progressAgeMs, reason });

  if (snapshot.phase === "completed") return result("completed", false, snapshot.note);
  if (snapshot.phase === "failed") return result("failed", true, snapshot.note);
  if (options.processAlive === false) return result("failed", true, `worker pid ${snapshot.pid} is not running`);
  if (snapshot.operation?.pid && options.operationAlive === false) {
    return result("failed", true, `${snapshot.operation.kind} ${snapshot.operation.name} exited without a terminal record`);
  }

  const policy = options.policy ?? DEFAULT_HEARTBEAT_POLICY;
  const activityLimit = policy.activityReviewMs[snapshot.phase] ?? 15 * 60_000;
  if (activityAgeMs <= activityLimit) return result("healthy", false, snapshot.note);
  if (progressAgeMs <= policy.progressReviewMs) {
    return result("slow", false, `quiet ${snapshot.phase}; recent verified progress means continue observing`);
  }
  return result(
    "review_due", false,
    `no positive activity for ${Math.round(activityAgeMs / 1000)}s and no progress for ${Math.round(progressAgeMs / 1000)}s; absence alone is not safe to interrupt`,
  );
}
