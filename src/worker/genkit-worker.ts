/** Provider-neutral Genkit worker; local defaults to OpenRouter/Ox Alpha. */

import { execFileSync, spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

import { genkit, z } from "genkit";
import { googleAI, vertexAI } from "@genkit-ai/google-genai";
import { compatOaiModelRef, openAICompatible } from "@genkit-ai/compat-oai";

import { environmentFor } from "../config/msvc-env.js";
import { geminiApiKey, vertexApiKey } from "../config/env-file.js";
import { resolveOpenRouterApiKey } from "../config/openrouter-auth.js";
import { DEFAULT_HEARTBEAT_POLICY, ProgressHeartbeat } from "../supervision/progress-heartbeat.js";
import { processStartId } from "../daemon.js";
import { GlobalMemoryStore } from "../memory/store.js";
import { searchCampaignMemory } from "../memory/campaign-memory.js";
import { Store } from "../store/store.js";
import type {
  AgentWorker, MarkdownAction, TraceStep, WorkerCheck, WorkerRequest, WorkerResult, WorkerUsage,
} from "./types.js";

/**
 * A model turn dies when the provider returns tool-call arguments that are not
 * valid JSON. It is the transport's encoding, not ours — scientific payloads are
 * Markdown — so the runtime cannot remove it, only recognise it. Windows paths
 * inside arguments are the usual trigger: one bad backslash escape and the whole
 * streamed turn throws.
 */
export function isMalformedToolCall(detail: string): boolean {
  return /Expected [',}\]"]+.*(?:in JSON|JSON at position)|Unexpected (?:token|end of|non-whitespace).*JSON|is not valid JSON|Unterminated string in JSON/i
    .test(detail);
}

export function providerFailureFromText(detail: string): string | null {
  if (/\b429\b|rate[\s_-]*limit|resource[_\s-]*exhausted|upstream_provider_shared_pool|quota exceeded/i.test(detail)) {
    return `PROVIDER_RATE_LIMITED:${detail.slice(-4_000)}`;
  }
  // Classified apart from a generic provider error: it is recoverable inside the
  // turn and says nothing about provider health, so it must not drive backoff.
  if (isMalformedToolCall(detail)) return `PROVIDER_MALFORMED_TOOL_CALL:${detail.slice(-4_000)}`;
  return null;
}

/**
 * Everything the provider actually told us. An earlier version JSON-stringified
 * `cause`, which returns "{}" for an Error because its properties are not
 * enumerable — so every upstream reason (moderation, upstream 5xx, context
 * overflow, pool exhaustion) was discarded and the record read only "Provider
 * returned error". The chain is walked explicitly instead.
 */
export function providerErrorDetail(error: unknown, depth = 0): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error !== "object") return String(error);
  if (depth > 4) return "[error chain truncated]";
  const row = error as Record<string, unknown>;
  const parts: string[] = [String(error)];
  for (const key of ["name", "code", "status", "statusCode", "type", "param", "requestID", "request_id"]) {
    const value = row[key];
    if (value !== undefined && value !== null && typeof value !== "object") parts.push(`${key}=${String(value)}`);
  }
  // Provider SDKs hang the response body off one of these; it carries the text
  // that actually explains the failure.
  for (const key of ["error", "body", "details", "custom", "response", "data"]) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") { parts.push(`${key}=${value}`); continue; }
    if (value instanceof Error) { parts.push(`${key}: ${providerErrorDetail(value, depth + 1)}`); continue; }
    try { parts.push(`${key}=${JSON.stringify(value)}`); } catch { parts.push(`${key}=${String(value)}`); }
  }
  if (row.cause) parts.push(`cause: ${providerErrorDetail(row.cause, depth + 1)}`);
  if (depth === 0 && typeof row.stack === "string") parts.push(row.stack.split(/\r?\n/).slice(0, 4).join("\n"));
  return parts.filter(Boolean).join("\n").slice(-4_000);
}

const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";
export const DEFAULT_OPENROUTER_MODEL = "stealth/ox-alpha";
/** In-turn restarts allowed when the transport cannot decode a tool call. */
const MAX_MALFORMED_TOOL_CALL_RETRIES = 2;
export const MALFORMED_TOOL_CALL_RETRIES = Number(process.env.AR_MALFORMED_TOOL_CALL_RETRIES ?? MAX_MALFORMED_TOOL_CALL_RETRIES);
/**
 * Recorded trace steps. The previous ceiling of 400 was reached by a single
 * long executor attempt (200 tool calls and their results), after which the
 * trace silently stopped and the run looked idle for an hour while it was
 * working. Truncation is now both far later and explicitly recorded.
 */
const MAX_TRACE_STEPS = Number(process.env.AR_MAX_TRACE_STEPS ?? 20_000);
const MAX_STEP_CHARS = 4_000;
const MAX_TOOL_OUTPUT = 40_000;
const MAX_FILE_BYTES = 2_000_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".autoresearch-protected"]);
/** Executables that drop into an interactive REPL when invoked with no arguments. */
const INTERPRETERS = new Set(["python", "python3", "py", "node"]);

const DENIED_EXECUTABLES = new Set([
  "bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh", "wsl",
]);

const ManagerProposalSchema = z.object({
  hypothesis: z.object({
    title: z.string(),
    lane: z.enum(["control", "exploit", "mechanism", "falsify", "moonshot"]),
    mechanism: z.string(),
    motivation: z.string(),
    falsifier: z.string(),
    change_class: z.string(),
    belief_advisory: z.number().min(0).max(1).optional(),
    steps_allowed: z.number().int().min(1).max(5).optional(),
  }),
  contract: z.object({
    support_delta: z.number().finite(),
    refute_delta: z.number().finite(),
    rationale: z.string(),
  }),
  program_step: z.object({
    milestone: z.number().int().min(1).max(50),
    checkpoint_if_valid: z.boolean(),
  }).optional(),
  instruction_to_executor: z.string(),
});

const ArchitectPlanSchema = z.object({
  program: z.object({
    title: z.string(),
    complexity: z.enum(["simple", "compound", "architectural"]),
    thesis: z.string(),
    novelty: z.string(),
    milestones: z.array(z.string()).min(1).max(8),
    pivot_conditions: z.array(z.string()).min(1).max(8),
    manager_brief: z.string(),
    review_after_experiments: z.number().int().min(1).max(20),
    watch_strategy: z.object({
      core_topics: z.array(z.string()).max(20),
      adjacent_domains: z.array(z.string()).max(20),
      enabling_disciplines: z.array(z.string()).max(20),
      bottlenecks: z.array(z.string()).max(20),
      exclusions: z.array(z.string()).max(20),
    }),
  }),
  signal_decisions: z.array(z.object({
    idea_id: z.string(),
    decision: z.enum(["adopt", "adapt", "combine", "verify", "investigate", "reject"]),
    rationale: z.string(),
  })).default([]),
});

const ScoreSchema = z.object({
  originality: z.number().min(0).max(1), applicability: z.number().min(0).max(1),
  implementationGap: z.number().min(0).max(1), expectedImpact: z.number().min(0).max(1),
  evidenceQuality: z.number().min(0).max(1), transferPotential: z.number().min(0).max(1),
  recency: z.number().min(0).max(1),
});

// The element schemas are exported so the consumer can enforce this contract
// item by item. Only a provider with native structured output validates the
// model's reply here; every other provider returns free text that is merely
// JSON-parsed, and the fields below were then read as if they were guaranteed.
export const SourceAssessmentSchema = z.object({
  sourceVersionId: z.string(), relevant: z.boolean(), confidence: z.number().min(0).max(1),
  contentBasis: z.enum(["full_text", "abstract_only", "metadata_only"]),
  rationale: z.string(),
});

export const MechanismMemorySchema = z.object({
  canonicalName: z.string().min(1), description: z.string(), operation: z.string(),
  bottleneck: z.string(), intervention: z.string(),
  prerequisites: z.array(z.string()), constraints: z.array(z.string()),
  claimedEffects: z.array(z.string()), aliases: z.array(z.string()),
  originDomains: z.array(z.string()), confidence: z.number().min(0).max(1),
  sourceVersionIds: z.array(z.string()).min(1),
});

export const EnrichmentIdeaSchema = z.object({
  mechanismName: z.string().optional(),
  action: z.enum(["adopt", "adapt", "combine", "verify", "investigate"]),
  title: z.string().min(1), targetDomain: z.string(), rationale: z.string(), scores: ScoreSchema,
  codeStatus: z.enum(["absent", "present", "partial", "unknown"]),
  assumptions: z.array(z.string()), smallestExperiment: z.string(),
  macroImplications: z.string(), sourceVersionIds: z.array(z.string()).min(1),
  contradiction: z.boolean().optional(),
});

export const MechanismRelationSchema = z.object({
  fromMechanismName: z.string().min(1), toMechanismName: z.string().min(1),
  relation: z.enum(["requires", "enables", "contradicts", "analogous_to", "implemented_by"]),
  confidence: z.number().min(0).max(1), rationale: z.string(),
});

const MemoryEnrichmentSchema = z.object({
  sourceAssessments: z.array(SourceAssessmentSchema).max(30),
  mechanisms: z.array(MechanismMemorySchema).max(30),
  ideas: z.array(EnrichmentIdeaSchema).max(30),
  relations: z.array(MechanismRelationSchema).max(50).default([]),
});

function outputSchema(kind: WorkerRequest["structuredOutput"]): unknown {
  switch (kind) {
    case "manager-proposal": return ManagerProposalSchema;
    case "architect-plan": return ArchitectPlanSchema;
    case "memory-enrichment": return MemoryEnrichmentSchema;
    default: return undefined;
  }
}

const STANDARD_TOKEN_RATES: Record<string, { input: number; output: number }> = {
  "stealth/ox-alpha": { input: 0, output: 0 },
  "gemini-3.5-flash": { input: 1.50, output: 9.00 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-2.5-flash": { input: 0.30, output: 2.50 },
};

/** Conservative list-price estimate used by the campaign's active cost stop. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, searchQueries = 0): number {
  const listed = STANDARD_TOKEN_RATES[model] ?? { input: 3, output: 20 };
  const inputRate = Number(process.env.AR_INPUT_USD_PER_MILLION ?? listed.input);
  const outputRate = Number(process.env.AR_OUTPUT_USD_PER_MILLION ?? listed.output);
  const searchRate = Number(process.env.AR_SEARCH_USD_PER_QUERY ?? 0.014);
  if (![inputRate, outputRate, searchRate].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("model/search cost overrides must be finite and non-negative");
  }
  return inputTokens * inputRate / 1_000_000 + outputTokens * outputRate / 1_000_000
    + searchQueries * searchRate;
}

export function safePath(root: string, requested: string): string {
  if (isAbsolute(requested)) throw new Error("absolute paths are not allowed");
  const base = resolve(root);
  const target = resolve(base, requested || ".");
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("path escapes the worker root");
  }
  if (rel.split(/[\\/]/).includes(".autoresearch-protected")) {
    throw new Error("protected paths are not available to workers");
  }
  return target;
}

function walk(root: string, start = "."): string[] {
  const base = safePath(root, start);
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(resolve(root), full).replace(/\\/g, "/");
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(rel);
      if (out.length >= 2_000) return;
    }
  };
  if (statSync(base).isDirectory()) visit(base);
  return out;
}

function truncate(value: unknown, limit = MAX_TOOL_OUTPUT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

export function validateProcess(root: string, executable: string, args: string[]): void {
  const command = executable.toLowerCase().replace(/\.exe$/, "");
  if (!/^[a-z0-9._+-]+$/i.test(executable) || DENIED_EXECUTABLES.has(command)) {
    throw new Error(`interactive shells and executable paths are not available: ${executable}`);
  }
  const pythonLauncher = command === "python" || command === "python3" || command === "py" || /^python\d+(?:\.\d+)?$/.test(command);
  if (pythonLauncher && args.some((arg) => arg === "-c" || arg === "-m")) {
    throw new Error("inline Python and module launch are not allowed");
  }
  if (command === "node" && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) {
    throw new Error("inline Node.js execution is not allowed");
  }
  // A bare interpreter opens a REPL and blocks on stdin forever. Stdin is
  // already closed below, but an explicit refusal gives the agent a usable
  // error instead of an empty transcript, and keeps the intent obvious.
  const launcherOnly = command === "py" && args.every((arg) => /^-\d+(?:\.\d+)?$/.test(arg));
  if ((INTERPRETERS.has(command) && args.length === 0) || launcherOnly) {
    throw new Error(`${command} needs a script argument; an interactive REPL is not available`);
  }
  for (const arg of args) {
    if (/[|;&<>`]/.test(arg)) throw new Error("shell metacharacters are not allowed");
    if (arg.split(/[\\/]/).includes("..")) throw new Error("parent path segments are not allowed");
    if (isAbsolute(arg)) {
      const resolved = resolve(arg);
      const base = resolve(root);
      if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
        throw new Error("absolute argument escapes the worker root");
      }
    }
  }
}

/**
 * The rolling silence a child process is allowed before it is presumed wedged.
 * This is deliberately the same bound the heartbeat policy already publishes
 * for `tool_running`: the system now enforces the limit it documents instead
 * of only reporting that it was crossed.
 */
function toolInactivityMs(): number {
  const configured = Number(process.env.AR_TOOL_INACTIVITY_MS ?? DEFAULT_HEARTBEAT_POLICY.activityReviewMs.tool_running ?? 30 * 60_000);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new Error("AR_TOOL_INACTIVITY_MS must be a positive number of milliseconds");
  }
  return configured;
}

/**
 * Kill the child and everything it started. `nvcc` launches the host compiler
 * as a grandchild, so killing only the direct child would leave the real work
 * running and the pipe open.
 */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 30_000, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone, or gone by the time we asked. Either way there is nothing
    // left to stop, and a failed kill must not become the tool's error.
  }
}

/** Exported for tests: the spawn path every agent process call goes through. */
export async function runProcess(
  root: string,
  executable: string,
  args: string[],
  heartbeat?: ProgressHeartbeat,
  inheritBuildEnvironment = false,
  cancelFile?: string,
) {
  validateProcess(root, executable, args);
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((done) => {
    // stdin is closed, never inherited: a child that waits for operator input
    // would hang the cycle indefinitely rather than fail with a diagnosable
    // error. Build tools additionally get a resolved host-compiler environment.
    const child = spawn(executable, args, {
      cwd: root, shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Executor-side Python scripts frequently invoke nvcc themselves. Give
      // the entire executor process tree the resolved toolchain rather than
      // helping only a direct nvcc child and forcing agents to probe for cl.exe.
      env: environmentFor(inheritBuildEnvironment ? "nvcc" : executable),
      // A process group on POSIX so the whole tree can be signalled at once.
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    const operation = {
      kind: "process" as const, name: executable, pid: child.pid,
      processStartId: child.pid ? processStartId(child.pid) : null,
    };
    heartbeat?.activity("tool_running", `${executable} started`, operation);
    let stdout = "";
    let stderr = "";

    // A child that produces nothing and never exits used to stall a whole
    // campaign until an operator noticed. Silence is bounded here, where the
    // evidence is unambiguous — a process with no output and no exit is stuck,
    // unlike a model turn, which may legitimately think for a long time.
    const inactivityMs = toolInactivityMs();
    let silenced = false;
    let timer: NodeJS.Timeout | null = null;
    const cancelPoll = cancelFile ? setInterval(() => {
      if (existsSync(cancelFile) && child.pid) killProcessTree(child.pid);
    }, 200) : null;
    cancelPoll?.unref?.();
    const disarm = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (cancelPoll) clearInterval(cancelPoll);
    };
    const arm = () => {
      disarm();
      timer = setTimeout(() => {
        silenced = true;
        heartbeat?.activity("tool_running", `${executable} produced nothing for ${Math.round(inactivityMs / 1000)}s; terminating`, operation);
        if (child.pid) killProcessTree(child.pid);
      }, inactivityMs);
      // The watchdog must never be the reason the worker stays alive.
      timer.unref?.();
    };
    arm();

    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-MAX_TOOL_OUTPUT);
      arm();
      heartbeat?.progress("tool_running", `${executable} produced stdout`, operation);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_TOOL_OUTPUT);
      arm();
      heartbeat?.progress("tool_running", `${executable} produced stderr`, operation);
    });
    child.on("error", (error) => { disarm(); done({ exitCode: null, stdout, stderr: String(error) }); });
    child.on("close", (exitCode) => {
      disarm();
      // The model has to learn why the command died, or it will simply run the
      // same wedging command again on its next turn.
      const note = silenced
        ? `${stderr}
[terminated by the worker: no output for ${Math.round(inactivityMs / 1000)}s. `
          + "This command does not run unattended here — it may be waiting for input, "
          + "or it needs to produce incremental output.]"
        : stderr;
      heartbeat?.progress("checkpoint", `${executable} exited with code ${exitCode}`, null);
      done({ exitCode, stdout, stderr: note });
    });
  });
}

function privateIp(address: string): boolean {
  const ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
      || (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
  }
  if (isIP(ip) === 6) {
    return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd")
      || /^fe[89ab]/.test(ip) || ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:10.")
      || ip.startsWith("::ffff:169.254.") || ip.startsWith("::ffff:192.168.");
  }
  return true;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (!/^https?:$/.test(url.protocol)) throw new Error("URL is not HTTP(S)");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "metadata.google.internal" || hostname.endsWith(".localhost")) {
    throw new Error("URL host is not public");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => privateIp(address))) {
    throw new Error("URL resolves to a non-public address");
  }
}

export async function fetchPublicText(input: string): Promise<string> {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicUrl(url);
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect response has no location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return truncate(await response.text(), 30_000);
  }
  throw new Error("too many redirects");
}

function providerFor(request: WorkerRequest) {
  const provider = (process.env.AR_MODEL_PROVIDER ?? "openrouter").toLowerCase();
  if (provider === "openrouter") {
    const apiKey = resolveOpenRouterApiKey();
    if (!apiKey) {
      throw new Error("OpenRouter credential missing: set OPENROUTER_API_KEY or sign in to OpenRouter with Pi");
    }
    const modelName = request.model ?? DEFAULT_OPENROUTER_MODEL;
    const plugin = openAICompatible({
      name: "openrouter",
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      // This is deliberately not a research deadline. The progress watchdog
      // reviews quiet work; the transport ceiling only guards an orphaned TCP
      // request and is longer than any normal campaign operation.
      timeout: 2_147_000_000,
      maxRetries: 3,
      defaultHeaders: { "X-OpenRouter-Title": "Adversarial Autoresearch" },
    });
    return {
      ai: genkit({ plugins: [plugin] }),
      model: compatOaiModelRef({ name: modelName, namespace: "openrouter" }),
      provider: "openrouter", modelName, apiKey,
    };
  }
  // A daemon is started without an explicit --model, so the deployment picks
  // its model through configuration rather than through every call site.
  const requested = request.model ?? process.env.AR_MODEL?.trim();
  const modelName = requested?.startsWith("gemini-") ? requested : DEFAULT_GEMINI_MODEL;
  if (provider === "vertex-ai" || provider === "vertex") {
    // Vertex accepts either an express-mode API key or Application Default
    // Credentials. A key takes the express path, which is regionless, so the
    // location is only passed when falling back to ADC.
    const expressKey = vertexApiKey();
    const plugin = expressKey
      ? vertexAI({ apiKey: expressKey })
      : vertexAI({ location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1" });
    return {
      ai: genkit({ plugins: [plugin] }), model: vertexAI.model(modelName),
      provider: expressKey ? "vertex-ai-express" : "vertex-ai", modelName, apiKey: null,
    };
  }
  const plugin = googleAI({ apiKey: geminiApiKey() });
  return { ai: genkit({ plugins: [plugin] }), model: googleAI.model(modelName), provider: "gemini-api", modelName, apiKey: null };
}

async function openRouterSearch(apiKey: string, query: string, maxResults: number): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "Adversarial Autoresearch",
    },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: DEFAULT_OPENROUTER_MODEL,
      messages: [{ role: "user", content: `Search the web for: ${query}\nReturn concise findings with source URLs.` }],
      tools: [{ type: "openrouter:web_search", parameters: { max_results: maxResults, max_total_results: maxResults } }],
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter web search HTTP ${response.status}`);
  const body = await response.json() as any;
  return truncate(body?.choices?.[0]?.message?.content ?? JSON.stringify(body), 30_000);
}

function makeTools(
  request: WorkerRequest,
  ai: ReturnType<typeof genkit>,
  trace: (kind: TraceStep["kind"], content: string, extra?: Partial<TraceStep>) => void,
  heartbeat: ProgressHeartbeat,
  openRouterKey: string | null,
) {
  const wanted = new Set(request.tools);
  const tools: any[] = [];
  let structuredSubmission: unknown;
  const markdownActions: MarkdownAction[] = [];
  const checks: WorkerCheck[] = [];
  let nextCall = 0;
  // A tool that throws must still answer the model. Anything that escaped this
  // wrapper terminated the agent session and aborted a scientific cycle that was
  // otherwise healthy, so the error is shaped to the tool's declared output
  // schema and handed back as an ordinary (failed) tool result instead.
  const errorResult = (name: string, outputSchema: any, error: unknown): unknown => {
    if (name === "bash" || name === "run" || name === "run_check") {
      return { exitCode: null, stdout: "", stderr: String(error) };
    }
    const message = `${name} failed: ${String(error)}`;
    if (outputSchema instanceof z.ZodArray) return [message];
    return message;
  };
  const wrap = <I, O>(name: string, fn: (input: I) => Promise<O> | O, outputSchema?: any) => async (input: I) => {
    const id = `${name}-${++nextCall}`;
    heartbeat.activity("tool_running", `${name} tool call`, { kind: "tool", name });
    trace("tool_call", JSON.stringify(input), { toolName: name, toolCallId: id });
    try {
      const output = await fn(input);
      if (["write", "edit", "bash", "run"].includes(name)) heartbeat.progress("checkpoint", `${name} completed`, null);
      else heartbeat.activity("checkpoint", `${name} completed`, null);
      trace("tool_result", truncate(output), { toolName: name, toolCallId: id });
      return output;
    } catch (error) {
      trace("tool_result", String(error), { toolName: name, toolCallId: id, isError: true });
      heartbeat.activity("checkpoint", `${name} failed`, null);
      // Keep the failure inside the tool turn so the model can choose another
      // command instead of terminating the whole session.
      return errorResult(name, outputSchema, error) as O;
    }
  };
  const add = (name: string, description: string, inputSchema: any, outputSchema: any, fn: any) => {
    if (!wanted.has(name)) return;
    tools.push(ai.dynamicTool({ name, description, inputSchema, outputSchema }, wrap(name, fn, outputSchema)));
  };

  for (const action of request.markdownActions ?? []) {
    add(action.name, action.description,
      z.object({ markdown: z.string() }), z.string(), ({ markdown }: { markdown: string }) => {
        const body = String(markdown ?? "");
        markdownActions.push({ name: action.name, markdown: body, atMs: Date.now() });
        return `${action.name} recorded`;
      });
  }

  add("read", "Read a UTF-8 file inside the candidate worktree.",
    // Models commonly use zero as the first line. Accept it at the provider
    // boundary and normalize it below instead of letting schema validation
    // terminate an otherwise recoverable tool turn.
    z.object({ path: z.string(), startLine: z.number().int().nonnegative().optional(), endLine: z.number().int().nonnegative().optional() }),
    z.string(), ({ path, startLine, endLine }: any) => {
      try {
        const full = safePath(request.cwd, path);
        if (statSync(full).size > MAX_FILE_BYTES) return "read failed: file exceeds the worker read limit";
        const lines = readFileSync(full, "utf8").split(/\r?\n/);
        const first = Math.max(1, Number(startLine ?? 1));
        const last = Math.max(first, Number(endLine ?? lines.length));
        return lines.slice(first - 1, last).join("\n");
      } catch (error) { return `read failed: ${String(error)}`; }
    });
  add("write", "Write a UTF-8 file inside the candidate worktree.",
    z.object({ path: z.string(), content: z.string().max(MAX_FILE_BYTES) }), z.string(),
    ({ path, content }: any) => {
      try { const full = safePath(request.cwd, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content, "utf8"); return `wrote ${Buffer.byteLength(content)} bytes`; }
      catch (error) { return `write failed: ${String(error)}`; }
    });
  add("edit", "Replace one exact, unique text fragment in a worktree file.",
    z.object({ path: z.string(), oldText: z.string(), newText: z.string() }), z.string(),
    ({ path, oldText, newText }: any) => {
      let full: string;
      let rawBefore: string;
      try {
        full = safePath(request.cwd, path);
        rawBefore = readFileSync(full, "utf8");
      } catch (error) { return `edit failed: ${String(error)}`; }
      // `read` presents normalized LF text, while Windows Git worktrees may
      // contain CRLF. Compare normalized text and preserve the file's style.
      const normalise = (value: string) => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const before = normalise(rawBefore);
      const old = normalise(oldText);
      const replacement = normalise(newText);
      const first = before.indexOf(old);
      if (first < 0) return "edit failed: oldText was not found; reread the file and retry with an exact fragment";
      if (before.indexOf(old, first + old.length) >= 0) return "edit failed: oldText is not unique; use a larger exact fragment";
      const updated = `${before.slice(0, first)}${replacement}${before.slice(first + old.length)}`;
      const eol = rawBefore.includes("\r\n") ? "\r\n" : "\n";
      writeFileSync(full, eol === "\r\n" ? updated.replace(/\n/g, "\r\n") : updated, "utf8");
      return "edited 1 occurrence";
    });
  add("ls", "List a directory inside the candidate worktree.", z.object({ path: z.string().default(".") }), z.array(z.string()),
    ({ path }: any) => {
      try { return readdirSync(safePath(request.cwd, path ?? ".")).filter((name) => !SKIP_DIRS.has(name)).slice(0, 500); }
      catch (error) { return [`ls failed: ${String(error)}`]; }
    });
  add("find", "List worktree files recursively, optionally filtering by a substring.",
    z.object({ path: z.string().default("."), contains: z.string().optional() }), z.array(z.string()),
    ({ path, contains }: any) => {
      try { return walk(request.cwd, path ?? ".").filter((file) => !contains || file.includes(contains)).slice(0, 500); }
      catch (error) { return [`find failed: ${String(error)}`]; }
    });
  add("grep", "Search text files in the worktree with a JavaScript regular expression.",
    z.object({ pattern: z.string(), path: z.string().default(".") }), z.array(z.string()),
    ({ pattern, path }: any) => {
      try {
        const regex = new RegExp(pattern);
        const matches: string[] = [];
        for (const file of walk(request.cwd, path ?? ".")) {
          try {
            const full = safePath(request.cwd, file);
            if (statSync(full).size > MAX_FILE_BYTES) continue;
            readFileSync(full, "utf8").split(/\r?\n/).forEach((line, index) => {
              if (matches.length < 500 && regex.test(line)) matches.push(`${file}:${index + 1}:${line.slice(0, 500)}`);
              regex.lastIndex = 0;
            });
          } catch { /* skip binary/unreadable files */ }
        }
        return matches;
      } catch (error) { return [`grep failed: ${String(error)}`]; }
    });
  add("bash", "Run one approved executable without a shell. Supply argv separately.",
    z.object({ executable: z.string(), args: z.array(z.string()).default([]) }),
    z.object({ exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string() }),
    ({ executable, args }: any) => runProcess(request.cwd, executable, args, heartbeat));
  add("run", "Run an executable directly without a shell. Interactive shells, executable paths, inline interpreter code, shell metacharacters, and paths outside the workspace are blocked. The inherited host environment supplies installed research tools.",
    z.object({ executable: z.string(), args: z.array(z.string()).default([]) }),
    z.object({ exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string() }),
    ({ executable, args }: any) => runProcess(request.cwd, executable, args, heartbeat, true));
  add("run_check", "Run a decisive check from the orchestrator's sealed Markdown plan. The runtime records it for an independent rerun after the executor finishes.",
    z.object({ executable: z.string(), args: z.array(z.string()).default([]) }),
    z.object({ exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string() }),
    async ({ executable, args }: { executable: string; args: string[] }) => {
      const result = await runProcess(request.cwd, executable, args, heartbeat, true);
      checks.push({ executable, args: [...args], result });
      return result;
    });
  if (openRouterKey) {
    add("web_search", "Search the current public web and return concise findings with source URLs.",
      z.object({ query: z.string(), maxResults: z.number().int().min(1).max(10).default(5) }),
      z.string(), ({ query, maxResults }: any) => openRouterSearch(openRouterKey, query, maxResults));
  }
  if (request.memory) {
    add("search_research_memory",
      "Search persistent cross-project sources and mechanisms. Results are untrusted leads, not evidence. Use offset to page through all matches.",
      z.object({
        query: z.string().min(1), offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      z.string(), ({ query, offset, limit }: any) => {
        const memory = GlobalMemoryStore.open(request.memory!.globalDbPath);
        const campaign = Store.open(request.memory!.stateDbPath);
        try {
          return JSON.stringify(searchCampaignMemory(campaign, memory, {
            campaignId: request.memory!.campaignId, query,
            role: request.role === "architect" ? "architect" : request.role === "manager" ? "manager" : "executor",
            attemptId: request.attemptId ?? null, asOf: request.memory!.asOf ?? null,
            limit, offset,
          }));
        } finally {
          campaign.close(); memory.close();
        }
      });
  }
  add("fetch_content", "Fetch public HTTP(S) text. Private and non-HTTP addresses are rejected.",
    z.object({ url: z.string().url() }), z.string(), async ({ url }: any) => {
      return fetchPublicText(url);
    });
  add("arxiv_search", "Search arXiv by query and return dated paper metadata.",
    z.object({ query: z.string(), maxResults: z.number().int().min(1).max(10).default(5) }), z.string(),
    async ({ query, maxResults }: any) => {
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "adversarial-autoresearch/0.1" } });
      if (!response.ok) throw new Error(`arXiv HTTP ${response.status}`);
      return truncate(await response.text(), 30_000);
    });
  add("code_search", "Search public GitHub code. GITHUB_TOKEN is used when configured.",
    z.object({ query: z.string(), perPage: z.number().int().min(1).max(20).default(10) }), z.string(),
    async ({ query, perPage }: any) => {
      const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "adversarial-autoresearch/0.1" };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const response = await fetch(`https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      return truncate(await response.text(), 30_000);
    });
  return {
    tools,
    structuredSubmission: () => structuredSubmission,
    markdownActions: () => markdownActions.map((item) => ({ ...item })),
    checks: () => checks.map((item) => ({ ...item, args: [...item.args], result: { ...item.result } })),
  };
}

export class GenkitWorker implements AgentWorker {
  async run(request: WorkerRequest): Promise<WorkerResult> {
    mkdirSync(request.attemptDir, { recursive: true });
    const heartbeat = new ProgressHeartbeat(join(request.attemptDir, "heartbeat.json"), {
      campaignId: request.campaignId, cycleId: request.cycleId, attemptId: request.attemptId,
      processStartId: processStartId(process.pid),
    });
    const started = Date.now();
    const trace: TraceStep[] = [];
    const tracePath = join(request.attemptDir, "trace.jsonl");
    writeFileSync(tracePath, "", "utf8");
    let traceTruncated = false;
    const push = (kind: TraceStep["kind"], content: string, extra: Partial<TraceStep> = {}) => {
      if (trace.length >= MAX_TRACE_STEPS) {
        if (!traceTruncated) {
          traceTruncated = true;
          appendFileSync(tracePath, `${JSON.stringify({ seq: trace.length, atMs: Date.now() - started,
            kind: "text", content: `[trace truncated at ${MAX_TRACE_STEPS} steps; the run continues]` })}
`, "utf8");
        }
        return;
      }
      const value = String(content ?? "");
      const step: TraceStep = { seq: trace.length, atMs: Date.now() - started, kind,
        content: value.length > MAX_STEP_CHARS ? `${value.slice(0, MAX_STEP_CHARS)}…[truncated]` : value, ...extra };
      trace.push(step);
      appendFileSync(tracePath, `${JSON.stringify(step)}\n`, "utf8");
    };

    const { ai, model, provider, modelName, apiKey } = providerFor(request);
    const toolState = makeTools(request, ai, push, heartbeat, apiKey);
    const tools = toolState.tools;
    const controller = new AbortController();
    const timeout = request.timeoutMs > 0 ? setTimeout(() => controller.abort(), request.timeoutMs) : null;
    let stopRequested = false;
    const cancelPoll = request.cancelFile
      ? setInterval(() => {
          if (request.cancelFile && existsSync(request.cancelFile)) {
            stopRequested = true;
            controller.abort();
          }
        }, 200)
      : null;
    cancelPoll?.unref?.();
    // Genkit re-sends the whole conversation on every tool turn, and
    // `response.usage` describes only the final call. Recording that one number
    // undercounted a 28-tool-call executor turn roughly twentyfold. A model
    // middleware sees every call in the loop, so usage is summed there instead.
    const billed = { requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    const meterUsage = async (modelRequest: unknown, next: (request: unknown) => Promise<unknown>) => {
      const modelResponse = await next(modelRequest);
      const turn = (modelResponse as { usage?: Record<string, unknown> } | undefined)?.usage ?? {};
      billed.requests++;
      billed.inputTokens += Number(turn.inputTokens ?? 0);
      billed.outputTokens += Number(turn.outputTokens ?? 0);
      // Reasoning tokens are billed as output but arrive in their own field, so
      // ignoring them undercounted output by a further order of magnitude.
      billed.reasoningTokens += Number(turn.thoughtsTokens ?? 0);
      billed.totalTokens += Number(turn.totalTokens ?? 0);
      // Reasoning arrives per model turn, not once at the end, so it is recorded
      // here rather than from the final response.
      try {
        const response = modelResponse as Record<string, any>;
        const parts: Array<Record<string, any>> = response?.message?.content
          ?? response?.candidates?.[0]?.message?.content ?? [];
        const reasoned = parts.filter((part) => typeof part?.reasoning === "string" && part.reasoning.trim());
        for (const part of reasoned) push("thinking", String(part.reasoning));
        const thoughts = Number(turn.thoughtsTokens ?? 0);
        if (thoughts > 0 && reasoned.length === 0) {
          // The provider charged for reasoning but withheld the text. Record that
          // rather than leaving an unexplained gap in the timeline.
          push("thinking", `[${thoughts} reasoning tokens; the provider did not return the thought text]`);
        }
      } catch { /* reasoning capture must never break a turn */ }
      return modelResponse;
    };

    let finalText = "";
    let failure: string | undefined;
    let stderrTail = "";
    let timedOut = false;
    const usage: WorkerUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

    try {
      heartbeat.activity("model_wait", `waiting for ${provider}/${modelName}`, { kind: "model", name: modelName });
      // OpenRouter/Ox Alpha does not reliably honour Genkit's structured-output
      // adapter: malformed JSON is parsed inside Genkit (JSON5) before the
      // worker can record the response or apply the campaign's retry policy.
      // Ask it for plain text and let the caller's extractJson + domain
      // validation own the trust boundary. Other providers keep native schema
      // constrained generation.
      const nativeStructuredOutput = Boolean(request.structuredOutput && provider !== "openrouter");
      const streamOnce = async (prompt: string) => {
        const generation = ai.generateStream({
          model,
          system: request.systemPrompt,
          prompt,
          tools,
          // Genkit defaults to five tool turns when omitted. Use a practically
          // unbounded value; liveness is governed by positive progress evidence.
          maxTurns: Number.MAX_SAFE_INTEGER,
          abortSignal: controller.signal,
          config: {
            maxOutputTokens: request.maxOutputTokens ?? (request.role === "manager" ? 16_384 : 65_536),
            ...(provider !== "openrouter" && request.tools.includes("web_search") ? { googleSearchRetrieval: {} } : {}),
            // Reasoning is withheld unless it is asked for. Without this the
            // provider bills thought tokens and returns no thought text, which is
            // why the trace showed tool calls but never any reasoning.
            ...(provider === "openrouter" ? {} : { thinkingConfig: { includeThoughts: true } }),
          },
          output: nativeStructuredOutput ? { schema: outputSchema(request.structuredOutput) } : undefined,
          use: [meterUsage],
        } as any);
        for await (const chunk of generation.stream) {
          const text = String(chunk.text ?? "");
          heartbeat.activity("model_stream", text ? "model stream advanced" : "model stream event", { kind: "model", name: modelName });
        }
        return await generation.response;
      };
      // A tool call the transport could not decode kills the streamed turn, and
      // used to discard the whole attempt with it — in one case 36 minutes and
      // 58 completed tool calls. The work those calls did is already on disk, so
      // the turn is restarted in place with the offending pattern named, instead
      // of the attempt being thrown away.
      let response: Awaited<ReturnType<typeof streamOnce>> | undefined;
      let prompt = request.prompt;
      for (let attempt = 0; attempt <= MALFORMED_TOOL_CALL_RETRIES; attempt++) {
        try { response = await streamOnce(prompt); break; }
        catch (error) {
          const detail = providerErrorDetail(error);
          const recoverable = isMalformedToolCall(detail) && !controller.signal.aborted
            && attempt < MALFORMED_TOOL_CALL_RETRIES;
          if (!recoverable) throw error;
          push("tool_result", `Transport could not decode a tool call and the turn was restarted: ${truncate(detail, 400)}`,
            { isError: true, toolName: "transport" });
          heartbeat.activity("model_wait", "restarting turn after an undecodable tool call", { kind: "model", name: modelName });
          prompt = `${request.prompt}\n\n## Interrupted turn\nA previous turn ended because a tool call could not be decoded`
            + " by the transport, which encodes tool arguments as JSON. Any work already completed is still present in the"
            + " workspace, so re-read it before repeating anything. Avoid putting literal Windows paths or backslash escapes"
            + " inside tool arguments: use forward slashes and workspace-relative paths, and if a value genuinely needs"
            + " backslashes, write it from a script file rather than embedding it in a tool argument.";
        }
      }
      if (!response) throw new Error("model turn produced no response");
      if (response.reasoning) push("thinking", response.reasoning);
      const submitted = toolState.structuredSubmission();
      finalText = submitted !== undefined
        ? JSON.stringify(submitted)
        : nativeStructuredOutput
          ? JSON.stringify(response.output)
          : response.text;
      if (finalText.trim()) push("text", finalText);
      const grounding = (response.custom as any)?.candidates?.[0]?.groundingMetadata;
      if (grounding) push("tool_result", truncate(grounding), { toolName: "web_search", toolCallId: "grounding-1" });
      if ((!finalText.trim() || finalText === "null") && !request.allowEmptyResponse) {
        failure = "VALIDATION_EMPTY_RESPONSE";
      }
      if (!failure) heartbeat.complete();
    } catch (error) {
      timedOut = controller.signal.aborted;
      stderrTail = providerErrorDetail(error);
      failure = stopRequested
        ? "STOP_REQUESTED"
        : timedOut
        ? "PROCESS_TIMEOUT"
        : providerFailureFromText(stderrTail) ?? `PROVIDER_ERROR:${stderrTail}`;
      heartbeat.fail(failure);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
    }

    // Settled here rather than in the success path: a turn that failed still
    // consumed every request it made, and those used to be recorded as zero.
    if (billed.requests > 0) {
      usage.inputTokens = billed.inputTokens;
      usage.outputTokens = billed.outputTokens + billed.reasoningTokens;
      usage.totalTokens = billed.totalTokens || usage.inputTokens + usage.outputTokens;
      usage.reasoningTokens = billed.reasoningTokens;
      usage.modelRequests = billed.requests;
    }
    const localSearches = trace.filter((step) => step.kind === "tool_call" && step.toolName === "web_search").length;
    usage.costUsd = estimateCostUsd(modelName, usage.inputTokens, usage.outputTokens, localSearches);

    const result: WorkerResult = {
      ok: !failure,
      finalText,
      usage,
      sessionId: null,
      model: modelName,
      provider,
      toolCalls: trace.filter((step) => step.kind === "tool_call").length,
      durationMs: Date.now() - started,
      exitCode: failure ? 1 : 0,
      timedOut,
      stderrTail,
      trace,
      actions: toolState.markdownActions(),
      checks: toolState.checks(),
      ...(failure ? { failure } : {}),
    };
    writeFileSync(join(request.attemptDir, "completion.json"), JSON.stringify({ ...result, trace: undefined, traceSteps: trace.length }, null, 2), "utf8");
    return result;
  }
}

/**
 * Local production boundary: the model and its tools live in a fresh process.
 * Cloud mode replaces this launcher with a Cloud Run task using the same request/result protocol.
 */
class IsolatedGenkitWorker implements AgentWorker {
  async run(request: WorkerRequest): Promise<WorkerResult> {
    mkdirSync(request.attemptDir, { recursive: true });
    const requestPath = join(request.attemptDir, "worker-request.json");
    const resultPath = join(request.attemptDir, "worker-result.json");
    writeFileSync(requestPath, JSON.stringify(request), "utf8");
    const childEntry = fileURLToPath(new URL("./genkit-child.ts", import.meta.url));
    const started = Date.now();
    let stderrTail = "";
    let timedOut = false;
    let stopRequested = false;

    const child = spawn(process.execPath, ["--import", "tsx", childEntry, requestPath, resultPath], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GENKIT_ENV: "prod" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4_000); });
    const timer = request.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; if (child.pid) killProcessTree(child.pid); }, request.timeoutMs + 5_000)
      : null;
    const cancelPoll = request.cancelFile
      ? setInterval(() => {
          if (request.cancelFile && existsSync(request.cancelFile)) {
            stopRequested = true;
            if (child.pid) killProcessTree(child.pid);
          }
        }, 200)
      : null;
    cancelPoll?.unref?.();
    const exitCode = await new Promise<number | null>((done) => {
      child.on("error", () => done(null));
      child.on("close", done);
    });
    if (timer) clearTimeout(timer);
    if (cancelPoll) clearInterval(cancelPoll);

    try {
      return JSON.parse(readFileSync(resultPath, "utf8")) as WorkerResult;
    } catch {
      const failure = stopRequested ? "STOP_REQUESTED" : timedOut ? "PROCESS_TIMEOUT"
        : providerFailureFromText(stderrTail) ?? `PROCESS_EXIT_${exitCode}`;
      return {
        ok: false, finalText: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        sessionId: null, model: request.model ?? DEFAULT_OPENROUTER_MODEL, provider: null, toolCalls: 0,
        durationMs: Date.now() - started, exitCode, timedOut, stderrTail, failure, trace: [],
      };
    }
  }
}

export const defaultWorker: AgentWorker = new IsolatedGenkitWorker();
export const runWorker = (request: WorkerRequest) => defaultWorker.run(request);
