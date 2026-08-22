import {runPiWorker} from "./src/worker/pi-worker.js";
const r = await runPiWorker({
  role: "manager",
  prompt: "Use arxiv_search or web_search to find ONE recent paper about optimizing CUDA softmax or GPU memory-bound kernels. Reply with only the title and year.",
  cwd: process.cwd(),
  attemptDir: ".autoresearch/attempts/websearch-probe2",
  isolatedHome: ".autoresearch/worker-home",
  tools: ["web_search","arxiv_search","code_search","fetch_content"],
  model: "openrouter/owl-alpha",
  timeoutMs: 240000,
});
console.log("ok:", !r.failure, "| exit:", r.exitCode, "| timedOut:", r.timedOut);
console.log("tool calls:", r.trace.filter(t=>t.kind==="tool_call").map(t=>t.toolName).join(", ") || "(none)");
console.log("reply:", String(r.text ?? "").slice(0,260));
if (r.failure) console.log("failure:", r.failure, r.stderrTail?.slice(-300));
