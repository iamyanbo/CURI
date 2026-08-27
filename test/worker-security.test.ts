import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPublicUrl, estimateCostUsd, isMalformedToolCall, providerErrorDetail, providerFailureFromText,
  safePath, validateProcess,
} from "../src/worker/genkit-worker.js";

test("worker paths cannot escape or reach protected evaluators", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-path-"));
  try {
    assert.throws(() => safePath(root, "../secret"), /escapes/);
    assert.throws(() => safePath(root, ".autoresearch-protected/check.py"), /protected/);
    assert.equal(safePath(root, "candidate/file.txt"), join(root, "candidate", "file.txt"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process policy is generic but blocks inline code, shells, traversal and shell syntax", () => {
  assert.throws(() => validateProcess(process.cwd(), "python", ["-c", "print(1)"]), /inline Python/);
  assert.throws(() => validateProcess(process.cwd(), "py", ["-3.10", "-c", "print(1)"]), /inline Python/);
  assert.throws(() => validateProcess(process.cwd(), "node", ["--eval", "1+1"]), /inline Node/);
  assert.throws(() => validateProcess(process.cwd(), "powershell", ["-Command", "Get-ChildItem"]), /interactive shells/);
  assert.doesNotThrow(() => validateProcess(process.cwd(), "npx", ["anything"]));
  assert.doesNotThrow(() => validateProcess(process.cwd(), "npm", ["install", "x"]));
  assert.throws(() => validateProcess(process.cwd(), "git", ["show", "../secret"]), /parent path/);
  assert.throws(() => validateProcess(process.cwd(), "git", ["status;whoami"]), /metacharacters/);
  assert.doesNotThrow(() => validateProcess(process.cwd(), "npm", ["test"]));
});

test("a bare interpreter is refused instead of opening a REPL that blocks on stdin", () => {
  assert.throws(() => validateProcess(process.cwd(), "python", []), /interactive REPL is not available/);
  assert.throws(() => validateProcess(process.cwd(), "python3", []), /interactive REPL is not available/);
  assert.throws(() => validateProcess(process.cwd(), "py", ["-3.10"]), /interactive REPL is not available/);
  assert.throws(() => validateProcess(process.cwd(), "node", []), /interactive REPL is not available/);
  assert.doesNotThrow(() => validateProcess(process.cwd(), "python", ["check.py"]));
  assert.doesNotThrow(() => validateProcess(process.cwd(), "py", ["-3.10", "check.py"]));
  // Non-interpreters are unaffected: bare git prints usage and exits.
  assert.doesNotThrow(() => validateProcess(process.cwd(), "git", []));
});

test("fetch policy blocks local, metadata and private literal addresses", async () => {
  await assert.rejects(assertPublicUrl(new URL("http://127.0.0.1/")), /non-public/);
  await assert.rejects(assertPublicUrl(new URL("http://[::1]/")), /non-public/);
  await assert.rejects(assertPublicUrl(new URL("http://metadata.google.internal/")), /not public/);
});

test("Gemini usage is charged into the campaign budget", () => {
  assert.equal(estimateCostUsd("gemini-3.5-flash", 1_000_000, 1_000_000), 10.5);
  assert.equal(estimateCostUsd("gemini-3.5-flash", 0, 0, 2), 0);
  assert.ok(estimateCostUsd("unknown-model", 1_000, 1_000) > 0);
});

test("a metered search proxy can still be priced explicitly", () => {
  process.env.AR_SEARCH_USD_PER_QUERY = "0.014";
  try {
    assert.equal(estimateCostUsd("deepseek-v4-flash-0731", 0, 0, 2, true), 0.028);
  } finally { delete process.env.AR_SEARCH_USD_PER_QUERY; }
});

test("Ox Alpha preview usage is observed without inventing a token charge", () => {
  assert.equal(estimateCostUsd("stealth/ox-alpha", 1_000_000, 1_000_000), 0);
});

test("an undecodable tool call is classified apart from provider health", () => {
  const malformed = "SyntaxError: Expected ',' or '}' after property value in JSON at position 30 (line 1 column 31)";
  assert.ok(isMalformedToolCall(malformed));
  assert.match(String(providerFailureFromText(malformed)), /^PROVIDER_MALFORMED_TOOL_CALL:/);
  // It must not be mistaken for throttling, which drives a very different backoff.
  assert.doesNotMatch(String(providerFailureFromText(malformed)), /RATE_LIMITED/);
  assert.ok(isMalformedToolCall('SyntaxError: Unterminated string in JSON at position 812'));
  assert.ok(isMalformedToolCall("Unexpected token } in JSON at position 4"));
  assert.equal(isMalformedToolCall("GenkitError: UNKNOWN: Provider returned error"), false);
  assert.equal(providerFailureFromText("429 RESOURCE_EXHAUSTED")?.startsWith("PROVIDER_RATE_LIMITED"), true);
});

test("the upstream provider reason survives instead of being stringified away", () => {
  // JSON.stringify(new Error(...)) is "{}" because Error properties are not
  // enumerable, which is how every upstream reason used to be discarded.
  const upstream = Object.assign(new Error("Provider returned error"), {
    status: 502, requestID: "req_abc123",
    error: { message: "upstream model is overloaded", type: "server_error" },
  });
  const wrapper = new Error("GenkitError: UNKNOWN: Provider returned error", { cause: upstream });
  const detail = providerErrorDetail(wrapper);
  assert.match(detail, /upstream model is overloaded/);
  assert.match(detail, /status=502/);
  assert.match(detail, /req_abc123/);
  assert.doesNotMatch(detail, /cause: \{\}/);
});

test("a nested error chain terminates instead of recursing forever", () => {
  const loop = new Error("outer") as Error & { cause?: unknown };
  loop.cause = loop;
  assert.match(providerErrorDetail(loop), /error chain truncated/);
});

test("AR_MODEL selects the model on whichever provider is configured", () => {
  // A user who sets AR_MODEL and points the runtime at OpenRouter must get the
  // model they named, not a silent fallback to the built-in default.
  const worker = readFileSync(join(process.cwd(), "src", "worker", "genkit-worker.ts"), "utf8");
  const openRouterBranch = worker.slice(worker.indexOf('if (provider === "openrouter"'),
    worker.indexOf('if (provider === "vertex-ai"'));
  assert.match(openRouterBranch, /process\.env\.AR_MODEL/);
  const googleBranch = worker.slice(worker.indexOf('const requested = request.model'));
  assert.match(googleBranch, /process\.env\.AR_MODEL/);
});

test("a self-hosted model is not charged the list price of a hosted one", () => {
  // An unknown model falls back to $3/$20 per million. Applied to a model served
  // from the operator's own hardware, that invents spend and eventually trips a
  // ceiling nothing was spending against.
  assert.equal(estimateCostUsd("deepseek-v4-flash-0731", 24_000_000, 700_000, 0, true), 0);
  assert.ok(estimateCostUsd("deepseek-v4-flash-0731", 24_000_000, 700_000, 0, false) > 80);
  // A known hosted model keeps its real rate even when the flag is set, and an
  // explicit override still wins, so self-hosting can be priced deliberately.
  process.env.AR_INPUT_USD_PER_MILLION = "0.5";
  try {
    assert.equal(estimateCostUsd("whatever", 1_000_000, 0, 0, true), 0.5);
  } finally { delete process.env.AR_INPUT_USD_PER_MILLION; }
});

test("an OpenAI-compatible base URL can point at a local model server", () => {
  const worker = readFileSync(join(process.cwd(), "src", "worker", "genkit-worker.ts"), "utf8");
  const branch = worker.slice(worker.indexOf('if (provider === "openrouter"'), worker.indexOf('const requested ='));
  // The URL was hardcoded, so a served model speaking the same protocol on the
  // operator's own network could not be reached at all.
  assert.match(branch, /AR_MODEL_BASE_URL/);
  assert.match(branch, /baseURL,/);
  // A self-hosted endpoint usually has no auth; OpenRouter always needs a key.
  assert.match(branch, /not-required/);
  assert.match(branch, /OpenRouter credential missing/);
});

test("generic web search is model-provider independent", () => {
  const worker = readFileSync(join(process.cwd(), "src", "worker", "genkit-worker.ts"), "utf8");
  assert.match(worker, /searchPublicWeb\(query, maxResults\)/);
  assert.doesNotMatch(worker, /openRouterSearch|openrouter:web_search/);
  assert.doesNotMatch(worker, /localOnly\(\) \? null/);
});
