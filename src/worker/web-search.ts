/**
 * Provider-independent public web search.
 *
 * This uses the same zero-config Exa MCP tool as pi-web-access, but keeps the
 * integration deliberately small: there are no hosted-model fallbacks and no
 * dependency on Pi's interactive extension runtime. Search returns source text
 * and URLs; the configured CURI model performs any reasoning or summarization.
 */

const DEFAULT_EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MAX_SEARCH_OUTPUT_CHARS = 30_000;

type FetchLike = typeof fetch;

interface McpRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

export interface PublicWebSearchOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  endpoint?: string;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseMcpEnvelope(body: string): McpRpcResponse {
  // Exa normally streams one JSON-RPC response as server-sent events. Accept a
  // plain JSON response as well so the transport remains compatible with MCP
  // proxies that remove the SSE framing.
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as McpRpcResponse;
      if (parsed.result || parsed.error) return parsed;
    } catch {
      // Ignore non-JSON SSE events and continue to the actual result event.
    }
  }

  try {
    const parsed = JSON.parse(body) as McpRpcResponse;
    if (parsed.result || parsed.error) return parsed;
  } catch {
    // The caller gets one stable error below instead of a JSON parser detail.
  }
  throw new Error("Exa MCP returned an empty or malformed response");
}

export async function searchPublicWeb(
  query: string,
  maxResults = 5,
  options: PublicWebSearchOptions = {},
): Promise<string> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("web search query must not be empty");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    throw new Error("web search maxResults must be an integer from 1 to 10");
  }

  const endpoint = options.endpoint
    ?? process.env.AR_WEB_SEARCH_MCP_URL?.trim()
    ?? DEFAULT_EXA_MCP_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: normalizedQuery,
          numResults: maxResults,
          livecrawl: "fallback",
          type: "auto",
          contextMaxCharacters: 3_000,
        },
      },
    }),
    signal: requestSignal(options.signal),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Exa MCP search HTTP ${response.status}: ${detail}`);
  }

  const envelope = parseMcpEnvelope(await response.text());
  if (envelope.error) {
    const code = typeof envelope.error.code === "number" ? ` ${envelope.error.code}` : "";
    throw new Error(`Exa MCP search error${code}: ${envelope.error.message ?? "unknown error"}`);
  }
  if (envelope.result?.isError) {
    const detail = envelope.result.content
      ?.find((item) => item.type === "text" && item.text?.trim())
      ?.text?.trim();
    throw new Error(detail || "Exa MCP search returned an error");
  }

  const text = envelope.result?.content
    ?.find((item) => item.type === "text" && item.text?.trim())
    ?.text?.trim();
  if (!text) throw new Error("Exa MCP search returned no results");
  return text.length <= MAX_SEARCH_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_SEARCH_OUTPUT_CHARS)}\n…[truncated]`;
}
