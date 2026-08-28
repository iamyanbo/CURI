export type WorkerRole = "architect" | "manager" | "executor" | "setup" | "watcher" | "researcher";

export interface ContextManagementPolicy {
  mode: "auto" | "off";
  contextWindowTokens: number;
  compactAtRatio: number;
  maxModelTurnsPerEpoch: number;
  checkpointMaxOutputTokens: number;
  safetyTokens: number;
  recentTraceSteps: number;
}

export interface ContextCompaction {
  epoch: number;
  atMs: number;
  trigger: "turns" | "tokens";
  inputTokensBefore: number;
  estimatedTokensAfter: number;
  checkpointFile: string;
}

export interface WorkerRequest {
  role: WorkerRole;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  attemptDir: string;
  tools: string[];
  model?: string;
  timeoutMs: number;
  /** Role-specific response cap; prevents a formatting retry from rewriting the entire research state. */
  maxOutputTokens?: number;
  /** When this file appears, abort the model turn and every child tool process. */
  cancelFile?: string;
  campaignId?: string;
  cycleId?: string;
  attemptId?: string;
  memory?: {
    globalDbPath: string;
    stateDbPath: string;
    campaignId: string;
    asOf?: string | null;
  };
  /** Ask the provider for schema-constrained role output. */
  structuredOutput?:
    | "architect-plan" | "manager-proposal" | "memory-enrichment"
    ;
  /**
   * Lean research roles communicate by choosing a named action and attaching
   * unparsed Markdown. The tool name is the action discriminator; the payload
   * is never interpreted as JSON or validated as a scientific schema.
   */
  markdownActions?: Array<{ name: string; description: string }>;
  /** Accept a completed tool-using turn even when the model emits no final prose. */
  allowEmptyResponse?: boolean;
  /** Optional resolved override; environment defaults are recorded by the isolated launcher. */
  contextManagement?: Partial<ContextManagementPolicy>;
}

export interface MarkdownAction {
  name: string;
  markdown: string;
  atMs: number;
}

export interface WorkerCheck {
  executable: string;
  args: string[];
  result: { exitCode: number | null; stdout: string; stderr: string };
}

export interface WorkerUsage {
  inputTokens: number;
  /** Includes reasoning tokens, which the provider bills as output. */
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Reasoning tokens, reported separately by the provider. */
  reasoningTokens?: number;
  /** Model calls made, including every turn of the tool loop. */
  modelRequests?: number;
}

export interface TraceStep {
  seq: number;
  atMs: number;
  kind: "thinking" | "text" | "tool_call" | "tool_result" | "compaction";
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
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
  actions?: MarkdownAction[];
  checks?: WorkerCheck[];
  compactions?: ContextCompaction[];
  latestCheckpoint?: string;
}

export interface AgentWorker {
  run(request: WorkerRequest): Promise<WorkerResult>;
}

/** Extract one JSON object while retaining the old truncated-response diagnosis. */
export function extractJson<T = unknown>(text: string):
  | { ok: true; value: T }
  | { ok: false; error: string } {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  for (const candidate of candidates) {
    const normalized = normalizeUndefinedLiteral(candidate.trim());
    try {
      return { ok: true, value: JSON.parse(normalized) as T };
    } catch {
      // Models sometimes put a code snippet containing raw quotes inside a
      // JSON string. Try a conservative repair before rejecting the response.
      try {
        return { ok: true, value: JSON.parse(repairEmbeddedQuotes(normalized)) as T };
      } catch {
        // When a value contains punctuation that resembles JSON structure,
        // the lexical repair can close it too early. JSON.parse reports the
        // first impossible token precisely, so repair only the quote directly
        // preceding that token and retry with a strict upper bound.
        const recovered = recoverQuotesAtParseErrors<T>(normalized);
        if (recovered.ok) return recovered;
      }
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const char of trimmed) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\" && inString) { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth++;
      if (char === "}") depth--;
    }
    if (depth > 0 || inString) return { ok: false, error: "TRUNCATED_JSON" };
  }
  return { ok: false, error: "MALFORMED_JSON" };
}

function recoverQuotesAtParseErrors<T>(text: string): { ok: true; value: T } | { ok: false } {
  let candidate = text;
  for (let attempt = 0; attempt < 64; attempt++) {
    try { return { ok: true, value: JSON.parse(candidate) as T }; }
    catch (error) {
      const match = String(error).match(/position\s+(\d+)/i);
      if (!match) return { ok: false };
      const position = Number(match[1]);
      if (!Number.isInteger(position) || position <= 0 || position > candidate.length) return { ok: false };
      let quote = position - 1;
      while (quote >= 0 && /\s/.test(candidate[quote]!)) quote--;
      if (candidate[quote] !== '"') return { ok: false };
      let slashes = 0;
      for (let cursor = quote - 1; cursor >= 0 && candidate[cursor] === "\\"; cursor--) slashes++;
      if (slashes % 2 === 1) return { ok: false };
      candidate = `${candidate.slice(0, quote)}\\${candidate.slice(quote)}`;
    }
  }
  return { ok: false };
}

/** Repair only a bare JavaScript `undefined` token, never text inside strings. */
function normalizeUndefinedLiteral(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    if (text.startsWith("undefined", i)
      && !/[A-Za-z0-9_$]/.test(text[i - 1] ?? "")
      && !/[A-Za-z0-9_$]/.test(text[i + 9] ?? "")) {
      out += "null"; i += 8; continue;
    }
    out += char;
  }
  return out;
}

function repairEmbeddedQuotes(text: string): string {
  let out = "";
  let inString = false;
  let stringRole: "key" | "value" = "value";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!inString) {
      out += char;
      if (char === '"') {
        inString = true;
        const previous = out.slice(0, -1).trimEnd().slice(-1);
        stringRole = previous === "{" || previous === "," ? "key" : "value";
      }
      continue;
    }
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      const rest = text.slice(i + 1).trimStart();
      const next = rest[0] ?? "";
      const closes = stringRole === "key"
        ? next === ":"
        : next === "," || next === "}" || next === "]" || next === "";
      if (closes) {
        out += char;
        inString = false;
      } else {
        out += "\\\"";
      }
      continue;
    }
    out += char;
  }
  return out;
}
