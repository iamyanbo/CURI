import assert from "node:assert/strict";
import test from "node:test";

import { extractJson } from "../src/worker/types.js";
import { providerFailureFromText } from "../src/worker/genkit-worker.js";

test("extractJson accepts fenced JSON with raw quotes inside a code-string field", () => {
  const response = [
    "```json",
    "{",
    "  \"hypothesis\": {\"title\": \"quote-safe\"},",
    "  \"instruction_to_executor\": \"asm volatile(\"st.global.cs.f32 [%0],%1;\"::\"l\"(ptr),\"f\"(value));\"",
    "}",
    "```",
  ].join("\n");
  const parsed = extractJson<{ instruction_to_executor: string }>(response);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.match(parsed.value.instruction_to_executor, /st\.global\.cs/);
});

test("extractJson still rejects an actually truncated object", () => {
  assert.deepEqual(extractJson('{"hypothesis":{"title":"unfinished"}'), {
    ok: false,
    error: "TRUNCATED_JSON",
  });
});

test("extractJson repairs a bare optional undefined without changing string content", () => {
  const parsed = extractJson<{ optional: null; text: string }>(
    '{"optional":undefined,"text":"the word undefined stays"}',
  );
  assert.deepEqual(parsed, { ok: true, value: { optional: null, text: "the word undefined stays" } });
});

test("extractJson recovers unescaped linkage quotes in a structured packet", () => {
  const parsed = extractJson<{ interfaces: string[]; action: { type: string } }>(
    '```json\n{"interfaces":["extern "C" void run_attention(float* out) - keep it byte-identical","layout [B,H,T,D]"],"action":{"type":"dispatch"}}\n```',
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.interfaces[0], 'extern "C" void run_attention(float* out) - keep it byte-identical');
    assert.equal(parsed.value.action.type, "dispatch");
  }
});

test("provider throttling preserves upstream rate-limit detail", () => {
  for (const detail of ["HTTP 429", "RESOURCE_EXHAUSTED", "upstream_provider_shared_pool", "rate_limit_exceeded"])
    assert.match(providerFailureFromText(detail) ?? "", /^PROVIDER_RATE_LIMITED:/);
  assert.equal(providerFailureFromText("invalid API key"), null);
});
