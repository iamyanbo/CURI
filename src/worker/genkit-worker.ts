/** Gemini/Genkit worker used by both local and Cloud Run profiles. */

import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

import { genkit, z } from "genkit";
import { googleAI, vertexAI } from "@genkit-ai/google-genai";

import type {
  AgentWorker, TraceStep, WorkerRequest, WorkerResult, WorkerUsage,
} from "./types.js";

const DEFAULT_MODEL = "gemini-3.5-flash";
const MAX_TRACE_STEPS = 400;
const MAX_STEP_CHARS = 4_000;
const MAX_TOOL_OUTPUT = 40_000;
const MAX_FILE_BYTES = 2_000_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".autoresearch-protected"]);
const ALLOWED_EXECUTABLES = new Set([
  "python", "python3", "node", "npm", "git", "nvcc", "cmake", "make",
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
  instruction_to_executor: z.string(),
});

const STANDARD_TOKEN_RATES: Record<string, { input: number; output: number }> = {
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
  if (!ALLOWED_EXECUTABLES.has(command)) {
    throw new Error(`executable is not allowed: ${executable}`);
  }
  if ((command === "python" || command === "python3") && args.some((arg) => arg === "-c" || arg === "-m")) {
    throw new Error("inline Python and module launch are not allowed");
  }
  if (command === "node" && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) {
    throw new Error("inline Node.js execution is not allowed");
  }
  if (command === "npm" && !["test", "run"].includes(args[0] ?? "")) {
    throw new Error("npm is restricted to existing test/run scripts");
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

async function runProcess(root: string, executable: string, args: string[], timeoutMs: number) {
  validateProcess(root, executable, args);
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(executable, args, { cwd: root, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-MAX_TOOL_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_TOOL_OUTPUT); });
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.min(timeoutMs, 120_000));
    child.on("error", (error) => { clearTimeout(timer); done({ exitCode: null, stdout, stderr: String(error) }); });
    child.on("close", (exitCode) => { clearTimeout(timer); done({ exitCode, stdout, stderr }); });
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

async function fetchPublicText(input: string): Promise<string> {
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
  const provider = (process.env.AR_MODEL_PROVIDER ?? "gemini-api").toLowerCase();
  const modelName = request.model?.startsWith("gemini-") ? request.model : DEFAULT_MODEL;
  if (provider === "vertex-ai" || provider === "vertex") {
    const plugin = vertexAI({ location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1" });
    return { ai: genkit({ plugins: [plugin] }), model: vertexAI.model(modelName), provider: "vertex-ai", modelName };
  }
  const plugin = googleAI({ apiKey: process.env.GEMINI_API_KEY });
  return { ai: genkit({ plugins: [plugin] }), model: googleAI.model(modelName), provider: "gemini-api", modelName };
}

function makeTools(
  request: WorkerRequest,
  ai: ReturnType<typeof genkit>,
  trace: (kind: TraceStep["kind"], content: string, extra?: Partial<TraceStep>) => void,
) {
  const wanted = new Set(request.tools);
  const tools: any[] = [];
  let nextCall = 0;
  const wrap = <I, O>(name: string, fn: (input: I) => Promise<O> | O) => async (input: I) => {
    const id = `${name}-${++nextCall}`;
    trace("tool_call", JSON.stringify(input), { toolName: name, toolCallId: id });
    try {
      const output = await fn(input);
      trace("tool_result", truncate(output), { toolName: name, toolCallId: id });
      return output;
    } catch (error) {
      trace("tool_result", String(error), { toolName: name, toolCallId: id, isError: true });
      throw error;
    }
  };
  const add = (name: string, description: string, inputSchema: any, outputSchema: any, fn: any) => {
    if (!wanted.has(name)) return;
    tools.push(ai.dynamicTool({ name, description, inputSchema, outputSchema }, wrap(name, fn)));
  };

  add("read", "Read a UTF-8 file inside the candidate worktree.",
    z.object({ path: z.string(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }),
    z.string(), ({ path, startLine, endLine }: any) => {
      const full = safePath(request.cwd, path);
      if (statSync(full).size > MAX_FILE_BYTES) throw new Error("file exceeds the worker read limit");
      const lines = readFileSync(full, "utf8").split(/\r?\n/);
      return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
    });
  add("write", "Write a UTF-8 file inside the candidate worktree.",
    z.object({ path: z.string(), content: z.string().max(MAX_FILE_BYTES) }), z.string(),
    ({ path, content }: any) => { const full = safePath(request.cwd, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content, "utf8"); return `wrote ${Buffer.byteLength(content)} bytes`; });
  add("edit", "Replace one exact, unique text fragment in a worktree file.",
    z.object({ path: z.string(), oldText: z.string(), newText: z.string() }), z.string(),
    ({ path, oldText, newText }: any) => {
      const full = safePath(request.cwd, path);
      const before = readFileSync(full, "utf8");
      const first = before.indexOf(oldText);
      if (first < 0) throw new Error("oldText was not found");
      if (before.indexOf(oldText, first + oldText.length) >= 0) throw new Error("oldText is not unique");
      writeFileSync(full, `${before.slice(0, first)}${newText}${before.slice(first + oldText.length)}`, "utf8");
      return "edited 1 occurrence";
    });
  add("ls", "List a directory inside the candidate worktree.", z.object({ path: z.string().default(".") }), z.array(z.string()),
    ({ path }: any) => readdirSync(safePath(request.cwd, path)).filter((name) => !SKIP_DIRS.has(name)).slice(0, 500));
  add("find", "List worktree files recursively, optionally filtering by a substring.",
    z.object({ path: z.string().default("."), contains: z.string().optional() }), z.array(z.string()),
    ({ path, contains }: any) => walk(request.cwd, path).filter((file) => !contains || file.includes(contains)).slice(0, 500));
  add("grep", "Search text files in the worktree with a JavaScript regular expression.",
    z.object({ pattern: z.string(), path: z.string().default(".") }), z.array(z.string()),
    ({ pattern, path }: any) => {
      const regex = new RegExp(pattern);
      const matches: string[] = [];
      for (const file of walk(request.cwd, path)) {
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
    });
  add("bash", "Run one approved executable without a shell. Supply argv separately.",
    z.object({ executable: z.string(), args: z.array(z.string()).default([]), timeoutMs: z.number().int().positive().max(120_000).default(60_000) }),
    z.object({ exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string() }),
    ({ executable, args, timeoutMs }: any) => runProcess(request.cwd, executable, args, timeoutMs));
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
  return tools;
}

export class GenkitWorker implements AgentWorker {
  async run(request: WorkerRequest): Promise<WorkerResult> {
    mkdirSync(request.attemptDir, { recursive: true });
    const started = Date.now();
    const trace: TraceStep[] = [];
    const tracePath = join(request.attemptDir, "trace.jsonl");
    writeFileSync(tracePath, "", "utf8");
    const push = (kind: TraceStep["kind"], content: string, extra: Partial<TraceStep> = {}) => {
      if (trace.length >= MAX_TRACE_STEPS) return;
      const value = String(content ?? "");
      const step: TraceStep = { seq: trace.length, atMs: Date.now() - started, kind,
        content: value.length > MAX_STEP_CHARS ? `${value.slice(0, MAX_STEP_CHARS)}…[truncated]` : value, ...extra };
      trace.push(step);
      appendFileSync(tracePath, `${JSON.stringify(step)}\n`, "utf8");
    };

    const { ai, model, provider, modelName } = providerFor(request);
    const tools = makeTools(request, ai, push);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    let finalText = "";
    let failure: string | undefined;
    let stderrTail = "";
    let timedOut = false;
    const usage: WorkerUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

    try {
      const response = await ai.generate({
        model,
        system: request.systemPrompt,
        prompt: request.prompt,
        tools,
        maxTurns: request.role === "manager" ? 8 : 30,
        abortSignal: controller.signal,
        config: {
          maxOutputTokens: request.role === "manager" ? 8_192 : 16_384,
          ...(request.tools.includes("web_search") ? { googleSearchRetrieval: {} } : {}),
        },
        output: request.structuredOutput === "manager-proposal" ? { schema: ManagerProposalSchema } : undefined,
      } as any);
      if (response.reasoning) push("thinking", response.reasoning);
      finalText = request.structuredOutput === "manager-proposal"
        ? JSON.stringify(response.output)
        : response.text;
      if (finalText.trim()) push("text", finalText);
      usage.inputTokens = response.usage.inputTokens ?? 0;
      usage.outputTokens = response.usage.outputTokens ?? 0;
      usage.totalTokens = response.usage.totalTokens ?? usage.inputTokens + usage.outputTokens;

      const grounding = (response.custom as any)?.candidates?.[0]?.groundingMetadata;
      if (grounding) push("tool_result", truncate(grounding), { toolName: "web_search", toolCallId: "grounding-1" });
      const queryCount = Array.isArray(grounding?.webSearchQueries) ? grounding.webSearchQueries.length : 0;
      usage.costUsd = estimateCostUsd(modelName, usage.inputTokens, usage.outputTokens, queryCount);
      if (!finalText.trim() || finalText === "null") failure = "VALIDATION_EMPTY_RESPONSE";
    } catch (error) {
      timedOut = controller.signal.aborted;
      stderrTail = String(error).slice(-4_000);
      failure = timedOut ? "PROCESS_TIMEOUT" : `PROVIDER_ERROR:${stderrTail}`;
    } finally {
      clearTimeout(timeout);
    }

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

    const child = spawn(process.execPath, ["--import", "tsx", childEntry, requestPath, resultPath], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GENKIT_ENV: "prod" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, request.timeoutMs + 5_000);
    const exitCode = await new Promise<number | null>((done) => {
      child.on("error", () => done(null));
      child.on("close", done);
    });
    clearTimeout(timer);

    try {
      return JSON.parse(readFileSync(resultPath, "utf8")) as WorkerResult;
    } catch {
      const failure = timedOut ? "PROCESS_TIMEOUT" : `PROCESS_EXIT_${exitCode}`;
      return {
        ok: false, finalText: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        sessionId: null, model: request.model ?? DEFAULT_MODEL, provider: null, toolCalls: 0,
        durationMs: Date.now() - started, exitCode, timedOut, stderrTail, failure, trace: [],
      };
    }
  }
}

export const defaultWorker: AgentWorker = new IsolatedGenkitWorker();
export const runWorker = (request: WorkerRequest) => defaultWorker.run(request);
