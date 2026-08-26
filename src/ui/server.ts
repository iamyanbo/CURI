/**
 * Read-only dashboard server.
 *
 * Read-only against the EVIDENCE, with narrow, explicit operator controls.
 *
 * SQLite is opened `readonly: true`, so nothing served here can alter a result,
 * a verdict, a threshold or the event log. The trust boundary requires that an
 * observation surface must not become part of the control plane, and that still
 * holds for everything that decides what is true.
 *
 * `POST /api/steer` records either a one-cycle micro note or a durable macro
 * steer in the hash-chained operator log. The campaign consumes it only at a
 * safe cycle boundary. `POST /api/stop` writes the normal stop request. Neither
 * control can alter evidence, thresholds, verdicts, or the protected evaluator.
 *
 * This is written down rather than quietly done because the header previously
 * claimed "a viewer cannot steer", and a comment that overstates a guarantee is
 * the exact failure this project exists to avoid.
 *
 * Everything it serves is derived from the canonical event log and tables, so
 * the dashboard cannot show anything the evidence does not support.
 */

import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { latestCampaignId, normaliseCampaignConfig, Store } from "../store/store.js";
import {
  clearSteer, pendingSteer, requestAttentionSteer, requestSteer, withdrawAttentionSteers,
  type AttentionSteerScope,
} from "../steer.js";
import { clearStopRequest, detach, inspect, requestStop } from "../daemon.js";
import { inspectWatcher } from "../watcher/control.js";
import { assessSourceRelevance } from "../watcher/relevance.js";
import { defaultMemoryPath } from "../memory/store.js";
import {
  categoryForTool,
  segmentAgentTrace,
  sumSegments,
  type TimedTraceStep,
  type TraceSegment,
  type UiTimeCategory,
} from "./telemetry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const DB_PATH = join(ROOT, ".autoresearch", "state.sqlite");
const STATE_DIR = join(ROOT, ".autoresearch");
const PORT = Number(process.env.AR_UI_PORT ?? 4791);
// No hardcoded campaign. A tool pointed at the wrong campaign reports the
// wrong campaign's state, which is worse than reporting nothing: the
// heartbeat once watched `tinyml-001` while `cuda-001` was the live run.
const PINNED_CAMPAIGN = process.env.AR_CAMPAIGN?.trim() || null;
const liveClients = new Set<ServerResponse>();

function db(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

/**
 * Follow the newest running campaign unless the operator explicitly pins one.
 * A dashboard process commonly outlives a campaign; resolving this per request
 * prevents a server started yesterday from showing yesterday's pipeline today.
 */
function campaignId(d: Database.Database): string {
  if (PINNED_CAMPAIGN) return PINNED_CAMPAIGN;
  const row = d.prepare(
    `SELECT campaign_id FROM campaigns
     ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
  ).get() as { campaign_id: string } | undefined;
  return row?.campaign_id ?? latestCampaignId(DB_PATH);
}

function metricInfo(d: Database.Database, selectedCampaign: string): {
  name: string; direction: "minimize" | "maximize"; secondaryLabel: string; hasSecondary: boolean;
} {
  const row = d.prepare("SELECT config_json FROM campaigns WHERE campaign_id=?")
    .get(selectedCampaign) as { config_json: string } | undefined;
  try {
    const cfg = normaliseCampaignConfig(row?.config_json ?? "{}");
    const configured = String(cfg.domain ?? "");
    const path = configured.endsWith(".json") ? join(ROOT, configured) : "";
    if (path && existsSync(path)) {
      const domain = JSON.parse(readFileSync(path, "utf8"));
      return {
        name: String(domain.metric?.name ?? "primary metric"),
        direction: domain.metric?.direction === "maximize" ? "maximize" : "minimize",
        secondaryLabel: domain.id === "attention" ? "hidden-shape checks" : "holdout",
        // The CUDA attention evaluator has pass/fail correctness gates, not a
        // second scalar. Showing the launcher's placeholder zero as a measured
        // holdout was both confusing and factually wrong.
        hasSecondary: domain.id !== "attention",
      };
    }
  } catch { /* use generic labels */ }
  return {
    name: "primary metric", direction: "minimize", secondaryLabel: "holdout", hasSecondary: true,
  };
}

function readAgentTrace(d: Database.Database, attemptId: string): TimedTraceStep[] {
  const art = d.prepare(
    `SELECT relative_path FROM artifacts WHERE attempt_id = ? AND kind = 'agent-trace' LIMIT 1`,
  ).get(attemptId) as { relative_path: string } | undefined;
  if (!art) return [];
  try {
    const raw = readFileSync(join(ROOT, ".autoresearch", "artifacts", art.relative_path), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TimedTraceStep);
  } catch {
    return [];
  }
}

function readStageLogs(d: Database.Database, attemptId: string): Array<{ kind: string; content: string; sealedAt: string }> {
  const rows = d.prepare(
    `SELECT kind, relative_path, byte_length, sealed_at FROM artifacts
     WHERE attempt_id = ? AND kind IN ('run-stdout','evaluation','candidate-diff','experiment-output')
     ORDER BY sealed_at`,
  ).all(attemptId) as Array<{ kind: string; relative_path: string; byte_length: number; sealed_at: string }>;
  const logs: Array<{ kind: string; content: string; sealedAt: string }> = [];
  for (const row of rows) {
    try {
      const bytes = readFileSync(join(ROOT, ".autoresearch", "artifacts", row.relative_path));
      const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
      const binary = sample.includes(0);
      const content = binary
        ? `[binary artifact · ${row.byte_length.toLocaleString()} bytes]`
        : bytes.toString("utf8");
      logs.push({
        kind: row.kind,
        content: content.length > 80_000 ? `${content.slice(0, 80_000)}\n…[truncated]` : content,
        sealedAt: row.sealed_at,
      });
    } catch { /* an unreadable artifact is omitted, never invented */ }
  }
  return logs;
}

function readProvisionalTrace(idempotencyKey: string, kind: string): TimedTraceStep[] {
  const match = idempotencyKey.match(/^(architect|manager|executor):([^:]+):(\d+)$/);
  if (!match || (match[1] !== kind && !(match[1] === "architect" && kind === "manager"))) return [];
  const attemptNo = Number(match[3]);
  const logicalKind = match[1]!;
  const dir = attemptNo === 1 ? logicalKind : `${logicalKind}-retry-${attemptNo}`;
  const path = join(ROOT, ".autoresearch", "attempts", match[2]!, dir, "trace.jsonl");
  if (existsSync(path)) {
    try {
      return readFileSync(path, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as TimedTraceStep);
    } catch { return []; }
  }
  return [];
}

/**
 * The experiment tree.
 *
 * The campaign really is a tree, and this is its shape: the trunk is the chain
 * of baseline advances (each a validated, reproduced improvement), and every
 * hypothesis hangs off the baseline that was current when it was proposed.
 * Branches that died are kept — refutations, invalid implementations and caught
 * cheats are the majority of the tree and the part a keep/revert loop throws
 * away.
 */
function buildTree(d: Database.Database) {
  const campaign = campaignId(d);
  // The judge's own sentence for each claim. Without it the tree shows a status
  // word and an id - "refuted / falsify / mechanism / H-6c5e8b30" - which says
  // what happened and nothing about why. The reason exists; it was not reaching
  // anyone.
  const reasons = new Map<string, string>();
  for (const e of d.prepare(
    `SELECT aggregate_id, payload_json FROM events
     WHERE campaign_id = ? AND event_type = 'claim.judged' ORDER BY seq`,
  ).all(campaign) as Array<{ aggregate_id: string; payload_json: string }>) {
    try {
      const p = JSON.parse(e.payload_json);
      if (p.explanation) reasons.set(e.aggregate_id, String(p.explanation));
    } catch { /* skip */ }
  }
  // Why a hypothesis never got a verdict at all.
  const aborts = new Map<string, string>();
  for (const e of d.prepare(
    `SELECT payload_json FROM events WHERE campaign_id = ? AND event_type = 'cycle.aborted' ORDER BY seq`,
  ).all(campaign) as Array<{ payload_json: string }>) {
    try {
      const p = JSON.parse(e.payload_json);
      if (p.reason) aborts.set(String(p.reason), String(p.reason));
    } catch { /* skip */ }
  }

  const advances = d.prepare(
    `SELECT occurred_at, payload_json FROM events
     WHERE campaign_id = ? AND event_type = 'baseline.advanced' ORDER BY seq`,
  ).all(campaign) as Array<{ occurred_at: string; payload_json: string }>;

  const trunk = advances.map((a, i) => {
    const p = JSON.parse(a.payload_json);
    return {
      index: i + 1,
      at: a.occurred_at,
      from: p.from as string,
      to: p.to as string,
      hypothesisId: p.hypothesisId as string,
      primary: p.newBaselineBpc as number | null,
      byOperator: Boolean(p.byOperator),
    };
  });

  const hypotheses = d.prepare(
    `SELECT h.hypothesis_id, h.lane, h.title, h.status, h.change_class, h.belief_derived,
            h.created_at, h.updated_at, h.steps_allowed,
            ct.baseline_hash, ct.threshold_json,
            e.primary_value, e.baseline_value, e.result_json
     FROM hypotheses h
     LEFT JOIN contracts ct ON ct.hypothesis_id = h.hypothesis_id
     LEFT JOIN evaluations e ON e.contract_id = ct.contract_id
     WHERE h.campaign_id = ?
     GROUP BY h.hypothesis_id
     ORDER BY h.created_at`,
  ).all(campaign) as any[];

  const nodes = hypotheses.map((h) => {
    let holdout: number | null = null;
    try {
      const raw = JSON.parse(h.result_json ?? "{}");
      holdout = typeof raw.secondary === "number"
        ? raw.secondary : raw.metrics?.holdout_bpc ?? null;
    } catch { /* absent */ }
    const evidence = d.prepare(
      `SELECT kind, polarity, statement FROM evidence WHERE hypothesis_id = ? ORDER BY created_at`,
    ).all(h.hypothesis_id) as Array<{ kind: string; polarity: string; statement: string }>;
    return {
      id: h.hypothesis_id,
      lane: h.lane,
      title: h.title,
      status: h.status,
      // Plain language: what happened, and why.
      reason: reasons.get(h.hypothesis_id)
        ?? (h.status === "proposed"
              ? "This hypothesis was registered but never measured - the cycle ended before an "
                + "experiment produced a result, usually because the executor made no change or a "
                + "worker failed. It is not a finding either way."
              : null),
      changeClass: h.change_class,
      belief: h.belief_derived,
      stepsAllowed: h.steps_allowed ?? 1,
      baseRevision: h.baseline_hash as string | null,
      primary: h.primary_value as number | null,
      baseline: h.baseline_value as number | null,
      holdout,
      createdAt: h.created_at,
      // A caught cheat is evidence, and the most interesting thing on screen.
      cheat: evidence.some((e) => e.kind === "shortcut"),
      evidence,
    };
  });

  return { trunk, nodes };
}

/** Progress: how much better each validated advance actually made things. */
function buildProgress(d: Database.Database) {
  const campaign = campaignId(d);
  const metric = metricInfo(d, campaign);
  const rows = d.prepare(
    `SELECT h.hypothesis_id, h.title, h.lane, h.updated_at,
            e.primary_value, e.baseline_value, e.result_json
     FROM hypotheses h
     JOIN contracts ct ON ct.hypothesis_id = h.hypothesis_id
     JOIN evaluations e ON e.contract_id = ct.contract_id
     WHERE h.campaign_id = ? AND h.status = 'replicated'
     GROUP BY h.hypothesis_id ORDER BY h.updated_at`,
  ).all(campaign) as any[];

  return rows.map((r, i) => {
    let holdout: number | null = null;
    try {
      const raw = JSON.parse(r.result_json ?? "{}");
      holdout = typeof raw.secondary === "number"
        ? raw.secondary : raw.metrics?.holdout_bpc ?? null;
    } catch { /* absent */ }
    return {
      step: i + 1,
      id: r.hypothesis_id,
      title: r.title,
      lane: r.lane,
      primary: r.primary_value,
      baseline: r.baseline_value,
      holdout,
      gain: r.baseline_value !== null
        ? (metric.direction === "maximize"
            ? r.primary_value - r.baseline_value : r.baseline_value - r.primary_value)
        : null,
    };
  });
}

/** The trajectory: everything that happened, in order, as the harness recorded it. */
function buildTrace(d: Database.Database, limit: number, offset: number) {
  const campaign = campaignId(d);
  const rows = d.prepare(
    `SELECT seq, occurred_at, event_type, actor_kind, aggregate_kind, aggregate_id, payload_json
     FROM events WHERE campaign_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
  ).all(campaign, limit, offset) as any[];
  return rows.map((r) => ({
    seq: r.seq, at: r.occurred_at, type: r.event_type, actor: r.actor_kind,
    subject: `${r.aggregate_kind}:${String(r.aggregate_id).slice(0, 12)}`,
    payload: JSON.parse(r.payload_json),
  }));
}

function sourceMetadata(row: { metadata_json?: string }): Record<string, any> {
  try { return JSON.parse(row.metadata_json ?? "{}"); }
  catch { return {}; }
}

function campaignSourceTopics(d: Database.Database, campaign: string): string[] {
  const topics: string[] = [];
  const subscription = d.prepare(
    "SELECT topics_json FROM watcher_subscriptions WHERE campaign_id=?",
  ).get(campaign) as { topics_json: string } | undefined;
  try { topics.push(...JSON.parse(subscription?.topics_json ?? "[]")); } catch { /* none */ }
  const plan = d.prepare(
    `SELECT payload_json FROM events WHERE campaign_id=? AND event_type='architect.plan_registered'
     ORDER BY seq DESC LIMIT 1`,
  ).get(campaign) as { payload_json: string } | undefined;
  try {
    const strategy = JSON.parse(plan?.payload_json ?? "{}")?.plan?.program?.watch_strategy ?? {};
    for (const key of ["core_topics", "adjacent_domains", "enabling_disciplines", "bottlenecks"]) {
      const values = strategy[key];
      if (Array.isArray(values)) topics.push(...values.map(String));
    }
  } catch { /* none */ }
  return [...new Set(topics.map((topic) => String(topic).trim()).filter(Boolean))];
}

function sourceRowIsRelevant(
  row: { provider?: string; title?: string; canonical_url?: string; metadata_json?: string },
  validatedWatcherUrls: Set<string> = new Set(),
): boolean {
  const meta = sourceMetadata(row);
  if (String(row.provider ?? "").startsWith("agent:") || meta.tool) return true;
  const topic = String(meta.topic ?? "").trim();
  const source = { title: row.title ?? "", abstract: String(meta.abstract ?? "") };
  // Legacy watcher rows did not record the exact query that admitted them, so
  // they cannot be audited reliably and must not be presented as evidence.
  if (!topic || !assessSourceRelevance(topic, source).keep) return false;
  // Provider search is only candidate generation. The public UI gets the row
  // after the linked page was fetched and content enrichment marked it useful.
  return validatedWatcherUrls.has(String(row.canonical_url ?? ""));
}

function validatedWatcherUrls(d: Database.Database, campaign: string): Set<string> {
  const ids = (d.prepare(
    `SELECT e.source_version_id
       FROM campaign_source_enrichments e
       JOIN campaign_memory_links l
         ON l.campaign_id=e.campaign_id AND l.memory_kind='source'
        AND l.memory_id=e.source_version_id
      WHERE e.campaign_id=? AND e.status='succeeded' AND l.relevance>=0.55`,
  ).all(campaign) as Array<{ source_version_id: string }>).map((row) => row.source_version_id);
  if (ids.length === 0 || !existsSync(defaultMemoryPath())) return new Set();
  let memory: Database.Database | null = null;
  try {
    memory = new Database(defaultMemoryPath(), { readonly: true, fileMustExist: true });
    const get = memory.prepare(
      "SELECT canonical_url FROM source_versions WHERE source_version_id=?",
    );
    return new Set(ids.flatMap((id) => {
      const row = get.get(id) as { canonical_url: string } | undefined;
      return row?.canonical_url ? [row.canonical_url] : [];
    }));
  } catch {
    return new Set();
  } finally {
    memory?.close();
  }
}

/**
 * Every source the campaign has touched, grouped by where it came from.
 *
 * `agent:manager` and `agent:executor` are URLs a subagent actually read during
 * a cycle; `arxiv`, `github`, `hackernews` are scout sweeps. Keeping them in one
 * list, labelled by origin, is the point: a claim's provenance includes what the
 * agent consulted before proposing it, and that was previously buried inside a
 * trace artifact where nobody would look.
 */
function buildSources(d: Database.Database) {
  const campaign = campaignId(d);
  const validatedUrls = validatedWatcherUrls(d, campaign);
  const rows = (d.prepare(
    `SELECT provider, title, canonical_url, retrieved_at, source_class, reliability, metadata_json
     FROM sources WHERE campaign_id = ? ORDER BY provider, retrieved_at DESC`,
  ).all(campaign) as any[]).filter((row) => sourceRowIsRelevant(row, validatedUrls));

  const groups: Record<string, any[]> = {};
  for (const r of rows) {
    const meta = sourceMetadata(r);
    (groups[r.provider] ??= []).push({
      title: r.title, url: r.canonical_url, at: r.retrieved_at,
      sourceClass: r.source_class, reliability: r.reliability,
      tool: meta.tool ?? null, hypothesis: meta.hypothesis ?? null,
      topic: meta.topic ?? null,
    });
  }
  return {
    total: rows.length,
    groups: Object.entries(groups)
      .map(([provider, items]) => ({ provider, count: items.length, items }))
      .sort((a, b) => b.count - a.count),
  };
}

function buildSummary(d: Database.Database) {
  const selectedCampaign = campaignId(d);
  const campaign = d.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").get(selectedCampaign) as any;
  const statuses = d.prepare(
    "SELECT status, COUNT(*) AS n FROM hypotheses WHERE campaign_id = ? GROUP BY status",
  ).all(selectedCampaign) as Array<{ status: string; n: number }>;
  const lanes = d.prepare(
    "SELECT lane, consumed, allocated FROM budgets WHERE campaign_id = ? AND category='runs' ORDER BY lane",
  ).all(selectedCampaign) as any[];
  // The model actually in use, read from the last recorded attempt rather than
  // from configuration. A campaign silently ran ~30 cycles on a provider
  // default after a relaunch dropped the model flag, and nothing on screen said
  // so. What the run IS using belongs on the dashboard.
  const modelRow = d.prepare(
    `SELECT a.model_spec_json FROM attempts a JOIN runs r ON r.run_id=a.run_id
     WHERE r.campaign_id=? AND a.model_spec_json IS NOT NULL
     ORDER BY a.rowid DESC LIMIT 1`,
  ).get(selectedCampaign) as { model_spec_json: string } | undefined;
  let model = "unknown";
  try {
    const m = JSON.parse(modelRow?.model_spec_json ?? "{}");
    model = m.provider ? `${m.provider}/${m.model}` : String(m.model ?? "unknown");
  } catch { /* leave unknown */ }

  const recentInterventions = d.prepare(
    `SELECT kind, detail, changed_frontier, occurred_at FROM human_interventions
     WHERE campaign_id = ? ORDER BY occurred_at DESC LIMIT 8`,
  ).all(selectedCampaign) as any[];
  const validatedSourceUrls = validatedWatcherUrls(d, selectedCampaign);

  // A spread across providers, not just whichever one swept most recently.
  // Ordering purely by time showed eight GitHub rows and hid 38 arXiv preprints,
  // which made the scout look like a repo crawler.
  const leadCandidates = d.prepare(
    `SELECT provider, title, canonical_url, retrieved_at, metadata_json FROM (
       SELECT provider, title, canonical_url, retrieved_at, metadata_json,
              ROW_NUMBER() OVER (PARTITION BY provider ORDER BY retrieved_at DESC) AS rn
       FROM sources WHERE campaign_id = ? AND reliability = 'lead')
     WHERE rn <= 16 ORDER BY rn, retrieved_at DESC`,
  ).all(selectedCampaign) as any[];
  const providerLeadCounts = new Map<string, number>();
  const leads = leadCandidates.filter((row) => {
    if (!sourceRowIsRelevant(row, validatedSourceUrls)) return false;
    const count = providerLeadCounts.get(row.provider) ?? 0;
    if (count >= 4) return false;
    providerLeadCounts.set(row.provider, count + 1);
    return true;
  });

  // Wall time from the campaign's own first and last recorded events, so it
  // reflects the run rather than the age of the row.
  const span = d.prepare(
    `SELECT MIN(occurred_at) AS a, MAX(occurred_at) AS b FROM events WHERE campaign_id = ?`,
  ).get(selectedCampaign) as { a: string | null; b: string | null };
  const elapsedMs = span?.a
    ? Math.max(0, (campaign?.status === "running" ? Date.now() : Date.parse(span.b ?? span.a)) - Date.parse(span.a))
    : 0;

  const wallEndMs = campaign?.status === "running"
    ? Date.now() : Date.parse(span.b ?? span.a ?? new Date().toISOString());
  const rawIntervals = d.prepare(
    `SELECT category, SUM(MAX(0, COALESCE(ended_ms, ?) - started_ms)) AS ms
     FROM intervals WHERE campaign_id = ? AND resource_id = 'campaign' GROUP BY category`,
  ).all(wallEndMs, selectedCampaign) as Array<{ category: string; ms: number }>;

  // The campaign recorder historically wrapped a whole worker process in one
  // `model_reasoning` interval. Subtract paired tool spans from that bucket so
  // shell commands and other tools are visible as their own costs. This is an
  // evidence-backed correction: every moved millisecond comes from timestamps
  // in a sealed agent trace, and the grand total remains unchanged.
  const intervalTotals: Record<string, number> = Object.fromEntries(
    rawIntervals.map((row) => [row.category, Number(row.ms ?? 0)]),
  );
  const agentAttempts = d.prepare(
    `SELECT a.attempt_id, a.started_at, a.completed_at, a.state, a.failure_code
     FROM attempts a JOIN runs r ON r.run_id = a.run_id
     WHERE r.campaign_id = ? AND r.kind IN ('manager','executor')
       AND a.started_at IS NOT NULL AND a.completed_at IS NOT NULL`,
  ).all(selectedCampaign) as Array<{
    attempt_id: string; started_at: string; completed_at: string;
    state: string; failure_code: string | null;
  }>;
  let tracedModelMs = 0;
  let failedModelMs = 0;
  let tracedToolMs = 0;
  for (const attempt of agentAttempts) {
    const duration = Math.max(0, Date.parse(attempt.completed_at) - Date.parse(attempt.started_at));
    const totals = sumSegments(segmentAgentTrace(readAgentTrace(d, attempt.attempt_id), duration));
    const modelMs = totals.model_reasoning ?? 0;
    if (attempt.state === "failed" || attempt.failure_code) failedModelMs += modelMs;
    else tracedModelMs += modelMs;
    for (const category of ["tool_execution", "command_execution"] as const) {
      const ms = totals[category] ?? 0;
      intervalTotals[category] = (intervalTotals[category] ?? 0) + ms;
      tracedToolMs += ms;
    }
  }
  const oldModelBracket = intervalTotals.model_reasoning ?? 0;
  intervalTotals.model_reasoning = tracedModelMs;
  intervalTotals.error = (intervalTotals.error ?? 0) + failedModelMs;
  // Prompt assembly, response validation and retry setup happened inside the
  // old coarse bracket but outside the worker attempts. They belong to the
  // harness/supervisor, not to the model.
  const harnessOverhead = Math.max(0, oldModelBracket - tracedModelMs - failedModelMs - tracedToolMs);
  intervalTotals.supervisor = (intervalTotals.supervisor ?? 0) + harnessOverhead;

  // Failed deterministic attempts are also wall time. Reclassify their
  // compute/evaluation duration as error rather than hiding failures inside a
  // successful-looking bucket. This moves time; it never adds it twice.
  const failedDeterministic = d.prepare(
    `SELECT r.kind, SUM(MAX(0, CAST((julianday(a.completed_at)-julianday(a.started_at))*86400000 AS INTEGER))) AS ms
     FROM attempts a JOIN runs r ON r.run_id=a.run_id
     WHERE r.campaign_id=? AND a.completed_at IS NOT NULL
       AND (a.state='failed' OR a.failure_code IS NOT NULL)
       AND r.kind IN ('compute','evaluation','replay') GROUP BY r.kind`,
  ).all(selectedCampaign) as Array<{ kind: string; ms: number }>;
  for (const failed of failedDeterministic) {
    const category = failed.kind === "evaluation" ? "evaluation" : "compute";
    const moved = Math.min(Number(intervalTotals[category] ?? 0), Number(failed.ms ?? 0));
    intervalTotals[category] = Math.max(0, Number(intervalTotals[category] ?? 0) - moved);
    intervalTotals.error = Number(intervalTotals.error ?? 0) + moved;
  }

  // Everything since campaign start must appear somewhere. Gaps include
  // between-cycle idle time, provider cooldowns, startup, and older code paths
  // that did not open an interval. They are visible as idle/unattributed—not
  // silently dropped or mislabelled as model reasoning.
  const attributedMs = Object.values(intervalTotals).reduce((sum, value) => sum + Number(value || 0), 0);
  intervalTotals.idle = Math.max(0, elapsedMs - attributedMs);
  const intervals = Object.entries(intervalTotals)
    .filter(([, ms]) => Number(ms) > 0)
    .map(([category, ms]) => ({ category, ms }));
  const cost = d.prepare(
    "SELECT COALESCE(SUM(consumed),0) AS c FROM budgets WHERE campaign_id=? AND category='model_cost_usd'",
  ).get(selectedCampaign) as { c: number };
  const interventions = d.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(changed_frontier),0) AS f FROM human_interventions WHERE campaign_id = ?",
  ).get(selectedCampaign) as { n: number; f: number };
  const cheats = d.prepare(
    "SELECT COUNT(*) AS n FROM evidence WHERE campaign_id = ? AND kind = 'shortcut'",
  ).get(selectedCampaign) as { n: number };
  const events = d.prepare("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ?")
    .get(selectedCampaign) as { n: number };

  let cfg: any = {};
  // Through the normaliser: campaigns written before the rename still hold
  // `baselineBpc`, and the dashboard showed "None" for a live 317 GB/s baseline.
  try { cfg = normaliseCampaignConfig(campaign?.config_json ?? "{}"); } catch { /* absent */ }
  const metric = metricInfo(d, selectedCampaign);
  const startingBaseline = Number(cfg.calibration?.mean);

  // Strategic state is part of the pipeline, so surface it alongside the
  // experiment ledger instead of leaving the macro architect, watcher and
  // memory visible only as unlabeled graph nodes.
  const planRow = d.prepare(
    `SELECT occurred_at, payload_json FROM events
     WHERE campaign_id=? AND event_type='architect.plan_registered'
     ORDER BY seq DESC LIMIT 1`,
  ).get(selectedCampaign) as { occurred_at: string; payload_json: string } | undefined;
  let program: Record<string, unknown> | null = null;
  let programTrigger: string | null = null;
  try {
    const payload = JSON.parse(planRow?.payload_json ?? "{}");
    program = payload.plan?.program ?? null;
    programTrigger = payload.trigger ?? null;
  } catch { /* an absent/unreadable plan is reported as pending */ }
  const ideaRows = d.prepare(
    "SELECT state, COUNT(*) AS n FROM idea_cards WHERE campaign_id=? GROUP BY state",
  ).all(selectedCampaign) as Array<{ state: string; n: number }>;
  const subscription = d.prepare(
    `SELECT enabled, interval_seconds, topics_json, query_strategy_json, next_sweep_at
     FROM watcher_subscriptions WHERE campaign_id=?`,
  ).get(selectedCampaign) as {
    enabled: number; interval_seconds: number; topics_json: string;
    query_strategy_json: string; next_sweep_at: string | null;
  } | undefined;
  let watcherTopics: string[] = [];
  let watcherStrategy: Record<string, unknown> = {};
  try { watcherTopics = JSON.parse(subscription?.topics_json ?? "[]"); } catch { /* empty */ }
  try { watcherStrategy = JSON.parse(subscription?.query_strategy_json ?? "{}"); } catch { /* empty */ }
  const retrievals = d.prepare(
    "SELECT COUNT(*) AS n FROM memory_retrievals WHERE campaign_id=?",
  ).get(selectedCampaign) as { n: number };
  const pendingMacroSteers = d.prepare(
    `SELECT steer_id, scope, text, created_at FROM attention_steers
     WHERE campaign_id=? AND consumed_at IS NULL AND scope IN ('macro','all')
     ORDER BY created_at`,
  ).all(selectedCampaign) as Array<{
    steer_id: string; scope: string; text: string; created_at: string;
  }>;
  const currentHypothesis = d.prepare(
    `SELECT hypothesis_id, title, mechanism, motivation, falsifier, lane, status,
            step_index, steps_allowed, created_at
     FROM hypotheses WHERE campaign_id=? ORDER BY created_at DESC LIMIT 1`,
  ).get(selectedCampaign) as Record<string, unknown> | undefined;
  let domainConfig: Record<string, any> = {};
  try {
    const configured = String(cfg.domain ?? "");
    const path = configured.endsWith(".json") ? join(ROOT, configured) : "";
    if (path && existsSync(path)) domainConfig = JSON.parse(readFileSync(path, "utf8"));
  } catch { /* keep the README useful with campaign fields alone */ }
  const objective = String(campaign?.objective ?? "").trim().replace(/[.\s]+$/, "");
  const programTitle = String(program?.title ?? "").trim();
  const liveBaseline = Number(cfg.baselinePrimary);
  const progressSentence = Number.isFinite(startingBaseline) && Number.isFinite(liveBaseline)
    && startingBaseline !== liveBaseline
    ? `Independently replicated changes have moved ${metric.name} from ${startingBaseline.toFixed(3)} to ${liveBaseline.toFixed(3)}.`
    : "No independently replicated baseline improvement has been recorded yet.";
  const researchAbstract = [
    objective ? `This campaign is trying to ${objective.charAt(0).toLowerCase()}${objective.slice(1)}.` : "",
    progressSentence,
    programTitle
      ? `The current plan is “${programTitle}.” It turns that direction into one focused, falsifiable implementation at a time.`
      : "The macro architect has not registered a plan yet.",
    "A change only becomes the new baseline after protected evaluation and independent replication.",
  ].filter(Boolean).join(" ");

  return {
    campaign: campaign?.campaign_id ?? selectedCampaign,
    status: campaign?.status ?? "unknown",
    // Recorded status and a live process are different questions: a campaign
    // killed mid-cycle still reads 'running' in the database. The stop/resume
    // control has to follow the process, not the record.
    live: inspect(STATE_DIR).state,
    model,
    elapsedMs,
    pendingSteer: pendingSteer(STATE_DIR),
    recentInterventions,
    leads,
    stopReason: campaign?.stop_reason ?? null,
    baseRevision: campaign?.base_revision ?? null,
    baselinePrimary: cfg.baselinePrimary ?? null,
    baselineSecondary: metric.hasSecondary ? cfg.baselineSecondary ?? null : null,
    startingBaseline: Number.isFinite(startingBaseline) ? startingBaseline : cfg.baselinePrimary ?? null,
    metric,
    statuses: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
    lanes, intervals,
    intervalAccounting: {
      method: "trace-exclusive",
      wallMs: elapsedMs,
      accountedMs: attributedMs + intervalTotals.idle,
      note: "Reasoning excludes paired tools. Failed worker remainder is error. Gaps, cooldowns, and between-cycle time are idle/unattributed, so the categories cover campaign wall time.",
    },
    costUsd: cost.c,
    interventions: interventions.n,
    interventionsChangedFrontier: interventions.f,
    cheatEvidence: cheats.n,
    events: events.n,
    research: {
      program,
      programRegisteredAt: planRow?.occurred_at ?? null,
      programTrigger,
      ideas: Object.fromEntries(ideaRows.map((row) => [row.state, row.n])),
      memoryRetrievals: retrievals.n,
      watcher: subscription ? {
        enabled: Boolean(subscription.enabled), intervalSeconds: subscription.interval_seconds,
        topics: watcherTopics, strategy: watcherStrategy, nextSweepAt: subscription.next_sweep_at,
      } : null,
    },
    readme: {
      title: campaign?.title ?? selectedCampaign,
      objective: campaign?.objective ?? "",
      abstract: researchAbstract,
      domain: String(domainConfig.id ?? cfg.domain ?? "unknown"),
      metric,
      candidateFiles: domainConfig.candidateFiles ?? [],
      protectedPaths: domainConfig.protectedPaths ?? [],
      precisionPolicy: domainConfig._precisionPolicy ?? null,
      currentHypothesis: currentHypothesis ?? null,
      pendingMacroSteers,
    },
  };
}

function describeOrchestratorEvent(type: string, payload: Record<string, any>): string {
  switch (type) {
    case "cycle.started":
      return `Opened the cycle from baseline ${String(payload.baseRevision ?? "unknown").slice(0, 10)} and sealed the protected-tree hash.`;
    case "contract.registered":
      return `Registered the experiment thresholds before execution${payload.thresholds
        ? `: support ${payload.thresholds.support}, refute ${payload.thresholds.refute}` : ""}.`;
    case "candidate.classified":
      return `Classified the implementation as ${payload.actual ?? "unknown"}; changed ${(payload.changedPaths ?? []).join(", ") || "no files"}; protected paths ${payload.touchedProtected ? "were touched" : "remained untouched"}.`;
    case "claim.judged":
      return `${String(payload.status ?? "judged").replace(/_/g, " ")}: ${payload.explanation ?? "the registered contract was applied"}.`;
    case "baseline.advanced":
      return `Advanced the validated baseline from ${String(payload.from ?? "").slice(0, 10)} to ${String(payload.to ?? "").slice(0, 10)}.`;
    case "cycle.aborted":
      return `Aborted the cycle without a research verdict: ${payload.reason ?? "unspecified failure"}.`;
    default:
      return `${type.replace(/[._]/g, " ")}: ${JSON.stringify(payload).slice(0, 700)}`;
  }
}

/**
 * The pipeline flow for one cycle: architect -> micro-manager -> executor -> compute -> evaluator
 * -> judge, with each stage's duration and outcome, plus the agent trajectory
 * behind the two stages that call a model.
 *
 * This is what makes the dashboard show *how the pipeline ran* rather than only
 * what it concluded.
 */
function buildCycle(d: Database.Database, hypothesisId: string) {
  const campaign = campaignId(d);
  const cyclePrefix = hypothesisId.startsWith("H-") ? hypothesisId.slice(2) : hypothesisId;
  const runs = d.prepare(
    `SELECT r.run_id, r.kind, r.state, r.idempotency_key, a.attempt_id,
            a.started_at, a.completed_at, a.failure_code, a.model_spec_json
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.hypothesis_id = ?
        OR (r.campaign_id = ? AND r.kind = 'manager'
            AND (r.idempotency_key LIKE ? OR r.idempotency_key LIKE ?))
     ORDER BY a.started_at`,
  ).all(hypothesisId, campaign, `manager:${cyclePrefix}%`, `architect:${cyclePrefix}%`) as any[];

  const now = Date.now();

  const stages = runs.map((r) => {
    const started = r.started_at ? Date.parse(r.started_at) : null;
    const ended = r.completed_at ? Date.parse(r.completed_at) : null;
    let model: string | null = null;
    let tokens: number | null = null;
    try {
      const spec = JSON.parse(r.model_spec_json ?? "{}");
      model = spec.model ?? null;
      tokens = spec.usage?.totalTokens ?? null;
    } catch { /* absent */ }

    const sealedTrace = readAgentTrace(d, r.attempt_id);
    const provisionalTrace = sealedTrace.length === 0 && !r.completed_at
      ? readProvisionalTrace(r.idempotency_key, r.kind)
      : [];
    const trace = sealedTrace.length > 0 ? sealedTrace : provisionalTrace;
    const logs = readStageLogs(d, r.attempt_id);
    // `compute`, `evaluation` and `replay` are deterministic subprocesses, not
    // agents: no model, no thinking, no tool calls. Reporting their trace as
    // "absent" implied a save had failed, when in truth there was never an
    // agent trace to save - and meanwhile their REAL output (the evaluator's
    // checks, the experiment artifact) sat sealed and unshown. Say which kind
    // of stage this is, and show what it actually produced.
    const logicalKind = String(r.idempotency_key).startsWith("architect:") ? "architect" : r.kind;
    const isAgent = logicalKind === "architect" || logicalKind === "manager" || logicalKind === "executor";
    const traceState = sealedTrace.length > 0
      ? "sealed"
      : !r.completed_at
        ? "live"
        : isAgent ? "absent" : "not an agent";

    // Whatever this stage sealed, so a deterministic stage is still inspectable.
    const artifacts = d.prepare(
      `SELECT kind, relative_path, byte_length FROM artifacts
       WHERE attempt_id = ? ORDER BY sealed_at`,
    ).all(r.attempt_id) as Array<{ kind: string; relative_path: string; byte_length: number }>;

    // The evaluator's own verdict: the checks it ran and what each one said.
    // This is the substance of an evaluation stage and the thing an operator
    // most wants when asking "why was this rejected?".
    let checks: Array<{ id: string; class: string; passed: boolean; detail: string }> = [];
    let measured: number | null = null;
    if (r.kind === "evaluation") {
      const evalRow = d.prepare(
        "SELECT result_json, primary_value FROM evaluations WHERE attempt_id = ? LIMIT 1",
      ).get(r.attempt_id) as { result_json: string; primary_value: number | null } | undefined;
      try {
        const raw = JSON.parse(evalRow?.result_json ?? "{}");
        checks = (raw.checks ?? []).map((c: any) => ({
          id: String(c.id), class: String(c.class ?? "integrity"),
          passed: Boolean(c.passed), detail: String(c.detail ?? ""),
        }));
        measured = evalRow?.primary_value ?? null;
      } catch { /* leave empty */ }
    }

    return {
      runId: r.run_id, attemptId: r.attempt_id, kind: logicalKind, state: r.state,
      failureCode: r.failure_code, model, tokens,
      durationMs: started ? (ended ?? now) - started : null,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      isAgent, artifacts, checks, measured,
      trace, traceState, logs,
    };
  });

  const cycleStartRow = d.prepare(
    `SELECT occurred_at FROM events WHERE campaign_id=? AND event_type='cycle.started'
       AND aggregate_id LIKE ? ORDER BY seq DESC LIMIT 1`,
  ).get(campaign, `${cyclePrefix}%`) as { occurred_at: string } | undefined;
  const validTimes = stages
    .map((stage) => stage.startedAt ? Date.parse(stage.startedAt) : null)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const recordedCycleStart = cycleStartRow ? Date.parse(cycleStartRow.occurred_at) : null;
  const timelineStart = Math.min(
    ...(validTimes.length ? validTimes : [now]),
    ...(recordedCycleStart !== null && Number.isFinite(recordedCycleStart) ? [recordedCycleStart] : []),
  );
  const timelineSegments: Array<TraceSegment & { stage: string; attemptId?: string }> = [];

  for (const stage of stages) {
    if (!stage.startedAt || stage.durationMs === null) continue;
    const offset = Date.parse(stage.startedAt) - timelineStart;
    if (stage.kind === "architect" || stage.kind === "manager" || stage.kind === "executor") {
      for (const segment of segmentAgentTrace(stage.trace, stage.durationMs)) {
        const failed = stage.state === "failed" || Boolean(stage.failureCode);
        timelineSegments.push({
          ...segment,
          category: failed && segment.category === "model_reasoning" ? "error" : segment.category,
          label: failed && segment.category === "model_reasoning"
            ? `${stage.kind} failed / retry work` : segment.label,
          // A later failure does not retroactively make successful reads and
          // writes errors. Only the failed model remainder is reclassified;
          // individual tool spans retain their own result status while staying
          // grouped on the parent attempt lane in the dashboard.
          isError: segment.category === "model_reasoning" ? failed : Boolean(segment.isError),
          startMs: offset + segment.startMs,
          endMs: offset + segment.endMs,
          stage: stage.kind,
          attemptId: stage.attemptId,
        });
      }
    } else {
      const failed = stage.state === "failed" || Boolean(stage.failureCode);
      const category: UiTimeCategory = failed
        ? "error"
        : stage.kind === "evaluation"
        ? "evaluation"
        : stage.kind === "compute" || stage.kind === "replay"
          ? "compute"
          : "supervisor";
      timelineSegments.push({
        category,
        startMs: offset,
        endMs: offset + stage.durationMs,
        label: failed ? `${stage.kind} failed` : stage.kind === "compute" ? "Experiment" : stage.kind,
        stage: stage.kind,
        attemptId: stage.attemptId,
      });
    }
  }

  // Anything between recorded stages is harness/supervisor work: validation,
  // contract registration, classification and judging. Make it visible rather
  // than silently folding it into an adjacent model or compute block.
  const spans = stages
    .filter((stage) => stage.startedAt && stage.durationMs !== null)
    .map((stage) => ({
      start: Date.parse(stage.startedAt!) - timelineStart,
      end: Date.parse(stage.startedAt!) - timelineStart + stage.durationMs!,
    }))
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor + 5) {
      timelineSegments.push({
        category: "supervisor", startMs: cursor, endMs: span.start,
        label: "Harness / supervisor", stage: "supervisor",
      });
    }
    cursor = Math.max(cursor, span.end);
  }
  const artifactEnd = Math.max(0, ...stages.flatMap((stage) => stage.logs)
    .map((log) => Date.parse(log.sealedAt) - timelineStart)
    .filter((value) => Number.isFinite(value)));
  if (artifactEnd > cursor + 1) {
    timelineSegments.push({
      category: "supervisor", startMs: cursor, endMs: artifactEnd,
      label: "Artifact sealing", stage: "supervisor",
    });
  }
  const timelineEnd = Math.max(cursor, artifactEnd, ...timelineSegments.map((segment) => segment.endMs), 0);
  timelineSegments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // The orchestrator is deterministic, so it has no hidden model trace. Its
  // real trajectory is the ordered set of control decisions it records in the
  // event ledger. Surface those decisions as their own stage instead of
  // pretending the gaps between model calls are an opaque agent.
  const orchestratorEvents = d.prepare(
    `SELECT seq, occurred_at, event_type, payload_json FROM events
     WHERE campaign_id=? AND actor_kind='supervisor' AND occurred_at>=? AND occurred_at<=?
     ORDER BY seq`,
  ).all(
    campaign,
    new Date(timelineStart).toISOString(),
    new Date(timelineStart + timelineEnd).toISOString(),
  ) as Array<{ seq: number; occurred_at: string; event_type: string; payload_json: string }>;
  const cycleComplete = stages.length > 0 && stages.every((stage) => Boolean(stage.completedAt));
  const orchestrator = {
    runId: `orchestrator:${cyclePrefix}`, attemptId: null, kind: "orchestrator",
    state: cycleComplete ? "complete" : "active", failureCode: null, model: null, tokens: 0,
    durationMs: timelineEnd, startedAt: new Date(timelineStart).toISOString(),
    completedAt: cycleComplete ? new Date(timelineStart + timelineEnd).toISOString() : null,
    isAgent: false, artifacts: [], checks: [], measured: null, traceState: "event ledger", logs: [],
    trace: orchestratorEvents.map((entry) => {
      let payload: Record<string, any> = {};
      try { payload = JSON.parse(entry.payload_json); } catch { /* retain empty payload */ }
      return {
        seq: entry.seq, atMs: Math.max(0, Date.parse(entry.occurred_at) - timelineStart),
        kind: "text" as const, content: describeOrchestratorEvent(entry.event_type, payload),
      };
    }),
  };

  const hypothesis = d.prepare(
    `SELECT hypothesis_id, lane, title, mechanism, motivation, falsifier, status,
            change_class, belief_derived, steps_allowed
     FROM hypotheses WHERE hypothesis_id = ?`,
  ).get(hypothesisId) as any;

  const contract = d.prepare(
    `SELECT threshold_json, registered_at, contract_hash, seed_policy_json
     FROM contracts WHERE hypothesis_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(hypothesisId) as any;

  const evidence = d.prepare(
    `SELECT kind, polarity, statement, created_at FROM evidence
     WHERE hypothesis_id = ? ORDER BY created_at`,
  ).all(hypothesisId) as any[];

  return {
    hypothesis,
    contract,
    stages,
    evidence,
    orchestrator,
    timeline: {
      startedAt: new Date(timelineStart).toISOString(),
      durationMs: timelineEnd,
      segments: timelineSegments,
      accounting: "Every attempt is one lane: paired tool/command calls stay positioned and labelled within it, failed remainder is error, and uncovered in-cycle gaps are orchestrator time.",
    },
  };
}

/** Lightweight current-state projection for the draggable pipeline graph. */
function buildLivePipeline(d: Database.Database) {
  const campaign = campaignId(d);
  const now = Date.now();
  const active = d.prepare(
    `SELECT r.run_id, r.kind, r.state, r.hypothesis_id, r.idempotency_key,
            a.attempt_id, a.state AS attempt_state, a.started_at, a.completed_at
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.campaign_id = ? AND a.completed_at IS NULL
     ORDER BY a.started_at DESC LIMIT 1`,
  ).get(campaign) as any;

  const latest = active ?? d.prepare(
    `SELECT r.run_id, r.kind, r.state, r.hypothesis_id, r.idempotency_key,
            a.attempt_id, a.state AS attempt_state, a.started_at, a.completed_at
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.campaign_id = ? ORDER BY a.started_at DESC LIMIT 1`,
  ).get(campaign) as any;

  const cycleMatch = String(latest?.idempotency_key ?? "")
    .match(/^(?:architect|manager|executor|compute|evaluation|replay):([^:]+)/);
  const cycleId = cycleMatch?.[1] ?? null;
  const rows = cycleId ? d.prepare(
    `SELECT r.kind, r.state, r.hypothesis_id, r.idempotency_key,
            a.attempt_id, a.state AS attempt_state, a.started_at, a.completed_at,
            a.failure_code, a.model_spec_json
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.campaign_id = ? AND r.idempotency_key LIKE ?
     ORDER BY a.started_at`,
  ).all(campaign, `%:${cycleId}%`) as any[] : [];

  const modules: Record<string, { state: string; durationMs: number; count: number; meta?: string }> = {};
  const traces = new Map<string, TimedTraceStep[]>();
  for (const row of rows) {
    const moduleId = String(row.idempotency_key).startsWith("architect:")
      ? "architect" : row.kind === "evaluation" ? "evaluator" : row.kind;
    const start = row.started_at ? Date.parse(row.started_at) : now;
    const end = row.completed_at ? Date.parse(row.completed_at) : now;
    const durationMs = Math.max(0, end - start);
    const waitingExternal = String(row.failure_code ?? "").includes("PROVIDER_RATE_LIMITED");
    const failed = !waitingExternal
      && (row.state === "failed" || row.attempt_state === "failed" || Boolean(row.failure_code));
    const state = row.completed_at
      ? (waitingExternal ? "waiting" : failed ? "failed" : "complete") : "active";
    const previous = modules[moduleId] ?? { state: "idle", durationMs: 0, count: 0 };
    modules[moduleId] = {
      state: state === "active" || previous.state === "active" ? "active" : state,
      durationMs: previous.durationMs + durationMs,
      count: previous.count + 1,
      meta: waitingExternal ? "provider quota; orchestrator will resume" : previous.meta,
    };

    if (row.kind === "manager" || row.kind === "executor") {
      const sealed = readAgentTrace(d, row.attempt_id);
      const trace = sealed.length ? sealed : readProvisionalTrace(row.idempotency_key, row.kind);
      traces.set(row.attempt_id, trace);
      const totals = sumSegments(segmentAgentTrace(trace, durationMs));
      for (const [category, moduleId] of [["tool_execution", "tools"], ["command_execution", "shell"]] as const) {
        const ms = totals[category] ?? 0;
        const calls = trace.filter((step) => step.kind === "tool_call" && categoryForTool(step.toolName) === category).length;
        const prior = modules[moduleId] ?? { state: "idle", durationMs: 0, count: 0 };
        modules[moduleId] = {
          state: prior.state === "active" ? "active" : calls ? "complete" : "idle",
          durationMs: prior.durationMs + ms,
          count: prior.count + calls,
        };
      }
    }
  }

  const activeLogicalKind = String(active?.idempotency_key ?? "").startsWith("architect:")
    ? "architect" : active?.kind;
  let currentModule = activeLogicalKind === "evaluation" ? "evaluator" : activeLogicalKind ?? null;
  let currentLabel = active ? String(activeLogicalKind) : "idle";
  if (active && (active.kind === "manager" || active.kind === "executor")) {
    const trace = traces.get(active.attempt_id) ?? [];
    const openCalls = new Map<string, TimedTraceStep>();
    for (const step of trace) {
      const key = step.toolCallId ?? `seq:${step.seq}`;
      if (step.kind === "tool_call") openCalls.set(key, step);
      else if (step.kind === "tool_result") openCalls.delete(key);
    }
    const inFlight = [...openCalls.values()].at(-1);
    if (inFlight) {
      currentModule = categoryForTool(inFlight.toolName) === "command_execution" ? "shell" : "tools";
      currentLabel = `${activeLogicalKind} · ${inFlight.toolName ?? "tool"}`;
      const currentStats = modules[currentModule] ?? { state: "idle", durationMs: 0, count: 0 };
      modules[currentModule] = { ...currentStats, state: "active" };
    }
  }

  if (!active) {
    const interval = d.prepare(
      `SELECT category, started_ms FROM intervals
       WHERE campaign_id = ? AND resource_id = 'campaign' AND ended_ms IS NULL
       ORDER BY started_ms DESC LIMIT 1`,
    ).get(campaign) as { category: string; started_ms: number } | undefined;
    if (interval) {
      const categoryModule: Record<string, string> = {
        compute: "compute", evaluation: "evaluator", supervisor: "orchestrator",
        blocked: "orchestrator", sleep: "orchestrator", queue: "orchestrator",
        tool_execution: "tools", command_execution: "shell",
      };
      currentModule = categoryModule[interval.category] ?? "orchestrator";
      currentLabel = interval.category.replace(/_/g, " ");
      const stats = modules[currentModule] ?? { state: "idle", durationMs: 0, count: 0 };
      modules[currentModule] = { ...stats, state: "active", durationMs: now - interval.started_ms };
    }
  }

  // The orchestrator is the control plane around every stage, not a peer that
  // disappeared when watcher/memory were added. Provider cooldowns are also an
  // orchestrator state: no model attempt is active, but the campaign is alive
  // and intentionally waiting rather than blank or hung.
  const campaignRow = d.prepare("SELECT status, created_at FROM campaigns WHERE campaign_id=?")
    .get(campaign) as { status: string; created_at: string } | undefined;
  let orchestratorMeta = campaignRow?.status ?? "campaign unavailable";
  const providerHeartbeat = join(STATE_DIR, "attempts", "provider-wait", campaign, "heartbeat.json");
  if (existsSync(providerHeartbeat)) {
    try {
      const heartbeat = JSON.parse(readFileSync(providerHeartbeat, "utf8"));
      if (heartbeat.phase === "waiting_external") {
        orchestratorMeta = String(heartbeat.note ?? "waiting for provider");
        currentModule = "orchestrator";
        currentLabel = orchestratorMeta;
      }
    } catch { /* ignore a heartbeat while it is being replaced */ }
  }
  const hypothesisCount = Number((d.prepare(
    "SELECT COUNT(*) AS n FROM hypotheses WHERE campaign_id=?",
  ).get(campaign) as { n: number }).n);
  modules.orchestrator = {
    state: campaignRow?.status === "running" ? "active" : "idle",
    durationMs: campaignRow ? Math.max(0, now - Date.parse(campaignRow.created_at)) : 0,
    count: hypothesisCount,
    meta: orchestratorMeta,
  };

  const planCount = Number((d.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE campaign_id=? AND event_type='architect.plan_registered'",
  ).get(campaign) as { n: number }).n);
  if (!modules.architect && planCount > 0) {
    modules.architect = {
      state: "complete", durationMs: 1, count: planCount,
      meta: `${planCount} program revision(s)`,
    };
  }

  const latestHypothesis = latest?.hypothesis_id ?? null;
  if (latestHypothesis) {
    const contractCount = Number((d.prepare("SELECT COUNT(*) AS n FROM contracts WHERE hypothesis_id=?")
      .get(latestHypothesis) as { n: number }).n);
    const diffCount = Number((d.prepare(
      `SELECT COUNT(*) AS n FROM artifacts a JOIN attempts at ON at.attempt_id=a.attempt_id
       JOIN runs r ON r.run_id=at.run_id WHERE r.hypothesis_id=? AND a.kind='candidate-diff'`,
    ).get(latestHypothesis) as { n: number }).n);
    const judgementCount = Number((d.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE campaign_id=? AND aggregate_id=? AND event_type='claim.judged'",
    ).get(campaign, latestHypothesis) as { n: number }).n);
    const evidenceCount = Number((d.prepare("SELECT COUNT(*) AS n FROM evidence WHERE hypothesis_id=?")
      .get(latestHypothesis) as { n: number }).n);
    if (contractCount) modules.contract = { state: "complete", durationMs: 1, count: contractCount };
    if (diffCount) modules.classify = { state: "complete", durationMs: 1, count: diffCount };
    if (judgementCount) modules.judge = { state: "complete", durationMs: 1, count: judgementCount };
    if (evidenceCount) modules.seal = { state: "complete", durationMs: 1, count: evidenceCount };
  }

  const order = [
    "orchestrator", "architect", "manager", "executor", "tools", "shell",
    "compute", "evaluator", "judge", "replay", "seal",
  ];
  const watcher = inspectWatcher(STATE_DIR, campaign);
  const watcherCursor = (() => {
    try {
      return d.prepare(
        `SELECT COUNT(*) AS providers, MAX(last_success_at) AS last_success,
                SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failures
         FROM watcher_cursors WHERE campaign_id=?`,
      ).get(campaign) as { providers: number; last_success: string | null; failures: number };
    } catch { return { providers: 0, last_success: null, failures: 0 }; }
  })();
  modules.watcher = {
    state: watcher.state === "running" ? "active" : watcher.state === "stale" ? "failed" : "idle",
    durationMs: watcher.state === "running" ? Math.max(0, now - Date.parse(watcher.run.startedAt)) : 0,
    count: watcherCursor.providers,
    meta: watcher.state === "running"
      ? `${watcherCursor.providers} query cursors · ${watcherCursor.failures ?? 0} failing`
      : watcher.state === "stale" ? watcher.reason : "not enabled",
  };
  let memoryMeta = "global memory unavailable";
  let memoryCount = 0;
  const memoryPath = defaultMemoryPath();
  if (existsSync(memoryPath)) {
    try {
      const md = new Database(memoryPath, { readonly: true, fileMustExist: true });
      const stats = md.prepare(
        `SELECT (SELECT COUNT(*) FROM source_versions) AS sources,
                (SELECT COUNT(*) FROM mechanisms) AS mechanisms`,
      ).get() as { sources: number; mechanisms: number };
      md.close();
      memoryCount = stats.sources + stats.mechanisms;
      memoryMeta = `${stats.sources} sources · ${stats.mechanisms} mechanisms`;
    } catch { /* retain unavailable label */ }
  }
  modules.memory = { state: memoryCount > 0 ? "done" : "idle", durationMs: 0, count: memoryCount, meta: memoryMeta };
  const currentIndex = currentModule ? order.indexOf(currentModule) : -1;
  return {
    at: new Date(now).toISOString(),
    cycleId,
    hypothesisId: latest?.hypothesis_id ?? (cycleId ? `H-${cycleId.slice(0, 8)}` : null),
    currentModule,
    currentLabel,
    currentStep: currentIndex >= 0 ? currentIndex + 1 : null,
    totalSteps: order.length,
    activeSince: active?.started_at ?? null,
    modules,
  };
}

const routes: Record<string, (url: URL, d: Database.Database) => unknown> = {
  "/api/summary": (_u, d) => buildSummary(d),
  "/api/sources": (_u, d) => buildSources(d),
  "/api/tree": (_u, d) => buildTree(d),
  "/api/progress": (_u, d) => buildProgress(d),
  "/api/cycle": (u, d) => buildCycle(d, u.searchParams.get("id") ?? ""),
  "/api/live": (_u, d) => buildLivePipeline(d),
  "/api/trace": (u, d) => buildTrace(d,
    Math.min(500, Number(u.searchParams.get("limit") ?? 120)),
    Number(u.searchParams.get("offset") ?? 0)),
};

function sendLiveSnapshot(res: ServerResponse): void {
  let conn: Database.Database | null = null;
  try {
    conn = db();
    res.write(`event: snapshot\ndata: ${JSON.stringify(buildLivePipeline(conn))}\n\n`);
  } catch {
    res.write(`event: unavailable\ndata: {}\n\n`);
  } finally {
    conn?.close();
  }
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLiveBroadcast(): void {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    for (const client of liveClients) sendLiveSnapshot(client);
  }, 160);
}

// SQLite writes through WAL and active Genkit workers append bounded trace JSONL.
// Watching the autoresearch directory captures both without making every open
// dashboard repeatedly query the database. EventSource reconnects by itself;
// the heartbeat below keeps intermediaries from considering the stream idle.
try {
  watch(join(ROOT, ".autoresearch"), { recursive: true }, (_event, filename) => {
    const name = String(filename ?? "");
    if (!name || /state\.sqlite(?:-wal)?$|(?:trace|session).*\.jsonl$|\.jsonl$/i.test(name)) {
      scheduleLiveBroadcast();
    }
  });
} catch {
  // Some filesystems cannot watch recursively. Live events still send an
  // initial snapshot and reconnect; the 15s heartbeat remains available.
}
setInterval(() => {
  for (const client of liveClients) sendLiveSnapshot(client);
}, 15_000).unref();

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Explicit attention control. Macro guidance is durable and audited in the
  // event chain; the legacy micro scope remains a one-cycle file consumed by
  // the manager. Neither path can alter evidence or judgement.
  if (req.method === "POST" && url.pathname === "/api/steer") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      // A steer is a sentence, not an upload. Cap it before it reaches memory.
      if (body.length > 8000) req.destroy();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const text = String(parsed.text ?? "").trim();
        const scope = String(parsed.scope ?? "macro") as AttentionSteerScope;
        if (!["micro", "macro", "watcher", "all"].includes(scope)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "scope must be micro, macro, watcher, or all" }));
          return;
        }
        if (!text) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "a steer needs some text" }));
          return;
        }
        const selectedCampaign = (() => {
          const read = db();
          try { return campaignId(read); } finally { read.close(); }
        })();
        if (scope === "micro") {
          requestSteer(STATE_DIR, text.slice(0, 2000));
        } else {
          const store = Store.open(DB_PATH);
          try { requestAttentionSteer(store, selectedCampaign, scope, text); }
          finally { store.close(); }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, scope, queued: text.slice(0, 4000) }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "expected JSON with a text field" }));
      }
    });
    return;
  }

  // Stopping is the one control that must always be reachable. It writes the
  // same stop-request file `cli.ts stop` writes; the campaign honours it at the
  // next cycle boundary, so a night's work is never abandoned half-finished.
  if (req.method === "POST" && url.pathname === "/api/stop") {
    requestStop(STATE_DIR, "stopped from the dashboard");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // The counterpart to stopping. A stop is honoured at a cycle boundary and
  // leaves the campaign's record intact, so resuming is simply relaunching the
  // same campaign: it clears its stop reason and continues from the accepted
  // baseline. The domain is read back from the campaign's own configuration so
  // a resume cannot silently restart it against a different task.
  if (req.method === "POST" && url.pathname === "/api/resume") {
    if (inspect(STATE_DIR).state === "running") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "the campaign is already running" }));
      return;
    }
    const read = db();
    let target: string;
    let domain: string | null = null;
    try {
      target = campaignId(read);
      const row = read.prepare("SELECT config_json FROM campaigns WHERE campaign_id=?")
        .get(target) as { config_json: string } | undefined;
      domain = row ? (JSON.parse(row.config_json)?.domain ?? null) : null;
    } finally { read.close(); }
    if (!domain) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "this campaign has no recorded domain to resume with" }));
      return;
    }
    // A stop request that was never consumed would stop the new run at its
    // first cycle boundary, which would look like the resume having failed.
    clearStopRequest(STATE_DIR);
    const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const started = detach(STATE_DIR, cliPath, ["campaign", "--campaign", target, "--domain", domain]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: started.pid, logPath: started.logPath }));
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/steer") {
    const scope = (url.searchParams.get("scope") ?? "macro") as AttentionSteerScope;
    if (scope === "micro") clearSteer(STATE_DIR);
    else {
      const read = db();
      let selectedCampaign: string;
      try { selectedCampaign = campaignId(read); } finally { read.close(); }
      const store = Store.open(DB_PATH);
      try { withdrawAttentionSteers(store, selectedCampaign, scope); }
      finally { store.close(); }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Everything else is read-only.
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "this dashboard cannot modify results" }));
    return;
  }

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    liveClients.add(res);
    sendLiveSnapshot(res);
    req.on("close", () => liveClients.delete(res));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(HERE, "dashboard.html"), "utf8"));
    return;
  }

  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let conn: Database.Database | null = null;
  try {
    conn = db();
    const body = JSON.stringify(handler(url, conn));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err).slice(0, 500) }));
  } finally {
    conn?.close();
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`autoresearch dashboard  http://127.0.0.1:${PORT}`);
  const conn = db();
  try {
    console.log(`campaign: ${campaignId(conn)}${PINNED_CAMPAIGN ? " (pinned)" : " (follows active)"}`);
  } finally { conn.close(); }
  console.log("evidence is read-only; steer/stop are explicit operator controls");
});
