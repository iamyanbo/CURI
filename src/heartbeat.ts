/**
 * One-line, evidence-bearing campaign heartbeat.
 *
 * Liveness, current activity, and scientific progress are deliberately
 * separate. A quiet model or CUDA process is never killed or declared failed
 * merely because a cycle has not completed. Absence-only evidence produces a
 * review request with `safe_to_interrupt=false`.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { inspect, processStartId } from "./daemon.js";
import { assessHeartbeat, readHeartbeat, type HeartbeatSnapshot } from "./supervision/progress-heartbeat.js";
import { latestCampaignId, normaliseCampaignConfig, Store } from "./store/store.js";

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, ".autoresearch");
const MARK = join(STATE_DIR, "heartbeat.json");
const CAMPAIGN = (() => {
  const i = process.argv.indexOf("--campaign");
  return i >= 0 ? process.argv[i + 1]! : (process.env.AR_CAMPAIGN ?? latestCampaignId());
})();

interface Mark { replicated: number; at: string; }
function readMark(): Mark | null {
  if (!existsSync(MARK)) return null;
  try { return JSON.parse(readFileSync(MARK, "utf8")) as Mark; } catch { return null; }
}

function heartbeatFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === "heartbeat.json") out.push(full);
    }
  };
  visit(root);
  return out;
}

function latestWorkerHeartbeat(campaignId: string): HeartbeatSnapshot | null {
  return heartbeatFiles(join(STATE_DIR, "attempts"))
    .map(readHeartbeat)
    .filter((snapshot): snapshot is HeartbeatSnapshot => Boolean(snapshot?.campaignId === campaignId))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null;
}

const live = inspect(STATE_DIR);
const store = Store.open(join(STATE_DIR, "state.sqlite"));
const row = store.db.prepare("SELECT status, stop_reason, config_json FROM campaigns WHERE campaign_id = ?")
  .get(CAMPAIGN) as { status: string; stop_reason: string | null; config_json: string } | undefined;
const cycles = (store.db.prepare(
  "SELECT COALESCE(SUM(consumed),0) AS n FROM budgets WHERE campaign_id=? AND category='runs'",
).get(CAMPAIGN) as { n: number }).n;
const counts = store.db.prepare(
  "SELECT status, COUNT(*) AS n FROM hypotheses WHERE campaign_id=? GROUP BY status",
).all(CAMPAIGN) as Array<{ status: string; n: number }>;
const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
const cost = (store.db.prepare(
  "SELECT COALESCE(SUM(consumed),0) AS c FROM budgets WHERE campaign_id=? AND category='model_cost_usd'",
).get(CAMPAIGN) as { c: number }).c;
const baseline = row ? normaliseCampaignConfig(row.config_json).baselinePrimary : null;
const chainOk = store.verifyEventChain().ok;
store.close();

const prev = readMark();
const replicated = byStatus.replicated ?? 0;
const parts: string[] = [];
const worker = latestWorkerHeartbeat(CAMPAIGN);

if (live.state !== "running") {
  const why = live.state === "stale" ? live.reason : "no run file";
  parts.push(`⛔ CAMPAIGN NOT RUNNING (${why}) — status=${row?.status ?? "?"}${row?.stop_reason ? ` reason=${row.stop_reason}` : ""}`);
} else if (worker && !["completed", "failed"].includes(worker.phase)) {
  const currentWorkerStart = processStartId(worker.pid);
  const currentOperationStart = worker.operation?.pid ? processStartId(worker.operation.pid) : null;
  const operationAlive = worker.operation?.pid
    ? currentOperationStart !== null
      && (!worker.operation.processStartId || currentOperationStart === worker.operation.processStartId)
    : null;
  const assessment = assessHeartbeat(worker, {
    processAlive: currentWorkerStart !== null
      && (!worker.processStartId || currentWorkerStart === worker.processStartId),
    operationAlive,
  });
  const icon = assessment.state === "healthy" ? "✅" : assessment.state === "slow" ? "🐢" : "⚠️";
  parts.push(`${icon} ${assessment.state} · ${worker.phase} · ${worker.note} · `
    + `activity ${Math.round(assessment.activityAgeMs / 1000)}s ago · progress ${Math.round(assessment.progressAgeMs / 1000)}s ago`
    + (assessment.state === "review_due" ? " · safe_to_interrupt=false" : ""));
} else {
  parts.push(`✅ running (pid ${live.run.pid}) · cycle ${cycles} · between model/tool operations`);
}

parts.push(
  `claims: ${replicated} replicated`
  + ` · ${byStatus.refuted ?? 0} refuted · ${byStatus.inconclusive ?? 0} inconclusive`
  + ` · ${byStatus.implementation_invalid ?? 0} invalid · ${byStatus.shortcut_suspected ?? 0} shortcut`,
);
parts.push(`baseline ${typeof baseline === "number" ? baseline.toFixed(6) : "?"} · $${cost.toFixed(3)} · chain ${chainOk ? "ok" : "BROKEN"}`);
if (prev && replicated > prev.replicated) parts.push(`🎉 ${replicated - prev.replicated} new replicated claim(s) since last check`);
if (!chainOk) parts.push("🚨 EVENT CHAIN BROKEN — stop and investigate");

writeFileSync(MARK, JSON.stringify({ replicated, at: new Date().toISOString() }), "utf8");
console.log(`[${CAMPAIGN}] ` + parts.join(" | "));
