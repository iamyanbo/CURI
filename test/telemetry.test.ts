import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categoryForTool, segmentAgentTrace, sumSegments } from "../src/ui/telemetry.js";

describe("dashboard trace timing", () => {
  it("keeps shell commands separate from ordinary tool calls", () => {
    assert.equal(categoryForTool("bash"), "command_execution");
    assert.equal(categoryForTool("shell_command"), "command_execution");
    assert.equal(categoryForTool("read"), "tool_execution");
  });

  it("removes paired tool spans from model reasoning without losing wall time", () => {
    const segments = segmentAgentTrace([
      { seq: 0, atMs: 200, kind: "tool_call", toolName: "read", toolCallId: "a", content: "{}" },
      { seq: 1, atMs: 350, kind: "tool_result", toolName: "read", toolCallId: "a", content: "ok" },
      { seq: 2, atMs: 500, kind: "tool_call", toolName: "bash", toolCallId: "b", content: "python train.py" },
      { seq: 3, atMs: 900, kind: "tool_result", toolName: "bash", toolCallId: "b", content: "done" },
    ], 1000);
    const totals = sumSegments(segments);

    assert.equal(totals.model_reasoning, 450);
    assert.equal(totals.tool_execution, 150);
    assert.equal(totals.command_execution, 400);
    assert.equal(Object.values(totals).reduce((a, b) => a + b, 0), 1000);
  });

  it("bounds an unfinished tool call by the observed worker duration", () => {
    const segments = segmentAgentTrace([
      { seq: 0, atMs: 300, kind: "tool_call", toolName: "bash", toolCallId: "live", content: "long job" },
    ], 800);
    const totals = sumSegments(segments);
    assert.deepEqual(totals, { model_reasoning: 300, command_execution: 500 });
  });
});
