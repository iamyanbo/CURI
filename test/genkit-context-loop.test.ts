import assert from "node:assert/strict";
import test from "node:test";

import { genkit, z } from "genkit";
import { mockModel } from "genkit/testing";

test("Genkit can return, execute, serialize, and resume a manually resolved tool turn", async () => {
  const ai = genkit({});
  const model = mockModel(ai, { info: { supports: { tools: true } }, respond: [
    { toolRequests: [{ name: "measure", input: { sample: 7 } }] },
    { text: "continued after the measurement" },
  ] });
  const measure = ai.defineTool({ name: "measure", description: "Measure one sample.",
    inputSchema: z.object({ sample: z.number() }), outputSchema: z.object({ value: z.number() }) },
  async ({ sample }) => ({ value: sample * 2 }));

  const first = await ai.generate({ model, prompt: "Run the measurement.", tools: [measure], returnToolRequests: true });
  assert.equal(first.toolRequests.length, 1);
  assert.equal(model.requestCount, 1, "Genkit returned the tool request without silently starting another model turn");

  const request = first.toolRequests[0]!;
  const output = await measure(request.toolRequest.input as { sample: number });
  const messages = [...first.messages, { role: "tool" as const, content: [measure.respond(request, output)] }];
  assert.doesNotThrow(() => JSON.stringify(messages));

  const second = await ai.generate({ model, messages, tools: [measure], returnToolRequests: true });
  assert.equal(second.text, "continued after the measurement");
  assert.equal(model.requestCount, 2);
  assert.deepEqual(model.lastRequest?.messages.at(-1)?.content[0]?.toolResponse?.output, { value: 14 });
});
