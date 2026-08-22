/**
 * Read-only dashboard server.
 *
 * Read-only against the EVIDENCE, with exactly one narrow exception.
 *
 * SQLite is opened `readonly: true`, so nothing served here can alter a result,
 * a verdict, a threshold or the event log. The trust boundary requires that an
 * observation surface must not become part of the control plane, and that still
 * holds for everything that decides what is true.
 *
 * The exception is `POST /api/steer`, which writes ONE file - the pending steer
 * - and touches no table. The campaign process reads that file at its next
 * cycle boundary, validates it, records it as a human intervention in the
 * hash-chained log, and only then shows it to the manager. So the dashboard can
 * suggest what to look at next; it cannot record, judge, or promote anything.
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
import { latestCampaignId, normaliseCampaignConfig } from "../store/store.js";
import { clearSteer, pendingSteer, requestSteer } from "../steer.js";
import { requestStop } from "../daemon.js";
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
const CAMPAIGN = process.env.AR_CAMPAIGN ?? latestCampaignId();
const liveClients = new Set<ServerResponse>();

function db(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
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
  const match = idempotencyKey.match(/^(manager|executor):([^:]+):(\d+)$/);
  if (!match || match[1] !== kind) return [];
  const attemptNo = Number(match[3]);
  const dir = attemptNo === 1 ? kind : `${kind}-retry-${attemptNo}`;
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
  // The judge's own sentence for each claim. Without it the tree shows a status
  // word and an id - "refuted / falsify / mechanism / H-6c5e8b30" - which says
  // what happened and nothing about why. The reason exists; it was not reaching
  // anyone.
  const reasons = new Map<string, string>();
  for (const e of d.prepare(
    `SELECT aggregate_id, payload_json FROM events
     WHERE campaign_id = ? AND event_type = 'claim.judged' ORDER BY seq`,
  ).all(CAMPAIGN) as Array<{ aggregate_id: string; payload_json: string }>) {
    try {
      const p = JSON.parse(e.payload_json);
      if (p.explanation) reasons.set(e.aggregate_id, String(p.explanation));
    } catch { /* skip */ }
  }
  // Why a hypothesis never got a verdict at all.
  const aborts = new Map<string, string>();
  for (const e of d.prepare(
    `SELECT payload_json FROM events WHERE campaign_id = ? AND event_type = 'cycle.aborted' ORDER BY seq`,
  ).all(CAMPAIGN) as Array<{ payload_json: string }>) {
    try {
      const p = JSON.parse(e.payload_json);
      if (p.reason) aborts.set(String(p.reason), String(p.reason));
    } catch { /* skip */ }
  }

  const advances = d.prepare(
    `SELECT occurred_at, payload_json FROM events
     WHERE campaign_id = ? AND event_type = 'baseline.advanced' ORDER BY seq`,
  ).all(CAMPAIGN) as Array<{ occurred_at: string; payload_json: string }>;

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
  ).all(CAMPAIGN) as any[];

  const nodes = hypotheses.map((h) => {
    let holdout: number | null = null;
    try { holdout = JSON.parse(h.result_json ?? "{}")?.metrics?.holdout_bpc ?? null; } catch { /* absent */ }
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
  const rows = d.prepare(
    `SELECT h.hypothesis_id, h.title, h.lane, h.updated_at,
            e.primary_value, e.baseline_value, e.result_json
     FROM hypotheses h
     JOIN contracts ct ON ct.hypothesis_id = h.hypothesis_id
     JOIN evaluations e ON e.contract_id = ct.contract_id
     WHERE h.campaign_id = ? AND h.status = 'replicated'
     GROUP BY h.hypothesis_id ORDER BY h.updated_at`,
  ).all(CAMPAIGN) as any[];

  return rows.map((r, i) => {
    let holdout: number | null = null;
    try { holdout = JSON.parse(r.result_json ?? "{}")?.metrics?.holdout_bpc ?? null; } catch { /* absent */ }
    return {
      step: i + 1,
      id: r.hypothesis_id,
      title: r.title,
      lane: r.lane,
      primary: r.primary_value,
      baseline: r.baseline_value,
      holdout,
      gain: r.baseline_value !== null ? r.baseline_value - r.primary_value : null,
    };
  });
}

/** The trajectory: everything that happened, in order, as the harness recorded it. */
function buildTrace(d: Database.Database, limit: number, offset: number) {
  const rows = d.prepare(
    `SELECT seq, occurred_at, event_type, actor_kind, aggregate_kind, aggregate_id, payload_json
     FROM events WHERE campaign_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
  ).all(CAMPAIGN, limit, offset) as any[];
  return rows.map((r) => ({
    seq: r.seq, at: r.occurred_at, type: r.event_type, actor: r.actor_kind,
    subject: `${r.aggregate_kind}:${String(r.aggregate_id).slice(0, 12)}`,
    payload: JSON.parse(r.payload_json),
  }));
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
  const rows = d.prepare(
    `SELECT provider, title, canonical_url, retrieved_at, source_class, reliability, metadata_json
     FROM sources WHERE campaign_id = ? ORDER BY provider, retrieved_at DESC`,
  ).all(CAMPAIGN) as any[];

  const groups: Record<string, any[]> = {};
  for (const r of rows) {
    let meta: any = {};
    try { meta = JSON.parse(r.metadata_json ?? "{}"); } catch { /* absent */ }
    (groups[r.provider] ??= []).push({
      title: r.title, url: r.canonical_url, at: r.retrieved_at,
      sourceClass: r.source_class, reliability: r.reliability,
      tool: meta.tool ?? null, hypothesis: meta.hypothesis ?? null,
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
  const campaign = d.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").get(CAMPAIGN) as any;
  const statuses = d.prepare(
    "SELECT status, COUNT(*) AS n FROM hypotheses WHERE campaign_id = ? GROUP BY status",
  ).all(CAMPAIGN) as Array<{ status: string; n: number }>;
  const lanes = d.prepare(
    "SELECT lane, consumed, allocated FROM budgets WHERE campaign_id = ? AND category='runs' ORDER BY lane",
  ).all(CAMPAIGN) as any[];
  // The model actually in use, read from the last recorded attempt rather than
  // from configuration. A campaign silently ran ~30 cycles on a provider
  // default after a relaunch dropped the model flag, and nothing on screen said
  // so. What the run IS using belongs on the dashboard.
  const modelRow = d.prepare(
    `SELECT model_spec_json FROM attempts
     WHERE model_spec_json IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
  ).get() as { model_spec_json: string } | undefined;
  let model = "unknown";
  try {
    const m = JSON.parse(modelRow?.model_spec_json ?? "{}");
    model = m.provider ? `${m.provider}/${m.model}` : String(m.model ?? "unknown");
  } catch { /* leave unknown */ }

  const recentInterventions = d.prepare(
    `SELECT kind, detail, changed_frontier, occurred_at FROM human_interventions
     WHERE campaign_id = ? ORDER BY occurred_at DESC LIMIT 8`,
  ).all(CAMPAIGN) as any[];

  // A spread across providers, not just whichever one swept most recently.
  // Ordering purely by time showed eight GitHub rows and hid 38 arXiv preprints,
  // which made the scout look like a repo crawler.
  const leads = d.prepare(
    `SELECT provider, title, canonical_url, retrieved_at FROM (
       SELECT provider, title, canonical_url, retrieved_at,
              ROW_NUMBER() OVER (PARTITION BY provider ORDER BY retrieved_at DESC) AS rn
       FROM sources WHERE campaign_id = ? AND reliability = 'lead')
     WHERE rn <= 4 ORDER BY rn, retrieved_at DESC`,
  ).all(CAMPAIGN) as any[];

  // Wall time from the campaign's own first and last recorded events, so it
  // reflects the run rather than the age of the row.
  const span = d.prepare(
    `SELECT MIN(occurred_at) AS a, MAX(occurred_at) AS b FROM events WHERE campaign_id = ?`,
  ).get(CAMPAIGN) as { a: string | null; b: string | null };
  const elapsedMs = span?.a && span?.b
    ? Math.max(0, Date.parse(span.b) - Date.parse(span.a)) : 0;

  const rawIntervals = d.prepare(
    `SELECT category, SUM(COALESCE(ended_ms, started_ms) - started_ms) AS ms
     FROM intervals WHERE campaign_id = ? AND resource_id = 'campaign' GROUP BY category`,
  ).all(CAMPAIGN) as Array<{ category: string; ms: number }>;

  // The campaign recorder historically wrapped a whole worker process in one
  // `model_reasoning` interval. Subtract paired tool spans from that bucket so
  // shell commands and other tools are visible as their own costs. This is an
  // evidence-backed correction: every moved millisecond comes from timestamps
  // in a sealed agent trace, and the grand total remains unchanged.
  const intervalTotals: Record<string, number> = Object.fromEntries(
    rawIntervals.map((row) => [row.category, Number(row.ms ?? 0)]),
  );
  const agentAttempts = d.prepare(
    `SELECT a.attempt_id, a.started_at, a.completed_at
     FROM attempts a JOIN runs r ON r.run_id = a.run_id
     WHERE r.campaign_id = ? AND r.kind IN ('manager','executor')
       AND a.started_at IS NOT NULL AND a.completed_at IS NOT NULL`,
  ).all(CAMPAIGN) as Array<{ attempt_id: string; started_at: string; completed_at: string }>;
  let tracedModelMs = 0;
  let tracedToolMs = 0;
  for (const attempt of agentAttempts) {
    const duration = Math.max(0, Date.parse(attempt.completed_at) - Date.parse(attempt.started_at));
    const totals = sumSegments(segmentAgentTrace(readAgentTrace(d, attempt.attempt_id), duration));
    tracedModelMs += totals.model_reasoning ?? 0;
    for (const category of ["tool_execution", "command_execution"] as const) {
      const ms = totals[category] ?? 0;
      intervalTotals[category] = (intervalTotals[category] ?? 0) + ms;
      tracedToolMs += ms;
    }
  }
  const oldModelBracket = intervalTotals.model_reasoning ?? 0;
  intervalTotals.model_reasoning = tracedModelMs;
  // Prompt assembly, response validation and retry setup happened inside the
  // old coarse bracket but outside the worker attempts. They belong to the
  // harness/supervisor, not to the model.
  const harnessOverhead = Math.max(0, oldModelBracket - tracedModelMs - tracedToolMs);
  intervalTotals.supervisor = (intervalTotals.supervisor ?? 0) + harnessOverhead;
  const intervals = Object.entries(intervalTotals).map(([category, ms]) => ({ category, ms }));
  const cost = d.prepare(
    "SELECT COALESCE(SUM(consumed),0) AS c FROM budgets WHERE campaign_id=? AND category='model_cost_usd'",
  ).get(CAMPAIGN) as { c: number };
  const interventions = d.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(changed_frontier),0) AS f FROM human_interventions WHERE campaign_id = ?",
  ).get(CAMPAIGN) as { n: number; f: number };
  const cheats = d.prepare(
    "SELECT COUNT(*) AS n FROM evidence WHERE campaign_id = ? AND kind = 'shortcut'",
  ).get(CAMPAIGN) as { n: number };
  const events = d.prepare("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ?")
    .get(CAMPAIGN) as { n: number };

  let cfg: any = {};
  // Through the normaliser: campaigns written before the rename still hold
  // `baselineBpc`, and the dashboard showed "None" for a live 317 GB/s baseline.
  try { cfg = normaliseCampaignConfig(campaign?.config_json ?? "{}"); } catch { /* absent */ }

  return {
    campaign: campaign?.campaign_id ?? CAMPAIGN,
    status: campaign?.status ?? "unknown",
    model,
    elapsedMs,
    pendingSteer: pendingSteer(STATE_DIR),
    recentInterventions,
    leads,
    stopReason: campaign?.stop_reason ?? null,
    baseRevision: campaign?.base_revision ?? null,
    baselinePrimary: cfg.baselinePrimary ?? null,
    baselineSecondary: cfg.baselineSecondary ?? null,
    statuses: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
    lanes, intervals,
    intervalAccounting: {
      method: "trace-exclusive",
      note: "Reasoning is worker wall-time minus paired tools; orchestration outside worker attempts is supervisor time.",
    },
    costUsd: cost.c,
    interventions: interventions.n,
    interventionsChangedFrontier: interventions.f,
    cheatEvidence: cheats.n,
    events: events.n,
  };
}

/**
 * The pipeline flow for one cycle: manager -> executor -> compute -> evaluator
 * -> judge, with each stage's duration and outcome, plus the agent trajectory
 * behind the two stages that call a model.
 *
 * This is what makes the dashboard show *how the pipeline ran* rather than only
 * what it concluded.
 */
function buildCycle(d: Database.Database, hypothesisId: string) {
  const cyclePrefix = hypothesisId.startsWith("H-") ? hypothesisId.slice(2) : hypothesisId;
  const runs = d.prepare(
    `SELECT r.run_id, r.kind, r.state, r.idempotency_key, a.attempt_id,
            a.started_at, a.completed_at, a.failure_code, a.model_spec_json
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.hypothesis_id = ?
        OR (r.campaign_id = ? AND r.kind = 'manager' AND r.idempotency_key LIKE ?)
     ORDER BY a.started_at`,
  ).all(hypothesisId, CAMPAIGN, `manager:${cyclePrefix}%`) as any[];

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
    const isAgent = r.kind === "manager" || r.kind === "executor";
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
      runId: r.run_id, attemptId: r.attempt_id, kind: r.kind, state: r.state,
      failureCode: r.failure_code, model, tokens,
      durationMs: started ? (ended ?? now) - started : null,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      isAgent, artifacts, checks, measured,
      trace, traceState, logs,
    };
  });

  const validTimes = stages
    .map((stage) => stage.startedAt ? Date.parse(stage.startedAt) : null)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const timelineStart = validTimes.length ? Math.min(...validTimes) : now;
  const timelineSegments: Array<TraceSegment & { stage: string; attemptId?: string }> = [];

  for (const stage of stages) {
    if (!stage.startedAt || stage.durationMs === null) continue;
    const offset = Date.parse(stage.startedAt) - timelineStart;
    if (stage.kind === "manager" || stage.kind === "executor") {
      for (const segment of segmentAgentTrace(stage.trace, stage.durationMs)) {
        timelineSegments.push({
          ...segment,
          startMs: offset + segment.startMs,
          endMs: offset + segment.endMs,
          stage: stage.kind,
          attemptId: stage.attemptId,
        });
      }
    } else {
      const category: UiTimeCategory = stage.kind === "evaluation"
        ? "evaluation"
        : stage.kind === "compute" || stage.kind === "replay"
          ? "compute"
          : "supervisor";
      timelineSegments.push({
        category,
        startMs: offset,
        endMs: offset + stage.durationMs,
        label: stage.kind === "compute" ? "Experiment" : stage.kind,
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
    timeline: {
      startedAt: new Date(timelineStart).toISOString(),
      durationMs: timelineEnd,
      segments: timelineSegments,
      accounting: "Tool and command spans are paired from trace events; model reasoning is the exclusive remainder.",
    },
  };
}

/** Lightweight current-state projection for the draggable pipeline graph. */
function buildLivePipeline(d: Database.Database) {
  const now = Date.now();
  const active = d.prepare(
    `SELECT r.run_id, r.kind, r.state, r.hypothesis_id, r.idempotency_key,
            a.attempt_id, a.state AS attempt_state, a.started_at, a.completed_at
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.campaign_id = ? AND a.completed_at IS NULL
     ORDER BY a.started_at DESC LIMIT 1`,
  ).get(CAMPAIGN) as any;

  const latest = active ?? d.prepare(
    `SELECT r.run_id, r.kind, r.state, r.hypothesis_id, r.idempotency_key,
            a.attempt_id, a.state AS attempt_state, a.started_at, a.completed_at
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.campaign_id = ? ORDER BY a.started_at DESC LIMIT 1`,
  ).get(CAMPAIGN) as any;

  const cycleMatch = String(latest?.idempotency_key ?? "")
    .match(/^(?:manager|executor|compute|evaluation|replay):([^:]+)/);
  const cycleId = cycleMatch?.[1] ?? null;
  const rows = cycleId ? d.prepare(
    `SELECT r.kind, r.state, r.hypothesis_id, r.idempotency_key,
            a.attempt_id, a.state AS attempt_state, a.started_at, a.completed_at,
            a.failure_code, a.model_spec_json
     FROM runs r JOIN attempts a ON a.run_id = r.run_id
     WHERE r.campaign_id = ? AND r.idempotency_key LIKE ?
     ORDER BY a.started_at`,
  ).all(CAMPAIGN, `%:${cycleId}%`) as any[] : [];

  const modules: Record<string, { state: string; durationMs: number; count: number; meta?: string }> = {};
  const traces = new Map<string, TimedTraceStep[]>();
  for (const row of rows) {
    const moduleId = row.kind === "evaluation" ? "evaluator" : row.kind;
    const start = row.started_at ? Date.parse(row.started_at) : now;
    const end = row.completed_at ? Date.parse(row.completed_at) : now;
    const durationMs = Math.max(0, end - start);
    const failed = row.state === "failed" || row.attempt_state === "failed" || Boolean(row.failure_code);
    const state = row.completed_at ? (failed ? "failed" : "complete") : "active";
    const previous = modules[moduleId] ?? { state: "idle", durationMs: 0, count: 0 };
    modules[moduleId] = {
      state: state === "active" || previous.state === "active" ? "active" : state,
      durationMs: previous.durationMs + durationMs,
      count: previous.count + 1,
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

  let currentModule = active?.kind === "evaluation" ? "evaluator" : active?.kind ?? null;
  let currentLabel = active ? String(active.kind) : "idle";
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
      currentLabel = `${active.kind} · ${inFlight.toolName ?? "tool"}`;
      const currentStats = modules[currentModule] ?? { state: "idle", durationMs: 0, count: 0 };
      modules[currentModule] = { ...currentStats, state: "active" };
    }
  }

  if (!active) {
    const interval = d.prepare(
      `SELECT category, started_ms FROM intervals
       WHERE campaign_id = ? AND resource_id = 'campaign' AND ended_ms IS NULL
       ORDER BY started_ms DESC LIMIT 1`,
    ).get(CAMPAIGN) as { category: string; started_ms: number } | undefined;
    if (interval) {
      const categoryModule: Record<string, string> = {
        compute: "compute", evaluation: "evaluator", supervisor: "supervisor",
        tool_execution: "tools", command_execution: "shell",
      };
      currentModule = categoryModule[interval.category] ?? "supervisor";
      currentLabel = interval.category.replace(/_/g, " ");
      const stats = modules[currentModule] ?? { state: "idle", durationMs: 0, count: 0 };
      modules[currentModule] = { ...stats, state: "active", durationMs: now - interval.started_ms };
    }
  }

  const order = ["supervisor", "manager", "executor", "tools", "shell", "compute", "evaluation", "judge", "replay"];
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

  // One write path, and it writes a file rather than the database.
  if (req.method === "POST" && url.pathname === "/api/steer") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      // A steer is a sentence, not an upload. Cap it before it reaches memory.
      if (body.length > 8000) req.destroy();
    });
    req.on("end", () => {
      try {
        const text = String(JSON.parse(body).text ?? "").trim();
        if (!text) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "a steer needs some text" }));
          return;
        }
        requestSteer(STATE_DIR, text.slice(0, 2000));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, queued: text.slice(0, 2000) }));
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

  if (req.method === "DELETE" && url.pathname === "/api/steer") {
    clearSteer(STATE_DIR);
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
  console.log(`campaign: ${CAMPAIGN}   (read-only; it cannot steer anything)`);
});
