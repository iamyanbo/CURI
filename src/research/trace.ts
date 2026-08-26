import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Reading a run's recorded trace, and deriving where its wall clock went.
 *
 * Shared by the operator dashboard and the publisher. The dashboard shows the
 * trace text; the publisher takes only the derived timing, because the text
 * carries prompts, file paths and command output from the machine that ran it
 * while the timing carries none of that.
 */

const TRACE_WINDOW = 600;

export interface TraceSegment {
  kind: "thinking" | "tool" | "model";
  label: string;
  startMs: number;
  endMs: number;
  isError: boolean;
  seq: number | null;
  /** Derived from the heartbeat rather than a completed trace event. */
  live?: boolean;
}

export function attemptDirectory(projectRoot: string, attemptDir: unknown): string | null {
  if (!attemptDir) return null;
  const root = resolve(projectRoot); const dir = resolve(String(attemptDir)); const rel = relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return dir;
}

export function readTraceSteps(projectRoot: string, attemptDir: unknown): Array<Record<string, unknown>> {
  const dir = attemptDirectory(projectRoot, attemptDir);
  if (!dir) return [];
  const path = join(dir, "trace.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

/**
 * Where a run actually spent its wall clock. A single bar per run says only how
 * long it took; these intervals say whether that time went to reasoning, to a
 * specific tool, to waiting on the provider, or to nothing at all — which is
 * the difference between a run that is working and a run that is stuck.
 *
 * Tool intervals come from call/result pairs. Everything not covered by a tool
 * or a reasoning step is provider time: the model generating or the transport
 * waiting.
 */
export function traceSegments(steps: Array<Record<string, unknown>>, runEndMs: number): TraceSegment[] {
  const ordered = [...steps].sort((left, right) => Number(left.atMs ?? 0) - Number(right.atMs ?? 0));
  const segments: TraceSegment[] = [];
  const openCalls = new Map<string, Record<string, unknown>>();
  for (const step of ordered) {
    const kind = String(step.kind ?? "");
    const at = Number(step.atMs ?? 0);
    if (kind === "tool_call") {
      openCalls.set(String(step.toolCallId ?? `${step.toolName}-${step.seq}`), step);
      continue;
    }
    if (kind === "tool_result") {
      const key = String(step.toolCallId ?? "");
      const call = openCalls.get(key)
        ?? [...openCalls.entries()].find(([, item]) => item.toolName === step.toolName)?.[1];
      if (call) {
        openCalls.delete(String(call.toolCallId ?? `${call.toolName}-${call.seq}`));
        segments.push({
          kind: "tool", label: String(call.toolName ?? step.toolName ?? "tool"),
          startMs: Number(call.atMs ?? at), endMs: at,
          isError: Boolean(step.isError), seq: Number(call.seq ?? 0),
        });
      }
      continue;
    }
    if (kind === "thinking" || kind === "text") {
      // A reasoning or message step is recorded when it completes; the interval
      // it closes started at the previous recorded event.
      const previous = segments.length ? Math.max(...segments.map((item) => item.endMs)) : 0;
      segments.push({
        kind: kind === "thinking" ? "thinking" : "model",
        label: kind === "thinking" ? "reasoning" : "model output",
        startMs: Math.min(previous, at), endMs: at, isError: false, seq: Number(step.seq ?? 0),
      });
    }
  }
  // Tool calls still open at the end are running right now.
  for (const call of openCalls.values()) {
    segments.push({
      kind: "tool", label: String(call.toolName ?? "tool"),
      startMs: Number(call.atMs ?? 0), endMs: runEndMs, isError: false, seq: Number(call.seq ?? 0),
    });
  }
  segments.sort((left, right) => left.startMs - right.startMs);
  return segments;
}

/** Wall-clock totals by activity, including time no activity accounts for. */
export function traceBreakdown(segments: TraceSegment[], totalMs: number): Record<string, number> {
  const covered: Array<[number, number]> = [];
  const totals: Record<string, number> = { thinking: 0, tool: 0, model: 0, waiting: 0, errorMs: 0, errors: 0, toolCalls: 0 };
  for (const segment of segments) {
    const span = Math.max(0, segment.endMs - segment.startMs);
    totals[segment.kind] = (totals[segment.kind] ?? 0) + span;
    if (segment.kind === "tool") {
      totals.toolCalls!++;
      if (segment.isError) { totals.errors!++; totals.errorMs! += span; }
    }
    covered.push([segment.startMs, segment.endMs]);
  }
  // Union of covered intervals, so overlapping parallel tool calls are not
  // double-counted when deriving the uncovered remainder.
  covered.sort((left, right) => left[0] - right[0]);
  let union = 0; let cursor = -1; let start = 0;
  for (const [from, to] of covered) {
    if (cursor < 0) { start = from; cursor = to; continue; }
    if (from > cursor) { union += cursor - start; start = from; cursor = to; }
    else cursor = Math.max(cursor, to);
  }
  if (cursor >= 0) union += cursor - start;
  // Time no recorded activity covers. The worker is almost always waiting on
  // the provider here rather than doing nothing, but the trace cannot prove
  // which, so it is named for what is observable.
  totals.waiting = Math.max(0, totalMs - union);
  totals.total = totalMs;
  return totals;
}

export function safeHeartbeat(projectRoot: string, attemptDir: unknown): Record<string, unknown> | null {
  const dir = attemptDirectory(projectRoot, attemptDir);
  if (!dir) return null;
  const path = join(dir, "heartbeat.json");
  if (!existsSync(path)) return null;
  try {
    const heartbeat = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      phase: heartbeat.phase ?? null, note: heartbeat.note ?? null,
      observedAt: heartbeat.observedAt ?? null, lastProgressAt: heartbeat.lastProgressAt ?? null,
      operation: heartbeat.operation ?? null, pid: heartbeat.pid ?? null,
      activitySeq: heartbeat.activitySeq ?? 0, progressSeq: heartbeat.progressSeq ?? 0,
    };
  } catch { return null; /* a concurrently rewritten heartbeat may be briefly incomplete */ }
}

export { TRACE_WINDOW };
