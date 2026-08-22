import { readFileSync, writeFileSync } from "node:fs";

import { GenkitWorker } from "./genkit-worker.js";
import type { WorkerRequest } from "./types.js";

const requestPath = process.argv[2];
const resultPath = process.argv[3];
if (!requestPath || !resultPath) throw new Error("usage: genkit-child REQUEST.json RESULT.json");

const request = JSON.parse(readFileSync(requestPath, "utf8")) as WorkerRequest;
const result = await new GenkitWorker().run(request);
writeFileSync(resultPath, JSON.stringify(result), "utf8");
