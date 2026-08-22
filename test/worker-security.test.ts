import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPublicUrl, estimateCostUsd, safePath, validateProcess } from "../src/worker/genkit-worker.js";

test("worker paths cannot escape or reach protected evaluators", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-path-"));
  try {
    assert.throws(() => safePath(root, "../secret"), /escapes/);
    assert.throws(() => safePath(root, ".autoresearch-protected/check.py"), /protected/);
    assert.equal(safePath(root, "candidate/file.txt"), join(root, "candidate", "file.txt"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process policy blocks inline code, installers, traversal and shell syntax", () => {
  assert.throws(() => validateProcess(process.cwd(), "python", ["-c", "print(1)"]), /inline Python/);
  assert.throws(() => validateProcess(process.cwd(), "node", ["--eval", "1+1"]), /inline Node/);
  assert.throws(() => validateProcess(process.cwd(), "npx", ["anything"]), /not allowed/);
  assert.throws(() => validateProcess(process.cwd(), "npm", ["install", "x"]), /restricted/);
  assert.throws(() => validateProcess(process.cwd(), "git", ["show", "../secret"]), /parent path/);
  assert.throws(() => validateProcess(process.cwd(), "git", ["status;whoami"]), /metacharacters/);
  assert.doesNotThrow(() => validateProcess(process.cwd(), "npm", ["test"]));
});

test("fetch policy blocks local, metadata and private literal addresses", async () => {
  await assert.rejects(assertPublicUrl(new URL("http://127.0.0.1/")), /non-public/);
  await assert.rejects(assertPublicUrl(new URL("http://[::1]/")), /non-public/);
  await assert.rejects(assertPublicUrl(new URL("http://metadata.google.internal/")), /not public/);
});

test("Gemini usage is charged into the campaign budget", () => {
  assert.equal(estimateCostUsd("gemini-3.5-flash", 1_000_000, 1_000_000), 10.5);
  assert.equal(estimateCostUsd("gemini-3.5-flash", 0, 0, 2), 0.028);
  assert.ok(estimateCostUsd("unknown-model", 1_000, 1_000) > 0);
});
