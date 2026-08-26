/**
 * One-shot local research error monitor.
 *
 * This command is intentionally observational: it reads the campaign state,
 * reports failures from a recent window, and never interrupts a worker.
 * A scheduler (or an operator) can invoke it periodically.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { inspect, processStartId } from "./daemon.js";
import { assessHeartbeat, readHeartbeat, type HeartbeatSnapshot } from "./supervision/progress-heartbeat.js";
import { canonicalJson, latestCampaignId, sha256 } from "./store/store.js";

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, ".autoresearch");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numberArg(name: string, fallback: number): number {
  const value = Number(arg(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function campaignHeartbeats(campaignId: string): HeartbeatSnapshot[] {
  const root = join(STATE_DIR, "attempts");
  if (!existsSync(root)) return [];
  const candidates: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === "heartbeat.json") candidates.push(full);
    }
  };
  visit(root);
  return candidates
    .map(readHeartbeat)
    .filter((h): h is HeartbeatSnapshot => Boolean(h?.campaignId === campaignId))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
}

/** Worst state first: a stuck worker must outrank a healthy sibling. */
const HEALTH_RANK: Record<string, number> = {
  review_due: 4, failed: 3, slow: 2, healthy: 1, completed: 0,
};

/**
 * Assess every worker that is still alive rather than only the most recently
 * observed heartbeat. Short-lived helpers (watchers, evaluators) finish and
 * refresh their heartbeat constantly; picking the newest one hid a stuck
 * executor whose heartbeat had frozen hours earlier. Heartbeats whose owning
 * process is gone are skipped: those are orphans of an earlier run, not a
 * live stall.
 */
function assessLiveWorkers(campaignId: string) {
  const assessments = campaignHeartbeats(campaignId)
    .filter((heartbeat) => !["completed", "failed"].includes(heartbeat.phase))
    .map((heartbeat) => {
      const workerStart = processStartId(heartbeat.pid);
      const processAlive = workerStart !== null
        && (!heartbeat.processStartId || workerStart === heartbeat.processStartId);
      return { heartbeat, processAlive, assessment: assessHeartbeat(heartbeat, { processAlive, operationAlive: null }) };
    })
    .filter((entry) => entry.processAlive)
    .sort((a, b) => (HEALTH_RANK[b.assessment.state] ?? 0) - (HEALTH_RANK[a.assessment.state] ?? 0));
  return assessments[0] ?? null;
}

function main(): void {
  const campaignId = arg("--campaign") ?? process.env.AR_CAMPAIGN ?? latestCampaignId();
  const windowMinutes = numberArg("--window-minutes", 30);
  const now = Date.now();
  const since = new Date(now - windowMinutes * 60_000).toISOString();
  // Never open the writer/migration path from a monitor. A campaign may hold
  // a write transaction; monitoring must remain bounded and observational.
  const db = new Database(join(STATE_DIR, "state.sqlite"), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 250");

  const campaign = db.prepare(
    "SELECT status, stop_reason FROM campaigns WHERE campaign_id=?",
  ).get(campaignId) as { status: string; stop_reason: string | null } | undefined;
  const failures = db.prepare(
    `SELECT a.attempt_id, r.kind, r.idempotency_key, a.failure_code,
            a.started_at, a.completed_at
       FROM attempts a JOIN runs r ON r.run_id=a.run_id
      WHERE r.campaign_id=? AND a.failure_code IS NOT NULL
        AND COALESCE(a.completed_at, a.started_at) >= ?
      ORDER BY COALESCE(a.completed_at, a.started_at) ASC`,
  ).all(campaignId, since) as Array<{
    attempt_id: string; kind: string; idempotency_key: string; failure_code: string;
    started_at: string; completed_at: string | null;
  }>;
  const active = db.prepare(
    `SELECT r.kind, r.idempotency_key, a.attempt_id, a.started_at
       FROM attempts a JOIN runs r ON r.run_id=a.run_id
      WHERE r.campaign_id=? AND a.state='running'
      ORDER BY a.started_at DESC`,
  ).all(campaignId) as Array<{ kind: string; idempotency_key: string; attempt_id: string; started_at: string }>;
  const chainOk = verifyEventChain(db);
  db.close();

  const live = inspect(STATE_DIR);
  const worst = live.state === "running" ? assessLiveWorkers(campaignId) : null;
  let health = "not_running";
  if (worst) health = worst.assessment.state;
  else if (live.state === "running") health = "running_between_operations";

  // A stalled worker is an error the operator has to see. Reporting OK while a
  // cycle sat wedged on a blocked child process is what let one run idle for
  // hours unnoticed.
  const stalled = worst !== null && ["review_due", "failed"].includes(worst.assessment.state);
  const status = failures.length || !chainOk || stalled ? "ERROR" : "OK";
  const lines = [
    `[${new Date(now).toISOString()}] ${status} campaign=${campaignId}`,
    `  status=${campaign?.status ?? "missing"} health=${health} active_attempts=${active.length} window=${windowMinutes}m`,
    `  failures=${failures.length} event_chain=${chainOk ? "ok" : "BROKEN"}`,
  ];
  if (worst) {
    lines.push(`  worker=${worst.heartbeat.attemptId ?? worst.heartbeat.cycleId ?? worst.heartbeat.pid} phase=${worst.heartbeat.phase} :: ${worst.assessment.reason}`);
    if (worst.heartbeat.operation) {
      lines.push(`  operation=${worst.heartbeat.operation.kind}:${worst.heartbeat.operation.name} pid=${worst.heartbeat.operation.pid ?? "n/a"}`);
    }
  }
  for (const failure of failures) {
    lines.push(`  - ${failure.completed_at ?? failure.started_at} ${failure.kind} ${failure.idempotency_key} :: ${failure.failure_code}`);
  }
  if (campaign?.stop_reason) lines.push(`  stop_reason=${campaign.stop_reason}`);
  const output = lines.join("\n");
  console.log(output);

  const logDir = join(STATE_DIR, "logs");
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `error-monitor-${campaignId}.log`), `${output}\n`, "utf8");
  process.exitCode = status === "ERROR" ? 1 : 0;
}

function verifyEventChain(db: Database.Database): boolean {
  const rows = db.prepare(
    `SELECT seq, event_id, occurred_at, campaign_id, aggregate_kind, aggregate_id,
            aggregate_revision, event_type, actor_kind, attempt_id, idempotency_key,
            payload_json, payload_hash, prev_chain_hash, chain_hash, schema_version
       FROM events ORDER BY seq ASC`,
  ).all() as Array<Record<string, any>>;
  let previous: string | null = null;
  for (const row of rows) {
    if ((row.prev_chain_hash ?? null) !== previous) return false;
    if (sha256(row.payload_json) !== row.payload_hash) return false;
    const framed = canonicalJson({
      eventId: row.event_id, occurredAt: row.occurred_at, campaignId: row.campaign_id,
      aggregateKind: row.aggregate_kind, aggregateId: row.aggregate_id,
      aggregateRevision: row.aggregate_revision, eventType: row.event_type,
      actorKind: row.actor_kind, attemptId: row.attempt_id ?? null,
      idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash,
      schemaVersion: row.schema_version,
    });
    if (sha256(`${previous ?? "0".repeat(64)}${framed}`) !== row.chain_hash) return false;
    previous = row.chain_hash;
  }
  return true;
}

main();
