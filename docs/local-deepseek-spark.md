# Local CURI with DeepSeek on DGX Spark

This describes a deployment mode with no cloud dependency at all: the model is served on a second
machine on your own network, and nothing leaves it except the literature searches the watcher makes.
It is an alternative to the cloud-backed configuration in the README, not a replacement for it —
both run from the same code, selected by `.env`.

## Boundary

| Component | Location |
|---|---|
| DeepSeek inference | DGX Spark `dgx-spark.local` |
| CURI supervisor, workers and dashboard | Windows PC |
| Research state | PC-local SQLite under `.curi/` |
| Generic web search | Direct Exa MCP retrieval from the PC |
| arXiv, GitHub and page retrieval | Direct public HTTP APIs from the PC |
| Vertex, Gemini and OpenRouter model calls | Disabled |
| Firestore publication and cloud mirror | Disabled |

`local` means local inference and state, not offline. Search queries and page requests may reach the public internet. Search results are returned with source URLs; DeepSeek performs the reasoning and summarization.

## Start the Spark model

From PowerShell in the repository:

```powershell
.\scripts\spark.ps1 status
.\scripts\spark.ps1 up
.\scripts\spark.ps1 wait
```

The launcher connects over SSH using `~/.ssh/id_ed25519` (override with `SPARK_KEY`), starts the existing DeepSeek repository with `ABLATE=1`, and waits for `http://<spark-address>:8888/health`. Changing the ablation flag forces a container recreation and compile-cache rebuild, so the first boot can take several minutes.

To inspect the endpoint values for `.env`:

```powershell
.\scripts\spark.ps1 env
```

The expected configuration is:

```dotenv
AR_LOCAL_ONLY=1
AR_MODEL_PROVIDER=openai-compatible
AR_MODEL_BASE_URL=http://dgx-spark.local:8888/v1
AR_MODEL=deepseek-v4-flash-0731
AR_MAX_COST_USD=0
```

Use the numeric LAN address printed by `spark.ps1 env` if Windows mDNS does not resolve the `.local` hostname.

## Search behavior

CURI's `web_search` tool calls the same zero-configuration Exa MCP search transport used by Pi Web Access. It does not call an OpenRouter, Gemini, or Perplexity model. The returned source text and URLs become a tool result for the locally hosted DeepSeek model.

The specialized tools remain independent:

- `arxiv_search` calls the arXiv API.
- `code_search` calls the GitHub API.
- `fetch_content` retrieves an already-known public URL directly.

For a compatible MCP proxy, override `AR_WEB_SEARCH_MCP_URL`. Otherwise leave it unset to use `https://mcp.exa.ai/mcp`.

For time-indexed finance evaluations, unrestricted current search can introduce lookahead bias. Keep the experiment-design role behind the existing date fence and use watcher records published before the evaluation window.

## Run CURI on the PC

```powershell
npm install
npx tsx src/cli.ts doctor
npx tsx src/cli.ts research preflight --refresh
npx tsx src/cli.ts research supervisor start
npx tsx src/cli.ts research watch start
npx tsx src/cli.ts research dashboard start --port 7331
npx tsx src/cli.ts research continuous
```

Open `http://127.0.0.1:7331` on the PC.

Useful checks:

```powershell
npx tsx src/cli.ts research status
.\scripts\spark.ps1 status
.\scripts\spark.ps1 bench
```
