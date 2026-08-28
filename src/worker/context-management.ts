import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ContextCompaction, ContextManagementPolicy, TraceStep } from "./types.js";

const DEFAULT_WINDOW_TOKENS = 128_000;
const DEFAULT_COMPACT_RATIO = 0.60;
const DEFAULT_MAX_TURNS = 24;
const DEFAULT_CHECKPOINT_TOKENS = 8_192;
const DEFAULT_SAFETY_TOKENS = 8_192;
const DEFAULT_RECENT_STEPS = 8;

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveContextManagementPolicy(
  override: Partial<ContextManagementPolicy> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ContextManagementPolicy {
  const configuredMode = (env.AR_CONTEXT_COMPACTION ?? "auto").trim().toLowerCase();
  if (!override?.mode && !["auto", "off"].includes(configuredMode))
    throw new Error("AR_CONTEXT_COMPACTION must be auto or off");
  const mode = override?.mode ?? (configuredMode === "off" ? "off" : "auto");
  const policy: ContextManagementPolicy = {
    mode,
    contextWindowTokens: Math.floor(override?.contextWindowTokens
      ?? finiteNumber(env.AR_CONTEXT_WINDOW_TOKENS, DEFAULT_WINDOW_TOKENS)),
    compactAtRatio: override?.compactAtRatio
      ?? finiteNumber(env.AR_CONTEXT_COMPACT_RATIO, DEFAULT_COMPACT_RATIO),
    maxModelTurnsPerEpoch: Math.floor(override?.maxModelTurnsPerEpoch
      ?? finiteNumber(env.AR_CONTEXT_MAX_TURNS, DEFAULT_MAX_TURNS)),
    checkpointMaxOutputTokens: Math.floor(override?.checkpointMaxOutputTokens
      ?? finiteNumber(env.AR_CONTEXT_CHECKPOINT_TOKENS, DEFAULT_CHECKPOINT_TOKENS)),
    safetyTokens: Math.floor(override?.safetyTokens
      ?? finiteNumber(env.AR_CONTEXT_SAFETY_TOKENS, DEFAULT_SAFETY_TOKENS)),
    recentTraceSteps: Math.floor(override?.recentTraceSteps
      ?? finiteNumber(env.AR_CONTEXT_RECENT_STEPS, DEFAULT_RECENT_STEPS)),
  };
  if (!Number.isInteger(policy.contextWindowTokens) || policy.contextWindowTokens < 16_384)
    throw new Error("AR_CONTEXT_WINDOW_TOKENS must be an integer >= 16384");
  if (!(policy.compactAtRatio >= 0.25 && policy.compactAtRatio <= 0.90))
    throw new Error("AR_CONTEXT_COMPACT_RATIO must be between 0.25 and 0.90");
  if (!Number.isInteger(policy.maxModelTurnsPerEpoch) || policy.maxModelTurnsPerEpoch < 2)
    throw new Error("AR_CONTEXT_MAX_TURNS must be an integer >= 2");
  if (!Number.isInteger(policy.checkpointMaxOutputTokens) || policy.checkpointMaxOutputTokens < 512)
    throw new Error("AR_CONTEXT_CHECKPOINT_TOKENS must be an integer >= 512");
  if (!Number.isInteger(policy.safetyTokens) || policy.safetyTokens < 1_024)
    throw new Error("AR_CONTEXT_SAFETY_TOKENS must be an integer >= 1024");
  if (!Number.isInteger(policy.recentTraceSteps) || policy.recentTraceSteps < 0)
    throw new Error("AR_CONTEXT_RECENT_STEPS must be a non-negative integer");
  return policy;
}

/** Conservative for prose, JSON tool traffic, source code and mixed Unicode. */
export function estimateContextTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(serialized.length / 3);
}

export function contextTrigger(input: {
  policy: ContextManagementPolicy;
  epochTurns: number;
  messages: unknown;
  lastInputTokens: number;
  lastOutputTokens: number;
}): { trigger: "turns" | "tokens"; projectedTokens: number } | null {
  if (input.policy.mode === "off") return null;
  const projectedTokens = Math.max(
    estimateContextTokens(input.messages),
    Math.max(0, input.lastInputTokens) + Math.max(0, input.lastOutputTokens),
  );
  if (projectedTokens >= Math.floor(input.policy.contextWindowTokens * input.policy.compactAtRatio))
    return { trigger: "tokens", projectedTokens };
  if (input.epochTurns >= input.policy.maxModelTurnsPerEpoch)
    return { trigger: "turns", projectedTokens };
  return null;
}

export function baseContextFits(policy: ContextManagementPolicy, value: unknown, maxOutputTokens: number): boolean {
  if (policy.mode === "off") return true;
  return estimateContextTokens(value) + maxOutputTokens + policy.safetyTokens < policy.contextWindowTokens;
}

export function validCheckpoint(text: string, finishReason?: string | null): boolean {
  const body = String(text ?? "").trim();
  if (body.length < 500 || body.length > 50_000) return false;
  return !/length|blocked|safety|error/i.test(String(finishReason ?? ""));
}

export function checkpointInstruction(epoch: number, shorter = false): string {
  return [
    `# Context checkpoint for epoch ${epoch}`,
    "Write a faithful working-memory checkpoint for another instance of yourself that will continue this exact task.",
    "Use ordinary Markdown, not JSON. Do not call tools and do not give a polished final answer.",
    "Preserve the objective and constraints, completed work, exact measured values, commands/checks, artifact and file paths,",
    "failed or rejected approaches and why, unexpected observations, unresolved questions, and the immediate next action.",
    "Distinguish measured evidence from inference. Never round, improve, or invent a result. Name the files or tool events",
    "where exact details can be recovered. Keep surprising information even when it does not fit the current hypothesis.",
    shorter ? "The previous checkpoint attempt was unusable. Produce a complete but shorter memo under 4,000 words." : "",
  ].filter(Boolean).join("\n");
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

export function archiveContextEpoch(input: {
  attemptDir: string;
  epoch: number;
  messages: unknown;
  checkpoint: string;
  record: ContextCompaction;
}): void {
  const root = join(input.attemptDir, "context-epochs");
  mkdirSync(root, { recursive: true });
  const stem = `epoch-${String(input.epoch).padStart(4, "0")}`;
  atomicWrite(join(root, `${stem}.messages.json`), JSON.stringify(input.messages, null, 2));
  atomicWrite(join(root, `${stem}.checkpoint.md`), input.checkpoint);
  atomicWrite(join(root, `${stem}.meta.json`), JSON.stringify(input.record, null, 2));
}

export function continuationPrompt(input: {
  originalPrompt: string;
  checkpoint: string;
  epoch: number;
  trace: TraceStep[];
  actions: Array<{ name: string; markdown: string }>;
  checks: Array<{ executable: string; args: string[]; result: { exitCode: number | null } }>;
  recentSteps: number;
}): string {
  const recent = input.trace.filter((step) => step.kind === "tool_call" || step.kind === "tool_result")
    .slice(-input.recentSteps).map((step) =>
      `- ${step.kind} ${step.toolName ?? ""}: ${String(step.content).slice(0, 1_000)}`).join("\n");
  const actions = input.actions.map((item) => `- ${item.name}: ${item.markdown.split(/\r?\n/)[0]!.slice(0, 300)}`).join("\n");
  const checks = input.checks.map((item) =>
    `- ${item.executable} ${item.args.join(" ")} -> exit ${String(item.result.exitCode)}`).join("\n");
  return [
    "# Continue a compacted CURI worker turn",
    `The controller archived epoch ${input.epoch}. Continue the same task; do not restart or repeat completed discovery.`,
    "The complete earlier conversation remains locally searchable with `search_attempt_history`.",
    `## Original task\n${input.originalPrompt}`,
    `## Working-memory checkpoint\n${input.checkpoint}`,
    `## Controller evidence ledger\n### Recorded actions\n${actions || "- none"}`,
    `### Recorded checks\n${checks || "- none"}`,
    `### Most recent tool events\n${recent || "- none"}`,
    "When an exact number, command, error, or earlier decision matters, retrieve it instead of guessing from this memo.",
  ].join("\n\n");
}

function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === "string") { out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) stringsIn(item, out); return; }
  if (value && typeof value === "object") for (const item of Object.values(value)) stringsIn(item, out);
}

/** Literal local retrieval over archived epochs; it never calls a model or network. */
export function searchAttemptHistory(attemptDir: string, query: string, limit = 12): string {
  const root = join(attemptDir, "context-epochs");
  if (!existsSync(root)) return "No compacted attempt history exists yet.";
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length >= 2);
  if (terms.length === 0) return "Provide at least one searchable term.";
  const hits: Array<{ score: number; source: string; text: string }> = [];
  for (const file of readdirSync(root).filter((name) => name.endsWith(".messages.json") || name.endsWith(".checkpoint.md"))) {
    const path = join(root, file);
    const values: string[] = [];
    try {
      const raw = readFileSync(path, "utf8");
      if (file.endsWith(".json")) stringsIn(JSON.parse(raw), values); else values.push(raw);
    } catch { continue; }
    for (const value of values) {
      const lower = value.toLowerCase();
      const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
      if (score === 0) continue;
      const indexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
      const at = Math.min(...indexes);
      const start = Math.max(0, at - 500);
      hits.push({ score, source: basename(path), text: value.slice(start, start + 2_000) });
    }
  }
  const selected = hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(30, limit)));
  if (selected.length === 0) return `No archived context matched: ${query}`;
  return selected.map((hit) => `## ${hit.source} score=${hit.score}\n${hit.text}`).join("\n\n").slice(0, 30_000);
}

export function latestCheckpointFromAttempt(attemptDir: string): string | null {
  const root = join(attemptDir, "context-epochs");
  if (!existsSync(root)) return null;
  const files = readdirSync(root).filter((name) => name.endsWith(".checkpoint.md")).sort().reverse();
  if (!files[0]) return null;
  try { return readFileSync(join(root, files[0]), "utf8"); } catch { return null; }
}
