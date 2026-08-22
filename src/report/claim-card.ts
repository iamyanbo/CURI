/**
 * The claim card.
 *
 * Machine-generated, never hand-edited. Its job is to state the highest
 * autonomy level the evidence actually supports and to name what is missing for
 * the next one — the opposite of the "9 days autonomous" headline that
 * the original adversarial audit was written against.
 *
 * Two rules make it honest rather than decorative:
 *
 *  1. Every claim it prints must pass `assertClaimIsCitable`. A claim that
 *     cannot be resolved to a registered contract and immutable artifacts is
 *     listed under NOT CITABLE instead of being quietly dropped.
 *  2. The ladder level is derived from evidence, and the reason it is not
 *     higher is always printed. A card that cannot justify its level fails.
 */

import { assertClaimIsCitable } from "../loop/persist.js";
import { formatDuration, IntervalRecorder } from "../trace/intervals.js";
import type { Store } from "../store/store.js";

/** Minimal evidence needed to present a claim without hiding its provenance. */
export type LadderLevel = "A0" | "A1" | "A2" | "A3" | "A4" | "A5";

export interface Ladder {
  level: LadderLevel;
  label: string;
  justification: string;
  blockedFrom: string;
}

export function assessLadder(store: Store, campaignId: string): Ladder {
  const counts = statusCounts(store, campaignId);
  const replicated = counts.replicated ?? 0;
  const supported = counts.provisionally_supported ?? 0;
  const decided = Object.values(counts).reduce((a, b) => a + b, 0);

  // A4 and A5 are unreachable by construction in v0: there is no prior-art
  // search and no external oracle. Saying so is the point.
  const blockedFrom =
    "A4 requires a dated prior-art search and a mechanism-discriminating test; " +
    "neither exists in v0 (see SCOPE.md, invariant 7 deferred). A5 requires " +
    "independent external reproduction.";

  if (replicated > 0) {
    return {
      level: "A3",
      label: "validated improvement",
      justification:
        `${replicated} claim(s) survived multi-seed replication against a protected holdout ` +
        `with a threshold registered before the result was observable`,
      blockedFrom,
    };
  }
  if (supported > 0) {
    return {
      level: "A2",
      label: "adaptive campaign",
      justification:
        `${supported} claim(s) beat their registered threshold but none survived replication, ` +
        "so no improvement is validated",
      blockedFrom: "A3 requires a replicated result. " + blockedFrom,
    };
  }
  if (decided > 0) {
    return {
      level: "A2",
      label: "adaptive campaign",
      justification:
        `${decided} experiment(s) were proposed from prior evidence and judged against ` +
        "pre-registered rules; none produced an improvement",
      blockedFrom: "A3 requires a validated improvement. " + blockedFrom,
    };
  }
  return {
    level: "A1",
    label: "unattended operation",
    justification: "the harness ran experiments without intervention but produced no judged claim",
    blockedFrom: "A2 requires an experiment chosen using prior results. " + blockedFrom,
  };
}

function statusCounts(store: Store, campaignId: string): Record<string, number> {
  const rows = store.db
    .prepare("SELECT status, COUNT(*) AS n FROM hypotheses WHERE campaign_id = ? GROUP BY status")
    .all(campaignId) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function renderClaimCard(store: Store, campaignId: string): string {
  const c = store.db.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").get(campaignId) as any;
  if (!c) return `no campaign ${campaignId}`;

  const out: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);

  const span = store.db
    .prepare("SELECT MIN(started_ms) AS a, MAX(COALESCE(ended_ms, started_ms)) AS b FROM intervals WHERE campaign_id = ?")
    .get(campaignId) as { a: number | null; b: number | null };
  const start = span.a ?? Date.now();
  const end = span.b ?? Date.now();
  const rec = new IntervalRecorder(store);
  const d = rec.decompose(campaignId, "campaign", start, end);

  out.push(`CAMPAIGN  ${c.campaign_id}`);
  out.push(`STATUS    ${c.status}${c.stop_reason ? `: ${c.stop_reason}` : ""}`);
  out.push(`SPAN      ${formatDuration(d.spanMs)}`);
  for (const [cat, ms] of Object.entries(d.byCategory).sort((a, b) => b[1] - a[1])) {
    const pct = d.spanMs > 0 ? ((ms / d.spanMs) * 100).toFixed(1) : "0.0";
    out.push(`  ${pad(cat, 18)}${formatDuration(ms).padStart(9)}  (${pct}%)`);
  }
  if (!d.exact) out.push("  WARNING: time decomposition is not exact — telemetry is incomplete");

  const hi = store.db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(changed_frontier),0) AS f FROM human_interventions WHERE campaign_id = ?")
    .get(campaignId) as { n: number; f: number };
  out.push(`HUMAN     ${hi.n} interventions (${hi.f} changed the frontier)`);

  const runs = store.db
    .prepare("SELECT kind, state, COUNT(*) AS n FROM runs WHERE campaign_id = ? GROUP BY kind, state")
    .all(campaignId) as Array<{ kind: string; state: string; n: number }>;
  const totalRuns = runs.reduce((a, r) => a + r.n, 0);
  const failedRuns = runs.filter((r) => r.state === "failed").reduce((a, r) => a + r.n, 0);
  out.push(`RUNS      ${totalRuns} recorded · ${failedRuns} failed`);

  const counts = statusCounts(store, campaignId);
  const order = [
    "replicated", "provisionally_supported", "inconclusive", "refuted",
    "implementation_invalid", "shortcut_suspected", "proposed", "abandoned",
  ];
  const claimLine = order.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(" · ");
  out.push(`CLAIMS    ${claimLine || "none"}`);

  const negatives = (counts.refuted ?? 0) + (counts.inconclusive ?? 0);
  out.push(`          ${negatives} negative result(s) retained and queryable`);

  const lanes = store.db
    .prepare("SELECT lane, consumed FROM budgets WHERE campaign_id = ? AND category = 'runs' ORDER BY lane")
    .all(campaignId) as Array<{ lane: string; consumed: number }>;
  out.push(`LANES     ${lanes.map((l) => `${l.lane}=${l.consumed}`).join(" · ")}`);

  const cost = store.db
    .prepare("SELECT COALESCE(SUM(consumed),0) AS c FROM budgets WHERE campaign_id = ? AND category = 'model_cost_usd'")
    .get(campaignId) as { c: number };
  out.push(`COST      $${cost.c.toFixed(4)} in model calls`);

  // Best supported claim, with citability checked rather than assumed.
  const best = store.db
    .prepare(
      `SELECT h.hypothesis_id, h.title, h.status, h.belief_derived, e.primary_value, e.baseline_value
       FROM hypotheses h
       LEFT JOIN evaluations e ON e.attempt_id IN (
         SELECT at.attempt_id FROM attempts at JOIN runs r ON r.run_id = at.run_id
         WHERE r.hypothesis_id = h.hypothesis_id)
       WHERE h.campaign_id = ? AND h.status IN ('replicated','provisionally_supported')
       ORDER BY e.primary_value ASC LIMIT 1`,
    )
    .get(campaignId) as any;

  if (best) {
    const cite = assertClaimIsCitable(store, best.hypothesis_id);
    out.push(`BEST      ${best.title}`);
    out.push(`          ${best.status} · val ${best.primary_value?.toFixed(6)} vs baseline ${best.baseline_value?.toFixed(6)}`);
    out.push(`          belief(derived) ${best.belief_derived?.toFixed(3) ?? "n/a"} · ${cite.citable ? "citable" : `NOT CITABLE: missing ${cite.missing.join(", ")}`}`);
  } else {
    out.push(`BEST      no supported claim`);
  }

  const uncitable = store.db
    .prepare("SELECT hypothesis_id FROM hypotheses WHERE campaign_id = ? AND status <> 'proposed'")
    .all(campaignId) as Array<{ hypothesis_id: string }>;
  const bad = uncitable.filter((h) => !assertClaimIsCitable(store, h.hypothesis_id).citable);
  if (bad.length > 0) {
    out.push(`WARNING   ${bad.length}/${uncitable.length} judged claims are not fully citable`);
  }

  // Generalisation trajectory. The visible split is what candidates are scored
  // on, so reporting it alone would flatter the campaign: a candidate can
  // improve val while the unseen holdout does not move. Showing both is the
  // difference between "the metric went down" and "the model got better".
  const advances = store.db.prepare(
    `SELECT payload_json FROM events WHERE campaign_id = ? AND event_type = 'baseline.advanced'
     ORDER BY seq`,
  ).all(campaignId) as Array<{ payload_json: string }>;
  if (advances.length > 0) {
    out.push(`GENERALISATION`);
    const firstEval = store.db.prepare(
      `SELECT primary_value, result_json FROM evaluations WHERE campaign_id = ? ORDER BY accepted_at LIMIT 1`,
    ).get(campaignId) as any;
    out.push(`          ${advances.length} baseline advance(s); each promotion required 3 seeds to reproduce`);
    const holdoutRows = store.db.prepare(
      `SELECT e.primary_value AS val, e.result_json AS raw FROM evaluations e
       JOIN attempts at ON at.attempt_id = e.attempt_id
       JOIN runs r ON r.run_id = at.run_id
       JOIN hypotheses h ON h.hypothesis_id = r.hypothesis_id
       WHERE h.campaign_id = ? AND h.status = 'replicated' ORDER BY e.accepted_at`,
    ).all(campaignId) as Array<{ val: number; raw: string }>;
    for (const row of holdoutRows) {
      const hold = JSON.parse(row.raw)?.metrics?.holdout_bpc;
      out.push(`          val ${row.val?.toFixed(6)}   holdout ${typeof hold === "number" ? hold.toFixed(6) : "n/a"}`);
    }
    if (firstEval) out.push(`          read the holdout column: val gains that the holdout does not follow are not generalisation`);
  }

  const chain = store.verifyEventChain();
  const events = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ?")
    .get(campaignId) as { n: number };
  out.push(`TRACE     ${events.n} events · hash chain ${chain.ok ? "verified" : "BROKEN"}`);

  const ladder = assessLadder(store, campaignId);
  out.push(`LADDER    ${ladder.level} — ${ladder.label}`);
  out.push(`          ${ladder.justification}`);
  out.push(`          NOT higher: ${ladder.blockedFrom}`);

  return out.join("\n");
}
