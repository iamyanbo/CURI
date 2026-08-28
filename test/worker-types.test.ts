import assert from "node:assert/strict";
import test from "node:test";

import { extractJson } from "../src/worker/types.js";
import {
  createReasoningTraceBatcher, normalizeOpenAIReasoningEventLine, normalizeOpenAIReasoningPayload, providerFailureFromText,
} from "../src/worker/genkit-worker.js";

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

test("self-hosted OpenAI responses expose reasoning through Genkit's expected field", () => {
  const payload = normalizeOpenAIReasoningPayload(JSON.stringify({
    choices: [{ message: { content: "answer", reasoning: "private work" } }],
  }));
  assert.deepEqual(JSON.parse(payload).choices[0].message, {
    content: "answer", reasoning_content: "private work",
  });
  const event = normalizeOpenAIReasoningEventLine(
    'data: {"choices":[{"delta":{"reasoning":"streamed work"}}]}\n',
  );
  assert.equal(JSON.parse(event.slice("data: ".length)).choices[0].delta.reasoning_content, "streamed work");
  assert.equal(normalizeOpenAIReasoningEventLine("data: [DONE]\n"), "data: [DONE]\n");
});

test("streamed reasoning is batched for a live trace without losing deltas", () => {
  const emitted: string[] = [];
  const batcher = createReasoningTraceBatcher((content) => emitted.push(content), 1_000, 10, 500);
  batcher.add("abc", 1_100);
  assert.deepEqual(emitted, []);
  batcher.add("defghijk", 1_200);
  assert.deepEqual(emitted, ["abcdefghijk"]);
  batcher.add("later", 1_800);
  assert.deepEqual(emitted, ["abcdefghijk", "later"]);
  batcher.add("tail", 1_900);
  batcher.flush(2_000);
  assert.deepEqual(emitted, ["abcdefghijk", "later", "tail"]);
  assert.equal(batcher.sawReasoning, true);
});
