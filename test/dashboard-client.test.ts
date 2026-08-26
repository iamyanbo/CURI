import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("dashboard client parses and exposes the current pipeline renderers", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const script = scripts[0]?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  for (const functionName of ["renderRoll", "focusStage", "updateTopology", "renderTrajectory"]) {
    assert.match(script, new RegExp(`function\\s+${functionName}\\s*\\(`));
  }
  assert.match(html, /id: "orchestrator",\s+label: "Orchestrator"/);
  assert.match(html, /id: "evaluator",\s+label: "Evaluator"/);
  assert.doesNotMatch(html, /id: "evaluation",\s+label: "Evaluator"/);
  assert.match(html, /Research overview/);
  assert.match(html, /Strategic control piano roll/);
  assert.match(html, /Micro and experiment trace/);
  assert.match(html, /Queue macro steer/);
  assert.match(script, /segment\.toolCallId/);
  assert.match(script, /const stageSegments = indexed\.map/);
  assert.match(script, /function packRollSegments/);
  assert.match(script, /macro architect/);
  assert.match(script, /micro manager/);
  assert.match(script, /class="lanetools/);
  assert.doesNotMatch(script, /row\.child/);
  assert.match(script, /scope: "macro"/);
  assert.match(script, /error: "var\(--bad\)"/);
});

test("the run control offers stop or resume according to the live process", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1] ?? "";

  assert.match(script, /function\s+renderRunControl\s*\(/);
  // The control must follow the live process, not the recorded status: a
  // campaign killed mid-cycle still reads 'running' in the database, and
  // offering "Stop" for a process that no longer exists does nothing.
  assert.match(script, /s\.live === "running"/);
  assert.match(script, /"\/api\/resume"/);
  assert.match(script, /"\/api\/stop"/);
  // It is one button in two modes, so the click handler has to read the mode
  // rather than assume stopping.
  assert.match(script, /dataset\.mode === "resume"/);
  assert.match(script, /renderRunControl\(s\)/);
  // The static label is only the initial state; the title is set per mode.
  assert.match(html, /<button id="stopbtn">Stop<\/button>/);
});
