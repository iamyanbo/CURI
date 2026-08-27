/**
 * Keeping the published record level with the live one.
 *
 * `research publish` is a one-shot: it snapshots the record at the moment it is
 * invoked. That made the public mirror silently wrong rather than merely stale —
 * a snapshot taken during a pause showed a paused direction for as long as
 * nobody re-ran the command, so a reader could not tell a finished direction
 * from an un-republished one.
 *
 * The record is therefore republished from the supervisor itself, on a timer,
 * whenever the direction has actually changed. Publishing is skipped entirely
 * when no event has been appended since the last one, so a quiet direction costs
 * nothing, and a failure to reach Firestore is logged and retried at the next
 * tick rather than being allowed to end the research run.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { statePath } from "./paths.js";

import { buildPublishedRecord } from "./publish.js";
import { publishToFirestore } from "./mirror.js";
import { ResearchStore, researchNow } from "./store.js";

const DEFAULT_INTERVAL_SECONDS = 120;
/** Consecutive failures after which publishing gives up rather than retrying forever. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** The project the record is published to, or null when publishing is not configured. */
export function mirrorProjectId(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.AR_MIRROR_SYNC ?? "").trim().toLowerCase() === "off") return null;
  const project = env.AR_PUBLISH_PROJECT?.trim() || env.GOOGLE_CLOUD_PROJECT?.trim()
    || env.GCLOUD_PROJECT?.trim();
  return project || null;
}

export function mirrorSyncIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.AR_MIRROR_SYNC_SECONDS ?? DEFAULT_INTERVAL_SECONDS);
  return Math.max(30, Number.isFinite(seconds) ? seconds : DEFAULT_INTERVAL_SECONDS) * 1_000;
}

export function latestEventSeq(store: ResearchStore, directionId: string): number {
  return Number((store.db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM events WHERE direction_id=?")
    .get(directionId) as { seq: number }).seq);
}

/**
 * Publishes once if anything changed. Returns the sequence number now published,
 * or the one passed in when there was nothing to do or the attempt failed —
 * a failed publish must not advance the watermark, or the change it missed would
 * never be sent.
 */
export async function syncMirrorOnce(input: {
  projectRoot: string; directionId: string; databaseId?: string;
  since: number; projectId: string; log: (line: string) => void;
}): Promise<number> {
  // Opening the store was outside the guard, so a failure here escaped as an
  // unhandled rejection instead of being reported as a failed sync.
  let store;
  try { store = ResearchStore.open(statePath(input.projectRoot, "research.sqlite")); }
  catch (error) {
    input.log(`mirror sync could not open the store: ${String(error)}`);
    return input.since;
  }
  let record;
  let seq = input.since;
  try {
    seq = latestEventSeq(store, input.directionId);
    if (seq <= input.since) return input.since;
    record = buildPublishedRecord(store, input.directionId, input.projectRoot,
      { includeToolOutput: (process.env.AR_PUBLISH_TOOL_OUTPUT ?? "").trim() === "1",
        includeTrace: (process.env.AR_PUBLISH_TRACE ?? "").trim().toLowerCase() !== "off" });
  } catch (error) {
    input.log(`mirror sync could not build the record: ${String(error)}`);
    return input.since;
  } finally { store.close(); }

  try {
    const result = await publishToFirestore({ record, projectId: input.projectId,
      databaseId: input.databaseId });
    input.log(`mirror sync published ${result.documents} documents at event ${seq}`);
    return seq;
  } catch (error) {
    // Credentials, quota and network all land here. The watermark stays where it
    // was so the next tick republishes the same change.
    input.log(`mirror sync failed, will retry: ${String(error)}`);
    return input.since;
  }
}

/**
 * Republishes the record for as long as the supervisor runs. Returns a function
 * that stops the timer and publishes one last time, so the record the mirror
 * serves after a run ends is the state the run actually ended in.
 */
export function startMirrorSync(input: {
  projectRoot: string; directionId: string; databaseId?: string;
}): () => Promise<void> {
  const projectId = mirrorProjectId();
  if (!projectId) return async () => {};

  const logPath = statePath(input.projectRoot, `research-supervisor-${input.directionId}.log`);
  const log = (line: string) => {
    try { appendFileSync(logPath, `${researchNow()} ${line}\n`, "utf8"); } catch { /* logging is best effort */ }
  };

  let since = -1;
  let running = false;
  let failures = 0;
  let stopped = false;
  const tick = async () => {
    // Firestore round trips can outlast the interval; overlapping publishes
    // would race on the same documents, so a tick that arrives while one is in
    // flight is dropped rather than queued.
    if (running || stopped) return;
    running = true;
    try {
      const advanced = await syncMirrorOnce({ ...input, since, projectId, log });
      failures = advanced > since ? 0 : failures;
      since = advanced;
    } catch (error) {
      // Publishing is optional telemetry. Whatever it does, it must not be able
      // to end a research run — a missing credential once killed a supervisor
      // through an unhandled rejection raised after the failure was caught.
      failures += 1;
      log(`mirror sync error (${failures}): ${String(error)}`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        stopped = true;
        clearInterval(timer);
        log("mirror sync disabled after repeated failures; research continues unpublished. "
          + "Check credentials (ADC or a service account) and restart to re-enable it.");
      }
    } finally { running = false; }
  };

  log(`mirror sync enabled for project ${projectId} every ${mirrorSyncIntervalMs() / 1_000}s`);
  const timer = setInterval(() => { void tick(); }, mirrorSyncIntervalMs());
  timer.unref();
  void tick();

  return async () => {
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 200));
    await tick();
  };
}
