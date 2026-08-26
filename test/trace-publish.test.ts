import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPublishable, auditPublishedRecord, chunkTraceSteps, machineIdentifiers,
  publishableTrace, publishableTraceStep, redactTraceText, residualIdentifier, STEPS_PER_CHUNK,
} from "../src/research/trace-publish.js";

const identifiers = ["yanbo", "DESKTOP-9GTQ2", "C:\\Users\\yanbo", "plain-looking-key-value"];

test("redaction removes the shapes we can name", () => {
  assert.equal(redactTraceText("at C:\\Users\\yanbo\\proj\\x.py:3"), "at <workspace>\\proj\\x.py:3");
  assert.equal(redactTraceText("/home/yanbo/work"), "<workspace>/work");
  assert.equal(redactTraceText("mail me at a.person@example.com"), "mail me at <email>");
  assert.equal(redactTraceText("connect 192.168.1.44"), "connect <ip>");
  assert.match(redactTraceText("key=sk-abcdefghijklmnopqrstuv"), /<redacted-credential>/);
  assert.match(redactTraceText("AIzaSyAbcdefghijklmnopqrstuvwxyz01"), /<redacted-credential>/);
});

test("cited URLs survive redaction", () => {
  // A drive-letter pattern without a lookbehind reads the "s:" in "https" and
  // the "e:" in "file" as drives, which would replace every source link in the
  // published trace with a path marker.
  const text = "see https://arxiv.org/abs/2306.14048 and http://localhost:7331/api";
  assert.equal(redactTraceText(text), text);
  assert.equal(redactTraceText("file:///C:/Users/yanbo/app/index.mjs"), "file:///<workspace>/app/index.mjs");
});

test("a step whose identifier survives redaction is withheld, not published", () => {
  // The point of the guard: redaction is best-effort, the check is not. Here the
  // username appears in a form no path pattern matches.
  const step = { seq: 4, atMs: 90, kind: "thinking", content: "the user yanbo asked for this" };
  const published = publishableTraceStep(step, { identifiers })!;
  assert.equal(published.withheld, "identifier");
  assert.doesNotMatch(published.content, /yanbo/i);
  // Position and shape survive so the omission is visible in the trace.
  assert.equal(published.seq, 4);
  assert.equal(published.kind, "thinking");
});

test("the identifier check is case-insensitive", () => {
  assert.equal(residualIdentifier("ran as YANBO", identifiers), "yanbo");
  assert.equal(residualIdentifier("nothing here", identifiers), null);
});

test("a credential echoed by a tool is caught by value, not by shape", () => {
  // A key that matches no known prefix pattern still cannot be published,
  // because its literal value is an identifier. This is the case redaction
  // alone would miss.
  const step = { seq: 1, atMs: 0, kind: "text", content: "Authorization: plain-looking-key-value" };
  const published = publishableTraceStep(step, { identifiers })!;
  assert.equal(published.withheld, "identifier");
  assert.doesNotMatch(published.content, /plain-looking/);
});

test("credential values are collected from the environment by name", () => {
  const found = machineIdentifiers({
    USERNAME: "someone", COMPUTERNAME: "a-box",
    VERTEX_API_KEY: "supersecretvalue", OPENROUTER_API_KEY: "another-secret-value",
    PATH: "/usr/bin", AR_MODEL: "gemini-3.7-flash",
  } as NodeJS.ProcessEnv);
  assert.ok(found.includes("supersecretvalue"));
  assert.ok(found.includes("another-secret-value"));
  assert.ok(found.includes("someone"));
  // Ordinary configuration is not an identifier: treating it as one would
  // withhold every step that mentions the model.
  assert.ok(!found.includes("gemini-3.7-flash"));
  assert.ok(!found.includes("/usr/bin"));
});

test("short values never become identifiers", () => {
  // A two-letter username would match most steps and withhold the whole trace.
  // The host's own values are always included, so this asserts the short ones
  // were dropped rather than that the list is empty.
  const found = machineIdentifiers({ USERNAME: "jo", COMPUTERNAME: "pc" } as NodeJS.ProcessEnv);
  assert.ok(!found.includes("jo"));
  assert.ok(!found.includes("pc"));
});

test("tool output is withheld by default and its shape is kept", () => {
  const step = { seq: 2, atMs: 10, kind: "tool_result", toolName: "run",
    content: "x".repeat(1500), isError: true };
  const closed = publishableTraceStep(step, { identifiers })!;
  assert.equal(closed.withheld, "tool-output");
  assert.match(closed.content, /1,500 characters of tool output/);
  assert.equal(closed.isError, true);
  // Asking for it publishes it, redacted and checked like anything else.
  const open = publishableTraceStep(step, { identifiers, includeToolOutput: true })!;
  assert.equal(open.withheld, undefined);
  assert.equal(open.content, "x".repeat(1500));
});

test("reasoning and written code are published", () => {
  const steps = [
    { seq: 0, atMs: 1, kind: "thinking", content: "Comparing eviction against a random control." },
    { seq: 1, atMs: 2, kind: "tool_call", toolName: "write", content: "import torch\nx = 1" },
  ];
  const published = publishableTrace(steps, { identifiers });
  assert.equal(published.length, 2);
  assert.ok(published.every((step) => !step.withheld));
  assert.match(published[1]!.content, /import torch/);
});

test("steps are grouped so republishing a long run stays cheap", () => {
  const steps = publishableTrace(
    Array.from({ length: 250 }, (_, seq) => ({ seq, atMs: seq, kind: "thinking", content: "work" })),
    { identifiers });
  const chunks = chunkTraceSteps("RUN-1", steps);
  assert.equal(chunks.length, 3);
  assert.equal((chunks[0]!.steps as unknown[]).length, STEPS_PER_CHUNK);
  assert.equal(chunks[0]!.chunk_id, "RUN-1__0000");
  assert.equal(chunks[2]!.from_seq, 200);
  // Ids are deterministic: a later sync overwrites the same documents rather
  // than accumulating duplicates.
  assert.deepEqual(chunkTraceSteps("RUN-1", steps).map((c) => c.chunk_id), chunks.map((c) => c.chunk_id));
});

test("an identifier anywhere in the record refuses the publish", () => {
  // The per-step check only covers traces. This is the gate that means an
  // operator does not have to trust that every producer remembered to redact.
  const record = {
    direction: { direction_id: "d", title: "fine" },
    syntheses: [{ synthesis_id: "SYN-1", markdown: "the run lived under /home/yanbo/work" }],
  };
  assert.throws(() => assertPublishable(record, identifiers), /refusing to publish/);
  const findings = auditPublishedRecord(record, identifiers);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.path, "syntheses[0].markdown");
  // The finding names the field, never the offending text, so a log of a
  // refusal is not itself a leak.
  assert.equal(JSON.stringify(findings).includes("/home/"), false);
});

test("a clean record passes the gate", () => {
  assert.doesNotThrow(() => assertPublishable({
    direction: { direction_id: "d" },
    syntheses: [{ markdown: "K/V quantization error is asymmetric; see <workspace>/study.py" }],
    runs: [{ run_id: "RUN-1", cost_usd: 0.4, segments: [{ kind: "tool", label: "run" }] }],
  }, identifiers));
});
