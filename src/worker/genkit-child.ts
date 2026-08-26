import { readFileSync, writeFileSync } from "node:fs";

import { loadEnvFile } from "../config/env-file.js";
import { GenkitWorker } from "./genkit-worker.js";
import type { WorkerRequest } from "./types.js";

// The parent normally passes its environment through, but a worker started
// directly (a cloud task entrypoint, a manual rerun) must load it too.
loadEnvFile(process.cwd());

const requestPath = process.argv[2];
const resultPath = process.argv[3];
if (!requestPath || !resultPath) throw new Error("usage: genkit-child REQUEST.json RESULT.json");

const request = JSON.parse(readFileSync(requestPath, "utf8")) as WorkerRequest;
const result = await new GenkitWorker().run(request);
writeFileSync(resultPath, JSON.stringify(result), "utf8");
