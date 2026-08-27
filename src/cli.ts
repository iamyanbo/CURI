#!/usr/bin/env node
/**
 * Entry point for CURI — Cumulative Research & Inquiry.
 *
 * Everything the system does is a `research` subcommand; `doctor` reports
 * whether this machine is configured to run one. The previous architecture — a
 * campaign harness that optimised a score — is archived under
 * `pi-extension/legacy-harness/` and is deliberately not reachable from here.
 */

import { loadEnvFile } from "./config/env-file.js";

// Credentials must be in the environment before any provider is resolved.
loadEnvFile(process.cwd());

import { runtimeDoctor } from "./config/doctor.js";
import { configureRuntime } from "./config/runtime.js";
import { handleResearchCommand } from "./research/commands.js";

const RUNTIME = configureRuntime();
const PROJECT_ROOT = process.cwd();

function usage(): void {
  console.log([
    "CURI — Cumulative Research & Inquiry",
    "",
    "  cli.ts research init --direction ID --title TEXT --brief MARKDOWN --domain PATH",
    "                       [--fixed TEXT] [--open TEXT] [--topic TEXT] [--watch-every SECONDS]",
    "  cli.ts research supervisor start|status|daemon      the research loop",
    "  cli.ts research watch start|stop|status|sweep       literature intake",
    "  cli.ts research watch configure [--every SECONDS] [--max-read N]",
    "  cli.ts research dashboard start [--port 7331]       operator view",
    "  cli.ts research status                              direction and daemons",
    "  cli.ts research preflight [--refresh]               verified environment sheet",
    "  cli.ts research budget [--max USD] [--record-spend USD --reason TEXT]",
    "  cli.ts research resume [--reason TEXT]              restart a paused direction",
    "  cli.ts research continuous [--off]                  keep going past a pause",
    "  cli.ts research stop --now|--after-study|--all [--reason TEXT]",
    "  cli.ts research publish [--dry-run] [--out FILE] [--project ID]",
    "  cli.ts research mirror [--port N] [--project ID]    read-only published view",
    "  cli.ts research reset --archive                     archive all local state",
    "",
    "  cli.ts doctor                                       check this machine",
    "",
    "  profiles: [--profile local|cloud] [--model-provider openrouter|openai-compatible|gemini-api|vertex-ai]",
  ].join("\n"));
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "research":
    await handleResearchCommand(PROJECT_ROOT, rest);
    break;
  case "doctor": {
    const checks = runtimeDoctor(RUNTIME);
    for (const check of checks) console.log(`${check.ok ? "OK  " : "FAIL"} ${check.name}: ${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    break;
  }
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    usage();
    process.exitCode = 1;
}
