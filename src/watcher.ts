/** Managed, continuous watcher process. */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { processStartId } from "./daemon.js";
import { GlobalMemoryStore } from "./memory/store.js";
import { Store } from "./store/store.js";
import { ProgressHeartbeat } from "./supervision/progress-heartbeat.js";
import { clearWatcherRun, watcherDir, watcherStopRequested } from "./watcher/control.js";
import { enrichWatcherSources } from "./watcher/enrichment.js";
import { readWatcherSubscription, sweepWatcher, watcherSourceBacklog } from "./watcher/service.js";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function interruptibleWait(ms: number, stopped: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopped()) {
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10_000, until - Date.now())));
  }
}

async function main(): Promise<void> {
  const projectRoot = resolve(argOf("project-root") ?? process.cwd());
  const campaignId = argOf("campaign");
  if (!campaignId) throw new Error("watcher requires --campaign");
  const stateDir = join(projectRoot, ".autoresearch");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const store = Store.open(join(stateDir, "state.sqlite"));
  const memory = GlobalMemoryStore.open();
  const dir = watcherDir(stateDir, campaignId);
  mkdirSync(dir, { recursive: true });
  const heartbeat = new ProgressHeartbeat(join(dir, "heartbeat.json"), {
    campaignId, cycleId: "watcher", attemptId: "watcher-daemon",
    processStartId: processStartId(process.pid),
  });
  let signalStop = false;
  process.on("SIGINT", () => { signalStop = true; });
  process.on("SIGTERM", () => { signalStop = true; });
  const stopped = () => signalStop || watcherStopRequested(stateDir, campaignId);

  try {
    for (;;) {
      if (stopped()) break;
      const subscription = readWatcherSubscription(store, campaignId);
      if (!subscription) {
        heartbeat.activity("waiting_external", "watcher disabled; waiting for configuration", null);
        await interruptibleWait(60_000, stopped);
        continue;
      }
      if (subscription.queryStrategy.lifetime === "campaign") {
        const campaign = store.db.prepare("SELECT status FROM campaigns WHERE campaign_id=?")
          .get(campaignId) as { status: string } | undefined;
        if (!campaign || campaign.status !== "running") {
          heartbeat.complete(`campaign-scoped watcher exiting because campaign is ${campaign?.status ?? "missing"}`);
          break;
        }
      }
      heartbeat.activity("tool_running", "watcher sweep starting", { kind: "tool", name: "source-sweep" });
      const sweep = await sweepWatcher(store, memory, subscription, heartbeat);
      heartbeat.progress(
        "checkpoint",
        `sweep complete: ${sweep.seen} seen, ${sweep.inserted} new, ${sweep.lowSignal} with no lexical overlap, ${sweep.failures} provider failures`,
        null,
      );
      const backlog = watcherSourceBacklog(store, campaignId, sweep.sourceVersionIds);
      if (backlog.length > 0) {
        heartbeat.activity("model_wait", "enriching new source batch with Ox Alpha", { kind: "model", name: "stealth/ox-alpha" });
        // Enrichment is an optional layer over durable raw ingestion, but an
        // exception from it used to escape and end the watcher entirely: every
        // sweep died on a malformed model reply, so the campaign ran for days
        // with no source ever read. Contain it to the batch it belongs to.
        try {
          const enriched = await enrichWatcherSources(store, memory, {
            campaignId, projectRoot, sourceVersionIds: backlog,
          });
          if (enriched.deferred) {
            heartbeat.activity("waiting_external", "Ox enrichment quota unavailable; raw memory is safely stored", null);
          } else {
            heartbeat.progress("checkpoint", `enrichment: ${enriched.enriched} mechanisms, ${enriched.ideas} ideas`, null);
          }
        } catch (error) {
          heartbeat.activity("checkpoint",
            `enrichment batch failed, raw sources remain stored: ${String(error).slice(0, 300)}`, null);
        }
      }
      heartbeat.activity(
        "waiting_external", `next watcher sweep in ${subscription.intervalSeconds}s`, null,
      );
      await interruptibleWait(subscription.intervalSeconds * 1000, stopped);
    }
    heartbeat.complete("watcher stopped cleanly");
  } catch (error) {
    heartbeat.fail(String(error));
    throw error;
  } finally {
    memory.close();
    store.close();
    clearWatcherRun(stateDir, campaignId);
  }
}

void main().catch((error) => {
  console.error(`watcher failed: ${String(error)}`);
  process.exitCode = 1;
});
