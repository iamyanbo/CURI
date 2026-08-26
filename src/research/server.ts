import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cachedPreflight, renderPreflightMarkdown } from "./preflight.js";
import {
  clearRunStops, continuousFile, continuousMode, openResearchStore, researchCostCeiling,
  researchDashboardStatus, researchSupervisorStatus, researchWatcherStatus, startResearchSupervisor,
} from "./runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bytes of a workspace file the preview endpoint will return. */
const PREVIEW_LIMIT = 256 * 1024;

export function insideWorkspace(workspace: string, candidate: string): string | null {
  const base = resolve(workspace); const full = resolve(base, candidate);
  const rel = relative(base, full);
  // On Windows `relative` returns an absolute path when the roots differ, so an
  // absolute result is itself an escape, as is any parent traversal.
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return full;
}

/**
 * Files a running task has produced so far. Command rows and artifacts are only
 * written when an attempt returns, so without this a live experiment shows an
 * empty evidence panel for hours while its results sit on disk.
 */
function workspaceEvidence(workspace: unknown): { path: string; files: Array<Record<string, unknown>> } | null {
  if (!workspace || !existsSync(String(workspace))) return null;
  const path = String(workspace);
  let entries: string[] = [];
  try {
    entries = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: path, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }).split(/\r?\n/).filter(Boolean);
  } catch { return { path, files: [] }; }
  const files = entries.slice(0, 400).flatMap((entry) => {
    const status = entry.slice(0, 2).trim() || "?";
    const relPath = entry.slice(3).replace(/^"|"$/g, "");
    const full = insideWorkspace(path, relPath);
    if (!full || !existsSync(full)) return [];
    try {
      const stat = statSync(full);
      if (!stat.isFile()) return [];
      return [{ path: relPath, status, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }];
    } catch { return []; }
  });
  files.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
  return { path, files };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length; if (length > 64 * 1024) throw new Error("request body exceeds 64 KiB");
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be an object");
  return parsed as Record<string, unknown>;
}

function humanTrace(step: Record<string, unknown>): Record<string, unknown> {
  const raw = String(step.content ?? "");
  if (step.kind !== "tool_call") return step;
  const tool = String(step.toolName ?? "tool");
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    let content = `${tool} invoked`;
    if (tool === "read" || tool === "write" || tool === "edit") content = `${tool} ${String(input.path ?? "")}`.trim();
    else if (tool === "run" || tool === "run_check" || tool === "bash") {
      const executable = String(input.executable ?? input.command ?? "command");
      const args = Array.isArray(input.args) ? input.args.map(String).join(" ") : "";
      content = `${tool}: ${executable}${args ? ` ${args}` : ""}`;
    } else if (typeof input.markdown === "string") {
      const first = input.markdown.split(/\r?\n/).find((line) => line.trim()) ?? "Markdown action";
      content = `${tool}: ${first.replace(/^#+\s*/, "").slice(0, 240)}`;
    } else if (typeof input.query === "string") content = `${tool}: ${input.query.slice(0, 240)}`;
    return { ...step, content, rawContent: raw };
  } catch { return { ...step, content: `${tool} invoked`, rawContent: raw }; }
}

const TRACE_WINDOW = 600;

function attemptDirectory(projectRoot: string, attemptDir: unknown): string | null {
  if (!attemptDir) return null;
  const root = resolve(projectRoot); const dir = resolve(String(attemptDir)); const rel = relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return dir;
}

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

/**
 * Where a run actually spent its wall clock. A single bar per run says only how
 * long it took; these intervals say whether that time went to reasoning, to a
 * specific tool, to waiting on the provider, or to nothing at all — which is
 * the difference between a run that is working and a run that is stuck.
 *
 * Tool intervals come from call/result pairs. Everything not covered by a tool
 * or a reasoning step is provider time: the model generating or the transport
 * waiting. Gaps at the end of a finished run are attributed the same way.
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

function safeTrace(projectRoot: string, attemptDir: unknown, runEndMs: number): {
  steps: unknown[]; total: number; segments: TraceSegment[]; breakdown: Record<string, number>;
} {
  const empty = { steps: [], total: 0, segments: [], breakdown: traceBreakdown([], runEndMs) };
  const dir = attemptDirectory(projectRoot, attemptDir);
  if (!dir) return empty;
  const path = join(dir, "trace.jsonl");
  if (!existsSync(path)) return empty;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const parsed = lines.flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  const segments = traceSegments(parsed, runEndMs);
  return {
    steps: parsed.slice(-TRACE_WINDOW).map((step) => humanTrace(step)),
    total: parsed.length, segments, breakdown: traceBreakdown(segments, runEndMs),
  };
}

/**
 * The worker's liveness record, kept structured rather than flattened into a
 * fake trace step: the dashboard needs to say how long a silent run has been
 * silent, which a synthetic step cannot express.
 */
function safeHeartbeat(projectRoot: string, attemptDir: unknown): Record<string, unknown> | null {
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

export function buildResearchDashboardState(projectRoot: string, requestedDirection?: string) {
  const store = openResearchStore(projectRoot);
  try {
    const directionId = requestedDirection ?? store.latestDirectionId();
    if (!directionId) return { empty: true };
    const context = store.context(directionId);
    const latestReview = new Map<string, Record<string, unknown>>();
    for (const review of context.synthesisReviews) {
      const id = String(review.synthesis_id); if (!latestReview.has(id)) latestReview.set(id, review);
    }
    const superseded = new Map<string, string>();
    for (const synthesis of context.syntheses) {
      if (latestReview.get(String(synthesis.synthesis_id))?.verdict === "accepted" && synthesis.supersedes_synthesis_id) {
        superseded.set(String(synthesis.supersedes_synthesis_id), String(synthesis.synthesis_id));
      }
    }
    const syntheses = context.syntheses.map((synthesis) => ({
      ...synthesis, review: latestReview.get(String(synthesis.synthesis_id)) ?? null,
      status: superseded.has(String(synthesis.synthesis_id)) ? "superseded"
        : latestReview.get(String(synthesis.synthesis_id))?.verdict ?? "tentative",
      supersededBy: superseded.get(String(synthesis.synthesis_id)) ?? null,
      outcomeIds: context.synthesisOutcomes.filter((item) => item.synthesis_id === synthesis.synthesis_id)
        .map((item) => item.outcome_id),
      sourceIds: context.synthesisSources.filter((item) => item.synthesis_id === synthesis.synthesis_id)
        .map((item) => item.source_id),
      // Every component this synthesis informs, so cross-component understanding
      // shows under each thread rather than only at direction level.
      componentIds: context.synthesisComponents.filter((item) => item.synthesis_id === synthesis.synthesis_id)
        .map((item) => String(item.component_id)),
    }));
    const citedOutcomes = new Set(context.synthesisOutcomes.map((item) => String(item.outcome_id)));
    const citedSources = new Set(context.synthesisSources.map((item) => String(item.source_id)));
    const backoff = store.db.prepare(
      `SELECT next_retry_at,failures FROM watcher_cursors WHERE direction_id=? AND provider='model'
       AND next_retry_at IS NOT NULL ORDER BY next_retry_at DESC LIMIT 1`,
    ).get(directionId) as { next_retry_at: string; failures: number } | undefined;
    const taskById = new Map(context.tasks.map((task) => [task.task_id, task]));
    const lanes = context.runs.map((run) => {
      const task = run.task_id ? taskById.get(String(run.task_id)) : undefined;
      const start = Date.parse(String(run.started_at)); const end = run.completed_at ? Date.parse(String(run.completed_at)) : Date.now();
      const durationMs = Math.max(0, end - start);
      const trace = safeTrace(projectRoot, run.attempt_dir, durationMs);
      const heartbeat = safeHeartbeat(projectRoot, run.attempt_dir);
      // A tool call is only written to the trace once it returns, so an hour
      // inside a long subprocess leaves the timeline blank while the run is very
      // much alive. The heartbeat knows what is executing right now; that
      // in-flight stretch is drawn from it and labelled as such.
      if (run.state === "active" && heartbeat) {
        const covered = trace.segments.reduce((latest, item) => Math.max(latest, item.endMs), 0);
        const operation = heartbeat.operation as Record<string, unknown> | null;
        const label = operation?.name ? `${String(operation.name)} (in flight)` : String(heartbeat.phase ?? "active");
        if (durationMs - covered > 1_000) {
          trace.segments.push({
            kind: heartbeat.phase === "tool_running" ? "tool" : "model",
            label, startMs: covered, endMs: durationMs, isError: false, seq: null, live: true,
          });
          trace.breakdown = traceBreakdown(trace.segments, durationMs);
        }
      }
      // An orchestrator turn has no task of its own, so it used to be visible
      // only at direction level. Attribute it to whichever components it acted
      // on: the tasks whose outcomes it recorded, and the syntheses it wrote.
      const touched = new Set<string>();
      if (task?.component_id) touched.add(String(task.component_id));
      if (run.role === "orchestrator") {
        for (const outcome of context.outcomes) {
          if (outcome.run_id !== run.run_id) continue;
          const owner = taskById.get(String(outcome.task_id));
          if (owner?.component_id) touched.add(String(owner.component_id));
        }
        for (const synthesis of context.syntheses) {
          if (synthesis.run_id !== run.run_id) continue;
          for (const link of context.synthesisComponents) {
            if (link.synthesis_id === synthesis.synthesis_id) touched.add(String(link.component_id));
          }
        }
      }
      return {
        id: run.run_id, role: run.role, state: run.state, taskId: run.task_id,
        componentId: task?.component_id ?? null,
        componentIds: [...touched],
        title: task?.brief_md.split(/\r?\n/)[0]?.replace(/^#+\s*/, "") || String(run.role),
        startedAt: run.started_at, completedAt: run.completed_at,
        startMs: start, endMs: end, durationMs, model: run.model,
        tokens: Number(run.input_tokens ?? 0) + Number(run.output_tokens ?? 0), costUsd: run.cost_usd,
        failure: run.failure, traceTotal: trace.total,
        segments: trace.segments, breakdown: trace.breakdown,
        heartbeat,
        // Only a live tail travels with the poll. Full traces and prompts are
        // megabytes across every run in a direction, and the dashboard refreshes
        // every few seconds; the selected run fetches its own detail.
        trace: run.state === "active" ? trace.steps.slice(-40) : [],
      };
    });
    const tasks = context.tasks.map((task) => ({
      ...task,
      workspace: ["running", "queued", "awaiting_orchestrator"].includes(String(task.state))
        ? workspaceEvidence(task.workspace_path) : null,
    }));
    return {
      empty: false, direction: context.direction, components: context.components,
      componentRelations: context.componentRelations, sources: context.sources,
      tasks, outcomes: context.outcomes, commands: context.commands,
      artifacts: context.artifacts, notes: context.notes, watcherRequests: context.watcherRequests,
      syntheses, synthesisReviews: context.synthesisReviews,
      knowledge: {
        undigestedOutcomeIds: context.outcomes.filter((item) => !citedOutcomes.has(String(item.outcome_id)))
          .map((item) => item.outcome_id),
        uncitedRelevantSourceIds: context.sources.filter((item) => item.state === "relevant" && !citedSources.has(item.source_id))
          .map((item) => item.source_id),
        watcherBackoffUntil: backoff && Date.parse(backoff.next_retry_at) > Date.now() ? backoff.next_retry_at : null,
        watcherBackoffFailures: backoff?.failures ?? 0,
      },
      events: context.events, execution: { lanes },
      environment: (() => {
        // Cache-only: collecting here would run an interpreter probe inside a
        // three-second dashboard poll.
        const facts = cachedPreflight(projectRoot);
        return facts ? renderPreflightMarkdown(facts)
          : "No environment preflight has been collected yet. Run `research preflight --refresh`.";
      })(),
      spend: context.runs.reduce((totals: { inputTokens: number; outputTokens: number; tokens: number; costUsd: number }, run) => ({
        inputTokens: totals.inputTokens + Number(run.input_tokens ?? 0),
        outputTokens: totals.outputTokens + Number(run.output_tokens ?? 0),
        tokens: totals.tokens + Number(run.input_tokens ?? 0) + Number(run.output_tokens ?? 0),
        costUsd: totals.costUsd + Number(run.cost_usd ?? 0),
      }), { inputTokens: 0, outputTokens: 0, tokens: 0, costUsd: 0 }),
      // How long this direction has been worked, and how much of that was a
      // role actually running rather than the pipeline sitting idle.
      timeline: (() => {
        const starts = context.runs.map((run) => Date.parse(String(run.started_at))).filter(Number.isFinite);
        const workedMs = context.runs.reduce((total, run) => total
          + Math.max(0, (run.completed_at ? Date.parse(String(run.completed_at)) : Date.now())
            - Date.parse(String(run.started_at))), 0);
        return { firstRunAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null, workedMs };
      })(),
      continuous: continuousMode(projectRoot),
      budget: (() => {
        try { return { ceilingUsd: researchCostCeiling(projectRoot) }; } catch { return { ceilingUsd: 0 }; }
      })(),
      supervisor: researchSupervisorStatus(projectRoot, directionId),
      watcher: researchWatcherStatus(projectRoot, directionId),
      dashboard: researchDashboardStatus(projectRoot, directionId),
      principles: [
        "Not every study should use the same evaluator.",
        "No global score, incumbent, or baseline advancement.",
        "Benchmarks are scoped evidence, not the scheduling objective.",
        "Negative and bounded findings are completed research.",
      ],
    };
  } finally { store.close(); }
}

export async function serveResearchDashboard(input: { projectRoot: string; directionId?: string; port: number }): Promise<void> {
  const html = readFileSync(join(HERE, "dashboard.html"), "utf8");
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/api/state") {
      try { json(response, 200, buildResearchDashboardState(input.projectRoot, url.searchParams.get("direction") ?? input.directionId)); }
      catch (error) { json(response, 500, { error: String(error) }); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/run") {
      // Full detail for one run, fetched only when its lane is selected.
      const runId = url.searchParams.get("id") ?? "";
      const store = openResearchStore(input.projectRoot);
      try {
        const run = store.db.prepare("SELECT run_id,role,state,input_md,attempt_dir,started_at,completed_at FROM runs WHERE run_id=?")
          .get(runId) as Record<string, unknown> | undefined;
        if (!run) { json(response, 404, { error: "no such run" }); return; }
        const start = Date.parse(String(run.started_at));
        const end = run.completed_at ? Date.parse(String(run.completed_at)) : Date.now();
        const trace = safeTrace(input.projectRoot, run.attempt_dir, Math.max(0, end - start));
        json(response, 200, {
          id: run.run_id, role: run.role, state: run.state,
          trace: trace.steps, traceTotal: trace.total, segments: trace.segments, breakdown: trace.breakdown,
          inputMarkdown: String(run.input_md ?? ""),
        });
      } catch (error) { json(response, 400, { error: String(error) }); }
      finally { store.close(); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workspace-file") {
      // Read-only preview of a live task's own worktree. The path is resolved
      // against that worktree and rejected if it escapes, so the dashboard can
      // never be used to read the wider filesystem.
      const taskId = url.searchParams.get("task") ?? "";
      const requested = url.searchParams.get("path") ?? "";
      const store = openResearchStore(input.projectRoot);
      try {
        const task = store.db.prepare("SELECT workspace_path FROM tasks WHERE task_id=?")
          .get(taskId) as { workspace_path: string | null } | undefined;
        const workspace = task?.workspace_path;
        const full = workspace ? insideWorkspace(workspace, requested) : null;
        if (!full || !existsSync(full) || !statSync(full).isFile()) {
          json(response, 404, { error: "no such file in this task workspace" }); return;
        }
        const bytes = statSync(full).size;
        const text = readFileSync(full).subarray(0, PREVIEW_LIMIT).toString("utf8");
        json(response, 200, { path: requested, bytes, truncated: bytes > PREVIEW_LIMIT, text });
      } catch (error) { json(response, 400, { error: String(error) }); }
      finally { store.close(); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control") {
      // Resuming a paused direction is an operator decision, so it is exposed
      // where the pause is read rather than only on the command line.
      try {
        const body = await requestJson(request);
        const action = String(body.action ?? "");
        const directionId = String(body.direction ?? input.directionId ?? "");
        if (!directionId) { json(response, 400, { error: "no direction" }); return; }
        if (action === "resume") {
          clearRunStops(input.projectRoot);
          const store = openResearchStore(input.projectRoot);
          try {
            store.db.prepare("UPDATE directions SET status='active',updated_at=? WHERE direction_id=?")
              .run(new Date().toISOString(), directionId);
            store.appendEvent(directionId, null, "direction.resumed", "human",
              String(body.reason ?? "Operator resumed the direction from the dashboard."));
          } finally { store.close(); }
          const started = startResearchSupervisor({ projectRoot: input.projectRoot, directionId });
          json(response, 200, { resumed: true, supervisor: started });
          return;
        }
        if (action === "continuous") {
          const on = Boolean(body.enabled);
          mkdirSync(dirname(continuousFile(input.projectRoot)), { recursive: true });
          if (on) writeFileSync(continuousFile(input.projectRoot), "enabled", "utf8");
          else if (existsSync(continuousFile(input.projectRoot))) unlinkSync(continuousFile(input.projectRoot));
          json(response, 200, { continuous: continuousMode(input.projectRoot) });
          return;
        }
        json(response, 400, { error: "action must be resume or continuous" });
      } catch (error) { json(response, 400, { error: String(error) }); }
      return;
    }
    const reviewMatch = request.method === "POST" && url.pathname.match(/^\/api\/syntheses\/([^/]+)\/reviews$/);
    if (reviewMatch) {
      try {
        const body = await requestJson(request);
        const verdict = String(body.verdict ?? "");
        if (!["accepted", "needs_evidence", "rejected"].includes(verdict)) {
          json(response, 400, { error: "invalid synthesis review verdict" }); return;
        }
        const store = openResearchStore(input.projectRoot);
        try {
          const reviewId = store.reviewSynthesis({ synthesisId: decodeURIComponent(reviewMatch[1]!),
            verdict: verdict as "accepted" | "needs_evidence" | "rejected",
            noteMarkdown: String(body.noteMarkdown ?? "") });
          json(response, 201, { reviewId });
        } finally { store.close(); }
      } catch (error) { json(response, 400, { error: String(error) }); }
      return;
    }
    // Markdown and TeX renderers are served from node_modules rather than a CDN:
    // the dashboard has to render identically with no network, which is the
    // situation it will be demonstrated in.
    const VENDOR: Record<string, { file: string; type: string }> = {
      "/vendor/katex.css": { file: "katex/dist/katex.min.css", type: "text/css; charset=utf-8" },
      "/vendor/katex.js": { file: "katex/dist/katex.min.js", type: "text/javascript; charset=utf-8" },
      "/vendor/marked.js": { file: "marked/lib/marked.umd.js", type: "text/javascript; charset=utf-8" },
    };
    const vendor = VENDOR[url.pathname];
    if (request.method === "GET" && vendor) {
      const path = join(input.projectRoot, "node_modules", vendor.file);
      if (!existsSync(path)) { json(response, 404, { error: `missing ${vendor.file}; run npm install` }); return; }
      response.writeHead(200, { "Content-Type": vendor.type, "Cache-Control": "max-age=86400" });
      response.end(readFileSync(path)); return;
    }
    const fontMatch = request.method === "GET" && url.pathname.match(/^\/vendor\/fonts\/([A-Za-z0-9_.-]+)$/);
    if (fontMatch) {
      const path = join(input.projectRoot, "node_modules", "katex", "dist", "fonts", fontMatch[1]!);
      if (!existsSync(path)) { json(response, 404, { error: "unknown font" }); return; }
      const type = fontMatch[1]!.endsWith(".woff2") ? "font/woff2" : fontMatch[1]!.endsWith(".woff") ? "font/woff" : "font/ttf";
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "max-age=604800" });
      response.end(readFileSync(path)); return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(html); return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject); server.listen(input.port, "127.0.0.1", resolveListen);
  });
  console.log(`research dashboard http://127.0.0.1:${input.port}`);
  await new Promise<void>((resolveClose) => {
    const close = () => server.close(() => resolveClose());
    process.once("SIGINT", close); process.once("SIGTERM", close);
  });
}
