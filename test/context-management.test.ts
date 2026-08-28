import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveContextEpoch,
  baseContextFits,
  contextTrigger,
  continuationPrompt,
  resolveContextManagementPolicy,
  searchAttemptHistory,
  validCheckpoint,
} from "../src/worker/context-management.js";
import type { ContextCompaction, ContextManagementPolicy } from "../src/worker/types.js";

const policy: ContextManagementPolicy = {
  mode: "auto",
  contextWindowTokens: 384_000,
  compactAtRatio: 0.60,
  maxModelTurnsPerEpoch: 24,
  checkpointMaxOutputTokens: 8_192,
  safetyTokens: 8_192,
  recentTraceSteps: 8,
};

test("context policy is explicit, validated, and defaults to automatic compaction", () => {
  assert.deepEqual(resolveContextManagementPolicy(undefined, {
    AR_CONTEXT_WINDOW_TOKENS: "384000",
    AR_CONTEXT_COMPACT_RATIO: "0.60",
    AR_CONTEXT_MAX_TURNS: "24",
  }), policy);
  assert.throws(() => resolveContextManagementPolicy(undefined, { AR_CONTEXT_COMPACTION: "sometimes" }), /auto or off/);
  assert.throws(() => resolveContextManagementPolicy({ compactAtRatio: 0.99 }, {}), /between 0.25 and 0.90/);
});

test("compaction triggers at 24 model turns or 60 percent context", () => {
  assert.equal(contextTrigger({ policy, epochTurns: 23, messages: "small", lastInputTokens: 1, lastOutputTokens: 1 }), null);
  assert.equal(contextTrigger({ policy, epochTurns: 24, messages: "small", lastInputTokens: 1, lastOutputTokens: 1 })?.trigger, "turns");
  assert.equal(contextTrigger({ policy, epochTurns: 1, messages: "x".repeat(691_200), lastInputTokens: 1, lastOutputTokens: 1 })?.trigger, "tokens");
  assert.equal(contextTrigger({ policy: { ...policy, mode: "off" }, epochTurns: 99,
    messages: "x".repeat(691_200), lastInputTokens: 300_000, lastOutputTokens: 1 }), null);
});

test("base context reserves room for output and a safety margin", () => {
  assert.equal(baseContextFits(policy, "x".repeat(1_000), 16_000), true);
  assert.equal(baseContextFits(policy, "x".repeat(1_100_000), 16_000), false);
});

test("checkpoint output is ordinary Markdown and rejects truncation", () => {
  const markdown = `# Working state\n\n${"Measured evidence and unresolved work. ".repeat(20)}`;
  assert.equal(validCheckpoint(markdown, "stop"), true);
  assert.equal(validCheckpoint(markdown, "length"), false);
  assert.equal(validCheckpoint("too short", "stop"), false);
});

test("archived history preserves exact evidence and remains locally retrievable", () => {
  const attemptDir = mkdtempSync(join(tmpdir(), "curi-context-"));
  const checkpoint = `# Working state\n\n${"Continue the experiment without changing its controls. ".repeat(20)}`;
  const record: ContextCompaction = {
    epoch: 1,
    trigger: "turns",
    atMs: 123,
    inputTokensBefore: 42_000,
    estimatedTokensAfter: 4_000,
    checkpointFile: "context-epochs/epoch-0001.checkpoint.md",
  };
  try {
    archiveContextEpoch({ attemptDir, epoch: 1,
      messages: [{ role: "tool", content: "Sharpe delta 0.0317 with seed 4421" }], checkpoint, record });
    assert.match(readFileSync(join(attemptDir, "context-epochs", "epoch-0001.messages.json"), "utf8"), /0\.0317/);
    assert.match(searchAttemptHistory(attemptDir, "seed 4421"), /Sharpe delta 0\.0317 with seed 4421/);
    const prompt = continuationPrompt({ originalPrompt: "Find a robust finance edge.", checkpoint,
      epoch: 1, trace: [{ seq: 0, kind: "tool_result", content: "check passed", atMs: 100 }],
      actions: [{ name: "write", markdown: "Saved results.csv" }],
      checks: [{ executable: "npm", args: ["test"], result: { exitCode: 0 } }], recentSteps: 8 });
    assert.match(prompt, /Find a robust finance edge/);
    assert.match(prompt, /search_attempt_history/);
    assert.match(prompt, /npm test -> exit 0/);
  } finally { rmSync(attemptDir, { recursive: true, force: true }); }
});
