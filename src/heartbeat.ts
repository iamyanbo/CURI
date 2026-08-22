/**
 * One-line campaign heartbeat, for periodic monitoring.
 *
 * Prints a single summary line and exits. Designed so silence is never mistaken
 * for health: if the campaign process is gone, or the log has not advanced since
 * the previous check, it says so loudly rather than printing a tidy status.
 *
 * State between checks lives in `.autoresearch/heartbeat.json`, so a stall is
 * detectable without keeping a process alive.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { inspect } from "./daemon.js";
import { latestCampaignId, normaliseCampaignConfig, Store } from "./store/store.js";

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, ".autoresearch");
const MARK = join(STATE_DIR, "heartbeat.json");
// Never hardcode this. A monitor pointed at the wrong campaign reports the
// wrong campaign's health, which is worse than no monitor at all.
const CAMPAIGN = (() => {
  const i = process.argv.indexOf("--campaign");
  return i >= 0 ? process.argv[i + 1]! : (process.env.AR_CAMPAIGN ?? latestCampaignId());
})();

interface Mark { cycles: number; replicated: number; at: string; }

function readMark(): Mark | null {
  if (!existsSync(MARK)) return null;
  try { return JSON.parse(readFileSync(MARK, "utf8")) as Mark; } catch { return null; }
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

if (live.state !== "running") {
  const why = live.state === "stale" ? live.reason : "no run file";
  parts.push(`⛔ CAMPAIGN NOT RUNNING (${why}) — status=${row?.status ?? "?"}${row?.stop_reason ? ` reason=${row.stop_reason}` : ""}`);
} else if (prev && prev.cycles === cycles) {
  // Alive but not advancing. A long cycle is normal; two flat checks is not.
  parts.push(`⚠️ STALLED? alive (pid ${live.run.pid}) but cycle count unchanged at ${cycles} since ${prev.at}`);
} else {
  parts.push(`✅ running (pid ${live.run.pid}) · cycle ${cycles}`);
}

parts.push(
  `claims: ${replicated} replicated` +
  ` · ${byStatus.refuted ?? 0} refuted · ${byStatus.inconclusive ?? 0} inconclusive` +
  ` · ${byStatus.implementation_invalid ?? 0} invalid · ${byStatus.shortcut_suspected ?? 0} shortcut`,
);
parts.push(`baseline ${typeof baseline === "number" ? baseline.toFixed(6) : "?"} · $${cost.toFixed(3)} · chain ${chainOk ? "ok" : "BROKEN"}`);

if (prev && replicated > prev.replicated) {
  parts.push(`🎉 ${replicated - prev.replicated} new replicated claim(s) since last check`);
}
if (!chainOk) parts.push("🚨 EVENT CHAIN BROKEN — stop and investigate");

writeFileSync(MARK, JSON.stringify({ cycles, replicated, at: new Date().toISOString() }), "utf8");
console.log(`[${CAMPAIGN}] ` + parts.join(" | "));
