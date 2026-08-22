/**
 * Trace-derived timing used by the dashboard.
 *
 * Worker wall time used to be recorded as one large `model_reasoning` block,
 * even while the model was waiting for a tool or a command. The sealed worker trace
 * contains paired tool start/end events, so those spans can be removed from
 * model time without guessing. The remaining wall time is deliberately named
 * model reasoning: it means "model active or awaiting a model response", not
 * a claim that every hidden token is available to inspect.
 */

export interface TimedTraceStep {
  seq: number;
  atMs: number;
  kind: "thinking" | "text" | "tool_call" | "tool_result";
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content: string;
}

export type UiTimeCategory =
  | "model_reasoning"
  | "tool_execution"
  | "command_execution"
  | "compute"
  | "evaluation"
  | "supervisor"
  | "queue"
  | "blocked"
  | "human"
  | "unknown";

export interface TraceSegment {
  category: UiTimeCategory;
  startMs: number;
  endMs: number;
  label: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: string;
}

const COMMAND_TOOLS = new Set([
  "bash", "shell", "terminal", "exec", "command", "cmd", "powershell",
  "exec_command", "shell_command",
]);

export function categoryForTool(toolName: string | undefined): "tool_execution" | "command_execution" {
  const normalised = String(toolName ?? "tool").toLowerCase().replace(/[.:-]/g, "_");
  return COMMAND_TOOLS.has(normalised) || /(^|_)(bash|shell|terminal|command|powershell|cmd)($|_)/.test(normalised)
    ? "command_execution"
    : "tool_execution";
}

/** Pair tool calls with their results, then fill the uncovered wall time with model time. */
export function segmentAgentTrace(trace: TimedTraceStep[], durationMs: number): TraceSegment[] {
  const duration = Math.max(0, Math.round(durationMs));
  const open = new Map<string, TimedTraceStep>();
  const toolSegments: TraceSegment[] = [];

  for (const step of [...trace].sort((a, b) => a.atMs - b.atMs || a.seq - b.seq)) {
    if (step.kind === "tool_call") {
      open.set(step.toolCallId ?? `seq:${step.seq}`, step);
      continue;
    }
    if (step.kind !== "tool_result") continue;

    let call = step.toolCallId ? open.get(step.toolCallId) : undefined;
    if (!call) {
      // Older traces occasionally omitted ids. Pair with the most recent open
      // call of the same tool rather than dropping a measurable span.
      call = [...open.values()].reverse().find((candidate) => candidate.toolName === step.toolName);
    }
    if (!call) continue;
    const key = call.toolCallId ?? `seq:${call.seq}`;
    open.delete(key);
    const startMs = Math.max(0, Math.min(duration, Math.round(call.atMs)));
    const endMs = Math.max(startMs, Math.min(duration, Math.round(step.atMs)));
    toolSegments.push({
      category: categoryForTool(call.toolName),
      startMs,
      endMs,
      label: call.toolName ?? "tool",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      isError: step.isError,
      content: call.content,
    });
  }

  // A still-running call has no end event. Bound it by the observed worker
  // duration so live/failed attempts do not disappear from the timeline.
  for (const call of open.values()) {
    const startMs = Math.max(0, Math.min(duration, Math.round(call.atMs)));
    toolSegments.push({
      category: categoryForTool(call.toolName),
      startMs,
      endMs: duration,
      label: call.toolName ?? "tool",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      content: call.content,
    });
  }

  toolSegments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: TraceSegment[] = [];
  let cursor = 0;
  for (const tool of toolSegments) {
    // Tools are expected to be serial. Clamp a malformed overlap so the
    // resulting categories still sum to exactly the worker wall time.
    const start = Math.max(cursor, tool.startMs);
    const end = Math.max(start, tool.endMs);
    if (start > cursor) {
      out.push({ category: "model_reasoning", startMs: cursor, endMs: start, label: "Model reasoning" });
    }
    if (end > start) out.push({ ...tool, startMs: start, endMs: end });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) {
    out.push({ category: "model_reasoning", startMs: cursor, endMs: duration, label: "Model reasoning" });
  }
  return out;
}

export function sumSegments(segments: TraceSegment[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const segment of segments) {
    const ms = Math.max(0, segment.endMs - segment.startMs);
    totals[segment.category] = (totals[segment.category] ?? 0) + ms;
  }
  return totals;
}
