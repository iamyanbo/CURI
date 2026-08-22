export type WorkerRole = "manager" | "executor" | "setup";

export interface WorkerRequest {
  role: WorkerRole;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  attemptDir: string;
  tools: string[];
  model?: string;
  timeoutMs: number;
  /** Ask the provider for schema-constrained manager JSON. */
  structuredOutput?: "manager-proposal";
}

export interface WorkerUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface TraceStep {
  seq: number;
  atMs: number;
  kind: "thinking" | "text" | "tool_call" | "tool_result";
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
    try {
      return { ok: true, value: JSON.parse(candidate.trim()) as T };
    } catch {
      // Try the next framing.
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
