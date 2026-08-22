/**
 * Bounded Pi worker.
 *
 * One process, one prompt, one answer, then exit. There is no `followUp`, no
 * session reuse, and no capability to spawn anything.
 *
 * Isolation is delivered by the --no-* CLI flags, verified on 2026-08-20
 * against Pi 0.76.0: a planted project extension did not execute and a planted
 * AGENTS.md did not load. HOME is NOT redirected — provider credentials live
 * under the user profile, and redirecting it only produces an auth failure that
 * Pi answers by waiting for an interactive login.
 *
 * Output parsing is streaming and bounded: `message_update` deltas are counted
 * and discarded, never accumulated, so a chatty worker cannot exhaust memory.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Resolve Pi to a Node entrypoint so the worker can be spawned with
 * `shell: false`.
 *
 * This matters more than it looks. On Windows `pi` is a `.cmd` shim, and Node
 * refuses to spawn `.cmd` without a shell. Going through cmd.exe re-parses the
 * argument vector, and a multi-line prompt is then split across several
 * invocations: observed as ten `agent_start` events for one call, with the
 * model receiving only a fragment and asking what the campaign was about.
 * Spawning `node dist/cli.js` passes argv through untouched.
 */
let cachedPiEntry: string | null | undefined;
function resolvePiEntry(): string | null {
  if (cachedPiEntry !== undefined) return cachedPiEntry;
  if (process.env.PI_CLI_JS && existsSync(process.env.PI_CLI_JS)) {
    return (cachedPiEntry = process.env.PI_CLI_JS);
  }
  const rel = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const shim of ["pi.cmd", "pi", "pi.exe"]) {
      const shimPath = join(dir, shim);
      if (!existsSync(shimPath)) continue;
      for (const base of [dir, dirname(dir)]) {
        const entry = join(base, rel);
        if (existsSync(entry)) return (cachedPiEntry = entry);
      }
    }
  }
  return (cachedPiEntry = null);
}

export interface WorkerRequest {
  role: "manager" | "executor";
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  attemptDir: string;
  tools: string[];
  /** Extension entry files to load explicitly, bypassing discovery. */
  extensions?: string[];
  model?: string;
  timeoutMs: number;
  /** Reserved for a future sandbox root; HOME is not redirected (see above). */
  isolatedHome: string;
}

export interface WorkerUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * One step of the agent's visible reasoning.
 *
 * Previously every `message_update` was counted and thrown away, which made the
 * worker a black box: the harness recorded that a cycle happened but not what
 * the agent thought, called, or saw. A trajectory view cannot show what was
 * never captured, so the interesting deltas are now kept.
 */
export interface TraceStep {
  seq: number;
  atMs: number;
  kind: "thinking" | "text" | "tool_call" | "tool_result";
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  /** Truncated: a trace is for reading, not for re-execution. */
  content: string;
}

export interface WorkerResult {
  ok: boolean;
  finalText: string;
  usage: WorkerUsage;
  sessionId: string | null;
  model: string | null;
  provider: string | null;
  toolCalls: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
  failure?: string;
  trace: TraceStep[];
}

/** stderr fragments that mean the worker will never make progress. */
const FATAL_STDERR = ["No API key found", "Unknown model", "authentication failed"];

const EMPTY_USAGE: WorkerUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

export async function runPiWorker(req: WorkerRequest): Promise<WorkerResult> {
  mkdirSync(req.attemptDir, { recursive: true });
  mkdirSync(req.isolatedHome, { recursive: true });
  const sessionDir = join(req.attemptDir, "pi-session");

  const args = [
    "--mode", "json",
    "--session-dir", sessionDir,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
  // Extension discovery stays OFF, and the search extensions are loaded by
  // explicit path instead (`-e` still works under `--no-extensions`).
  //
  // Turning discovery on to reach the web tools loaded EVERY installed
  // extension into the worker, and one of them - a Discord remote - threw on
  // startup and hung the run until it timed out with no tools ever called. A
  // research worker must depend on exactly the extensions it names, not on
  // whatever happens to be installed on the machine that day.
  for (const path of req.extensions ?? []) {
    if (existsSync(path)) args.push("-e", path);
  }

  // An empty allowlist means "no tools at all". Say so explicitly: given a read
  // tool and nothing to read, a manager will loop on exploration instead of
  // answering (observed: 35 tool calls across 10 agent cycles before timeout).
  if (req.tools.length > 0) args.push("--tools", req.tools.join(","));
  else args.push("--no-tools");
  if (req.model) args.push("--model", req.model);
  // The prompt goes on stdin, NOT in argv. A context packet grows with the
  // campaign, and on Windows the command line is capped near 32k characters:
  // passing it as an argument killed a run with ENAMETOOLONG at cycle 16.
  // Pi reads stdin as the prompt, which has no such limit.

  const entry = resolvePiEntry();
  const command = entry ? process.execPath : "pi";
  const spawnArgs = entry ? [entry, ...args] : args; // fallback: argv fidelity not guaranteed

  // Persist the exact invocation before spawning: durable intent precedes side effect.
  writeFileSync(
    join(req.attemptDir, "command.json"),
    JSON.stringify(
      { role: req.role, cwd: req.cwd, tools: req.tools, model: req.model ?? null,
        command, args: spawnArgs, viaShell: entry === null,
        promptBytes: Buffer.byteLength(req.prompt, "utf8"), promptVia: "stdin",
        issuedAt: new Date().toISOString() },
      null,
      2,
    ),
    "utf8",
  );

  const started = Date.now();
  const child = spawn(command, spawnArgs, {
    cwd: req.cwd,
    // HOME is deliberately NOT redirected: provider credentials live under the
    // user profile, and isolation comes from the --no-* flags, which the day-1
    // canary spike verified suppress project- and user-level resources alike.
    env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
    shell: entry === null && process.platform === "win32",
    windowsHide: true,
    // stdin carries the prompt and MUST then be closed. Pi blocks forever on a
    // pipe that never reaches EOF (observed earlier as a silent timeout with
    // zero events and zero stderr), so the write is always followed by end().
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin?.on("error", () => { /* the child may exit before the write drains */ });
  child.stdin?.end(req.prompt, "utf8");

  const usage: WorkerUsage = { ...EMPTY_USAGE };
  let finalText = "";
  let sessionId: string | null = null;
  let model: string | null = null;
  let provider: string | null = null;
  let toolCalls = 0;
  let timedOut = false;
  let stderrTail = "";
  let fatalStderr: string | null = null;
  const events: string[] = [];

  const trace: TraceStep[] = [];
  const tracePath = join(req.attemptDir, "trace.jsonl");
  // Keep a provisional trace on disk while the worker is active. The
  // dashboard may read this loose file for live observability, but evidence
  // and claims still use the sealed artifact created by the cycle afterward.
  writeFileSync(tracePath, "", "utf8");
  const MAX_TRACE_STEPS = 400;
  const MAX_STEP_CHARS = 4000;
  const pushStep = (kind: TraceStep["kind"], content: string, extra: Partial<TraceStep> = {}) => {
    if (trace.length >= MAX_TRACE_STEPS) return;
    const text = String(content ?? "");
    const step: TraceStep = {
      seq: trace.length,
      atMs: Date.now() - started,
      kind,
      content: text.length > MAX_STEP_CHARS ? `${text.slice(0, MAX_STEP_CHARS)}…[truncated]` : text,
      ...extra,
    };
    trace.push(step);
    appendFileSync(tracePath, `${JSON.stringify(step)}\n`, "utf8");
  };

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, req.timeoutMs);

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout is ignored, not fatal
      }
      // Streaming deltas are the bulk of the output and are still discarded.
      // Only the completed pieces are kept, so the trace stays bounded while
      // remaining faithful to what the agent actually produced.
      if (ev.type === "message_update") {
        const a = ev.assistantMessageEvent ?? {};
        if (a.type === "thinking_end" && a.content) pushStep("thinking", a.content);
        else if (a.type === "text_end" && a.content?.trim()) pushStep("text", a.content);
        continue;
      }
      events.push(ev.type);

      if (ev.type === "tool_execution_start") {
        pushStep("tool_call", JSON.stringify(ev.args ?? {}), {
          toolName: ev.toolName, toolCallId: ev.toolCallId,
        });
      } else if (ev.type === "tool_execution_end") {
        const parts = ev.result?.content ?? [];
        const text = Array.isArray(parts)
          ? parts.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")
          : String(ev.result ?? "");
        pushStep("tool_result", text, {
          toolName: ev.toolName, toolCallId: ev.toolCallId, isError: Boolean(ev.isError),
        });
      }

      if (ev.type === "session") sessionId = ev.id ?? null;
      if (ev.type === "tool_execution_start" || ev.type === "tool_call") toolCalls++;

      const msg = ev.message ?? null;
      if (msg && msg.role === "assistant") {
        if (msg.model) model = msg.model;
        if (msg.provider) provider = msg.provider;
        if (msg.usage) {
          // Usage on a message is cumulative for that message; take the max seen.
          usage.inputTokens = Math.max(usage.inputTokens, msg.usage.input ?? 0);
          usage.outputTokens = Math.max(usage.outputTokens, msg.usage.output ?? 0);
          usage.totalTokens = Math.max(usage.totalTokens, msg.usage.totalTokens ?? 0);
          usage.costUsd = Math.max(usage.costUsd, msg.usage.cost?.total ?? 0);
        }
      }

      if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
        for (let i = ev.messages.length - 1; i >= 0; i--) {
          const m = ev.messages[i];
          if (m?.role !== "assistant") continue;
          const text = (m.content ?? [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (text) {
            finalText = text;
            break;
          }
        }
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    // Pi waits for interactive login on an auth failure, which would otherwise
    // burn the entire timeout budget. Treat known-fatal stderr as terminal.
    for (const pattern of FATAL_STDERR) {
      if (stderrTail.includes(pattern)) {
        fatalStderr = pattern;
        child.kill("SIGKILL");
        return;
      }
    }
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);

  const result: WorkerResult = {
    // `.trim()` matters: an executor returned two blank lines after reading the
    // code and changing nothing, which passed a bare length check and was
    // recorded as a successful worker that simply made no change.
    ok: !timedOut && !fatalStderr && exitCode === 0 && finalText.trim().length > 0,
    finalText,
    usage,
    sessionId,
    model,
    provider,
    toolCalls,
    durationMs: Date.now() - started,
    exitCode,
    timedOut,
    stderrTail,
    trace,
  };
  if (fatalStderr) result.failure = `PROVIDER_FATAL:${fatalStderr}`;
  else if (timedOut) result.failure = "PROCESS_TIMEOUT";
  else if (exitCode !== 0) result.failure = `PROCESS_EXIT_${exitCode}`;
  else if (!finalText) result.failure = "VALIDATION_EMPTY_RESPONSE";

  // The trajectory is written separately so the completion record stays small
  // and the trace can be sealed as its own artifact.
  writeFileSync(
    tracePath,
    trace.map((t) => JSON.stringify(t)).join("\n"),
    "utf8",
  );
  writeFileSync(
    join(req.attemptDir, "completion.json"),
    JSON.stringify({ ...result, trace: undefined, traceSteps: trace.length,
                     eventTypes: countBy(events) }, null, 2),
    "utf8",
  );
  return result;
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

/**
 * Extract one JSON object from a model's final message. Models wrap JSON in
 * prose or fences no matter how firmly asked not to, so this is deliberately
 * tolerant about framing and strict about the result.
 */
export function extractJson<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c.trim()) as T };
    } catch {
      /* try next framing */
    }
  }
  // Distinguish a truncated reply from a malformed one. A response that opens
  // with `{` but never closes it was cut off by the output limit, not badly
  // formatted, and the retry needs to ask for brevity rather than for JSON.
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const ch of trimmed) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth > 0) {
      return { ok: false, error: `truncated JSON (${depth} unclosed object(s), ${text.length} chars) - the reply was cut off by the output limit` };
    }
  }
  return { ok: false, error: `no parseable JSON object in ${text.length} chars` };
}
