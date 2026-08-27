import assert from "node:assert/strict";
import test from "node:test";

import { searchPublicWeb } from "../src/worker/web-search.js";

test("web search uses Exa MCP directly without an external model call", async () => {
  let requestedUrl = "";
  let requestedBody: any;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Title: Example\\nURL: https://example.com\\nText: result"}]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  };

  const result = await searchPublicWeb("local VLM research", 7, { fetchImpl });
  assert.equal(requestedUrl, "https://mcp.exa.ai/mcp");
  assert.equal(requestedBody.method, "tools/call");
  assert.equal(requestedBody.params.name, "web_search_exa");
  assert.equal(requestedBody.params.arguments.query, "local VLM research");
  assert.equal(requestedBody.params.arguments.numResults, 7);
  assert.doesNotMatch(JSON.stringify(requestedBody), /openrouter|chat\/completions|model/i);
  assert.match(result, /https:\/\/example\.com/);
});

test("web search accepts plain JSON MCP responses and surfaces MCP errors", async () => {
  const successFetch: typeof fetch = async () => new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1,
    result: { content: [{ type: "text", text: "Title: Result\nURL: https://example.org" }] },
  }), { status: 200 });
  assert.match(await searchPublicWeb("query", 5, { fetchImpl: successFetch }), /example\.org/);

  const errorFetch: typeof fetch = async () => new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1, error: { code: -32000, message: "search unavailable" },
  }), { status: 200 });
  await assert.rejects(searchPublicWeb("query", 5, { fetchImpl: errorFetch }), /search unavailable/);
});

test("web search validates its public tool inputs", async () => {
  await assert.rejects(searchPublicWeb(" "), /must not be empty/);
  await assert.rejects(searchPublicWeb("query", 11), /integer from 1 to 10/);
});
