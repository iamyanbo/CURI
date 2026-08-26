import assert from "node:assert/strict";
import test from "node:test";

import { assessHeartbeat, type HeartbeatSnapshot } from "../src/supervision/progress-heartbeat.js";

const at = (ms: number) => new Date(ms).toISOString();
function snapshot(now: number, activityAge: number, progressAge: number): HeartbeatSnapshot {
  return {
    version: 1, heartbeatId: "hb", campaignId: "c", cycleId: "x", attemptId: "a",
    pid: 42, processStartId: "start-42", startedAt: at(now - 100_000), observedAt: at(now - activityAge),
    lastActivityAt: at(now - activityAge), lastProgressAt: at(now - progressAge),
    activitySeq: 2, progressSeq: 1, phase: "tool_running", note: "nvcc running",
    operation: { kind: "process", name: "nvcc", pid: 43 },
  };
}

test("quiet but recently improving work is slow, never safe to interrupt", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const result = assessHeartbeat(snapshot(now, 31 * 60_000, 5 * 60_000), {
    nowMs: now, processAlive: true, operationAlive: true,
  });
  assert.equal(result.state, "slow");
  assert.equal(result.safeToInterrupt, false);
});

test("absence-only stall evidence requests review but never authorizes a kill", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const result = assessHeartbeat(snapshot(now, 60 * 60_000, 60 * 60_000), {
    nowMs: now, processAlive: true, operationAlive: true,
  });
  assert.equal(result.state, "review_due");
  assert.equal(result.safeToInterrupt, false);
  assert.match(result.reason, /absence alone/);
});

test("only positive terminal evidence is safe to recover automatically", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  assert.deepEqual(
    assessHeartbeat(snapshot(now, 1_000, 1_000), { nowMs: now, processAlive: false }).safeToInterrupt,
    true,
  );
  assert.deepEqual(
    assessHeartbeat(snapshot(now, 1_000, 1_000), { nowMs: now, processAlive: true, operationAlive: false }).safeToInterrupt,
    true,
  );
});
