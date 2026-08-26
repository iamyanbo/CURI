import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";

import { stateDir, statePath } from "./paths.js";

import { validateProcess } from "../worker/genkit-worker.js";

/**
 * Deterministic environment discovery performed by the runtime, not by an
 * agent. Executors used to spend their whole turn probing interpreters, CUDA
 * visibility, and launcher syntax before writing a single line of the
 * experiment, and every retry repeated that discovery from scratch. Those are
 * facts about the machine, so the machine reports them once and both the
 * orchestrator (which must fix model and scale against real device memory) and
 * the executor (which must run the study) receive the same verified sheet.
 */

export interface PreflightInvocation {
  /** Executable exactly as the sandboxed `run`/`run_check` tools accept it. */
  executable: string;
  /** Leading arguments; a script path is appended by the caller. */
  args: string[];
}

export interface InterpreterFacts {
  invocation: PreflightInvocation;
  version: string;
  executablePath: string;
  packages: Record<string, string>;
  accelerator: Record<string, unknown> | null;
}

export interface PreflightFacts {
  collectedAt: string;
  host: { platform: string; arch: string; cpus: number; totalMemoryGb: number; node: string };
  tools: Record<string, string>;
  interpreters: InterpreterFacts[];
  accelerators: string[];
  /** Constraints the executor sandbox enforces, stated as facts rather than discovered by trial. */
  sandbox: string[];
}

const PROBE_PACKAGES = [
  "torch", "numpy", "scipy", "pandas", "sklearn", "transformers", "datasets",
  "accelerate", "safetensors", "einops", "matplotlib", "jax", "tensorflow",
];

const MARKER = "<<<PREFLIGHT>>>";

const PROBE = [
  "import json, sys",
  'info = {"version": sys.version.split()[0], "executablePath": sys.executable, "packages": {}}',
  `for name in ${JSON.stringify(PROBE_PACKAGES)}:`,
  "    try:",
  "        module = __import__(name)",
  '        info["packages"][name] = str(getattr(module, "__version__", "present"))',
  "    except Exception:",
  "        pass",
  "try:",
  "    import torch",
  "    available = bool(torch.cuda.is_available())",
  '    info["accelerator"] = {',
  '        "cuda_available": available,',
  '        "torch_cuda_version": torch.version.cuda,',
  '        "devices": [',
  "            {",
  '                "name": torch.cuda.get_device_name(i),',
  '                "total_memory_gb": round(torch.cuda.get_device_properties(i).total_memory / 1024 ** 3, 2),',
  '                "capability": ".".join(str(x) for x in torch.cuda.get_device_capability(i)),',
  "            }",
  "            for i in range(torch.cuda.device_count())",
  "        ] if available else [],",
  "    }",
  "except Exception:",
  '    info["accelerator"] = None',
  `print(${JSON.stringify(MARKER)} + json.dumps(info))`,
].join("\n");

function capture(executable: string, args: string[], timeoutMs = 180_000): string | null {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch { return null; }
}

/** Launcher forms worth probing, expressed only in shapes the sandbox accepts. */
export function candidateInvocations(root = process.cwd()): PreflightInvocation[] {
  const candidates: PreflightInvocation[] = [];
  const seen = new Set<string>();
  const push = (invocation: PreflightInvocation) => {
    const key = `${invocation.executable} ${invocation.args.join(" ")}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(invocation);
  };
  if (process.platform === "win32") {
    // `py -0p` lists every registered interpreter with its version tag. The tag
    // is what the sandbox accepts; the absolute path printed beside it is not.
    const listing = capture("py", ["-0p"], 30_000) ?? "";
    for (const line of listing.split(/\r?\n/)) {
      const tag = line.match(/-V:(\d+\.\d+)/)?.[1] ?? line.match(/^\s*-(\d+\.\d+)/)?.[1];
      if (tag) push({ executable: "py", args: [`-${tag}`] });
    }
  }
  push({ executable: "python", args: [] });
  push({ executable: "python3", args: [] });
  return candidates.filter((invocation) => {
    try {
      // Advertise only forms the executor sandbox will actually run, so the
      // sheet can never recommend a command that is rejected on use.
      validateProcess(root, invocation.executable, [...invocation.args, "probe.py"]);
      return true;
    } catch { return false; }
  });
}

function probeInterpreter(invocation: PreflightInvocation, probeScript: string): InterpreterFacts | null {
  const output = capture(invocation.executable, [...invocation.args, probeScript]);
  if (!output || !output.includes(MARKER)) return null;
  try {
    const parsed = JSON.parse(output.slice(output.indexOf(MARKER) + MARKER.length).trim()) as
      Omit<InterpreterFacts, "invocation">;
    return { invocation, ...parsed };
  } catch { return null; }
}

export function collectPreflight(projectRoot: string): PreflightFacts {
  const dir = stateDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const probeScript = join(dir, "preflight-probe.py");
  writeFileSync(probeScript, PROBE, "utf8");

  const interpreters: InterpreterFacts[] = [];
  const byExecutablePath = new Set<string>();
  for (const invocation of candidateInvocations(projectRoot)) {
    const facts = probeInterpreter(invocation, probeScript);
    if (!facts) continue;
    // `python` and `py -3.12` are frequently the same install; keep the first
    // form seen so the sheet lists distinct interpreters, not aliases.
    if (byExecutablePath.has(facts.executablePath)) continue;
    byExecutablePath.add(facts.executablePath);
    interpreters.push(facts);
  }

  const tools: Record<string, string> = {};
  for (const [name, args] of [
    ["git", ["--version"]], ["node", ["--version"]], ["nvcc", ["--version"]],
    ["cmake", ["--version"]], ["ninja", ["--version"]],
  ] as Array<[string, string[]]>) {
    const output = capture(name, args, 20_000);
    if (!output) continue;
    // Version banners vary: some tools put the version on the first line, others
    // bury it after a copyright header. Take the first line that carries one.
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    tools[name] = lines.find((line) => /\d+\.\d+/.test(line)) ?? lines[0] ?? output;
  }

  const gpuListing = capture("nvidia-smi",
    ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], 30_000);

  return {
    collectedAt: new Date().toISOString(),
    host: {
      platform: process.platform, arch: process.arch, cpus: cpus().length,
      totalMemoryGb: Math.round(totalmem() / 1024 ** 3), node: process.version,
    },
    tools,
    interpreters,
    accelerators: (gpuListing ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    sandbox: [
      "Commands run without a shell: no pipes, redirection, globbing, or `&&`.",
      "Inline code is rejected: `python -c`, `python -m`, and `node -e` are unavailable. Write a script file into the worktree and run that file.",
      "Executable paths are rejected; use a bare command name such as `py`, `python`, `node`, or `git`.",
      "Arguments may not be absolute paths outside the worktree and may not contain `..`.",
      "Select a non-default interpreter through its launcher tag, for example executable `py` with args `-3.10 study/run.py`.",
    ],
  };
}

export function preflightCachePath(projectRoot: string): string {
  return statePath(projectRoot, "preflight.json");
}

/**
 * Read-only view of the cached facts. Readers on a request path — the
 * dashboard, for one — must never trigger collection: probing every installed
 * interpreter takes seconds, and doing it inside a poll would stall the UI on
 * every refresh.
 */
export function cachedPreflight(projectRoot: string): PreflightFacts | null {
  const path = preflightCachePath(projectRoot);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as PreflightFacts; } catch { return null; }
}

/**
 * Cached facts, refreshed when older than `maxAgeMs`. Collection costs a few
 * seconds of subprocess work, so it is amortised across tasks but never so
 * stale that a newly installed dependency stays invisible for a whole run.
 */
export function preflightFacts(projectRoot: string, maxAgeMs = 6 * 60 * 60_000): PreflightFacts {
  const path = preflightCachePath(projectRoot);
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as PreflightFacts;
      if (Date.now() - Date.parse(cached.collectedAt) < maxAgeMs) return cached;
    } catch { /* recollect when the cache is unreadable */ }
  }
  const facts = collectPreflight(projectRoot);
  writeFileSync(path, JSON.stringify(facts, null, 2), "utf8");
  return facts;
}

function describeAccelerator(facts: InterpreterFacts): string {
  const accelerator = facts.accelerator;
  if (!accelerator) return "torch not importable";
  if (!accelerator.cuda_available) return "torch present but reports no CUDA device";
  const devices = (accelerator.devices as Array<Record<string, unknown>> | undefined) ?? [];
  return `CUDA ${String(accelerator.torch_cuda_version)} available; devices: `
    + devices.map((device) => `${String(device.name)} (${String(device.total_memory_gb)} GB, capability ${String(device.capability)})`)
      .join("; ");
}

export function renderPreflightMarkdown(facts: PreflightFacts): string {
  const interpreters = facts.interpreters.length === 0
    ? "No working Python interpreter was found."
    : facts.interpreters.map((item) => {
      const call = [item.invocation.executable, ...item.invocation.args, "<script.py>"].join(" ");
      const packages = Object.entries(item.packages).map(([name, version]) => `${name} ${version}`).join(", ")
        || "none of the probed packages are installed";
      return `- \`${call}\` — Python ${item.version} at ${item.executablePath}\n`
        + `  - accelerator: ${describeAccelerator(item)}\n  - packages: ${packages}`;
    }).join("\n");
  const tools = Object.entries(facts.tools).map(([name, version]) => `- ${name}: ${version}`).join("\n")
    || "- none of the probed build tools are on PATH";
  return [
    `## Verified environment (runtime preflight, collected ${facts.collectedAt})`,
    "These facts were measured by the runtime, not reported by a model. Do not spend the task rediscovering them."
    + " If one proves wrong in use, say so explicitly in the report instead of silently working around it.",
    `### Host\n- ${facts.host.platform}/${facts.host.arch}, ${facts.host.cpus} logical CPUs, `
    + `${facts.host.totalMemoryGb} GB RAM, Node ${facts.host.node}`,
    `### Accelerators\n${facts.accelerators.map((item) => `- ${item}`).join("\n") || "- no NVIDIA device reported by nvidia-smi"}`,
    `### Python interpreters\n${interpreters}`,
    `### Other tools\n${tools}`,
    `### Command sandbox\n${facts.sandbox.map((item) => `- ${item}`).join("\n")}`,
  ].join("\n\n");
}
