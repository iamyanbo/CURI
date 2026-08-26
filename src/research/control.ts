import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { statePath } from "./paths.js";

export type ResearchStopMode = "now" | "after-study";

export function immediateStopFile(projectRoot: string): string {
  return statePath(projectRoot, "research.stop.now");
}

export function boundaryStopFile(projectRoot: string): string {
  return statePath(projectRoot, "research.stop.after-study");
}

export function watcherStopFile(projectRoot: string): string {
  return statePath(projectRoot, "research.watcher.stop");
}

export function requestResearchStop(projectRoot: string, mode: ResearchStopMode, reason: string): void {
  const path = mode === "now" ? immediateStopFile(projectRoot) : boundaryStopFile(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, reason, "utf8");
}

export function requestedStop(projectRoot: string): { mode: ResearchStopMode; reason: string } | null {
  for (const [mode, path] of [["now", immediateStopFile(projectRoot)], ["after-study", boundaryStopFile(projectRoot)]] as const) {
    if (!existsSync(path)) continue;
    try {
      const body = readFileSync(path, "utf8").trim();
      return { mode, reason: body || "operator requested stop" };
    } catch { return { mode, reason: "operator requested stop" }; }
  }
  return null;
}

export function clearResearchStops(projectRoot: string): void {
  for (const path of [immediateStopFile(projectRoot), boundaryStopFile(projectRoot)]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

export async function cancellableDelay(projectRoot: string, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (requestedStop(projectRoot)) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
  return true;
}
