/**
 * Portfolio: lane selection, budget accounting, and the stop policy.
 *
 * This is the anti-grinding machinery. It is deliberately deterministic code
 * rather than a model decision, because a model asked to police its own budget
 * will reliably decide that its current direction deserves more of it.
 *
 * Three rules do the work:
 *
 *  1. The falsify lane holds a reserved floor that NO other lane may consume,
 *     from the first hypothesis onward. A leading direction cannot spend away
 *     the work most likely to disprove it.
 *  2. Parameter-only experiments draw from a separate quota. When it is spent,
 *     the manager must propose a structural change or the campaign stops for
 *     lack of a motivated path.
 *  3. Stopping is a legitimate outcome. "Keep going" is never a stop policy.
 */

import { LANES, type Lane, type Store } from "../store/store.js";

// Re-exported so existing importers keep working; defined in store.ts,
// alongside the type and the schema substitution, so all three agree.
export { LANES };

/**
 * Default allocation. `moonshot` exists because every other lane judges a
 * candidate against the baseline immediately, which discards any idea that must
 * get worse before it gets better — the exact greedy failure `plans/02` §F3
 * identifies in keep/revert loops. A moonshot is granted several cycles to
 * develop, and only its final step is judged for promotion.
 */
export const DEFAULT_LANE_SHARES: Record<Lane, number> = {
  control: 0.20, exploit: 0.25, mechanism: 0.25, falsify: 0.15, moonshot: 0.15,
};

export interface CampaignBudget {
  wallMs: number;
  costUsd: number;
  maxCycles: number;
  /** Share of total cycles that may be parameter-class changes. */
  parameterQuota: number;
  /** Consecutive infrastructure failures tolerated before stopping. */
  repairCap: number;
}

export interface LaneState {
  lane: Lane;
  allocated: number;
  consumed: number;
  reservedFloor: number;
  remaining: number;
}

export interface Spend {
  cycles: number;
  costUsd: number;
  wallMs: number;
  parameterCycles: number;
  consecutiveFailures: number;
}

export type StopReason =
  | "wall_clock_exhausted" | "cost_exhausted" | "cycle_limit_reached"
  | "repeated_invalid_implementations" | "repeated_aborted_cycles"
  | "no_admissible_lane" | "operator_stop";

/** Reserve enough wall clock to finish a cycle rather than be cut off mid-run. */
export const CYCLE_HEADROOM_MS = 12 * 60_000;

export interface Decision {
  kind: "run" | "stop";
  lane?: Lane;
  /** True when the parameter quota is spent and only structural work is allowed. */
  parameterQuotaExhausted?: boolean;
  stopReason?: StopReason;
  explanation: string;
}

/** Read the lane ledger for a campaign. */
export function laneStates(store: Store, campaignId: string): LaneState[] {
  const rows = store.db
    .prepare(
      `SELECT lane, allocated, consumed, reserved_floor FROM budgets
       WHERE campaign_id = ? AND category = 'runs'`,
    )
    .all(campaignId) as Array<{ lane: Lane; allocated: number; consumed: number; reserved_floor: number }>;
  return rows.map((r) => ({
    lane: r.lane,
    allocated: r.allocated,
    consumed: r.consumed,
    reservedFloor: r.reserved_floor,
    remaining: r.allocated - r.consumed,
  }));
}

export function currentSpend(store: Store, campaignId: string, startedAtMs: number): Spend {
  const agg = store.db
    .prepare(
      `SELECT COUNT(*) AS cycles,
              COALESCE(SUM(consumed), 0) AS consumed
       FROM budgets WHERE campaign_id = ? AND category = 'runs'`,
    )
    .get(campaignId) as { cycles: number; consumed: number };

  const cost = store.db
    .prepare(
      `SELECT COALESCE(SUM(consumed), 0) AS c FROM budgets
       WHERE campaign_id = ? AND category = 'model_cost_usd'`,
    )
    .get(campaignId) as { c: number };

  const paramCycles = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM hypotheses
       WHERE campaign_id = ? AND change_class = 'parameter'`,
    )
    .get(campaignId) as { n: number };

  return {
    cycles: agg.consumed,
    costUsd: cost.c,
    wallMs: Date.now() - startedAtMs,
    parameterCycles: paramCycles.n,
    consecutiveFailures: consecutiveFailures(store, campaignId, new Date(startedAtMs).toISOString()),
  };
}

/**
 * Count terminal statuses indicating the harness, not the science, is failing.
 * A refutation is a result; an invalid implementation is a malfunction.
 *
 * Scoped to hypotheses created during the CURRENT run. Two reasons:
 *
 *  - "repeated infrastructure failure" is a statement about now. Scanning all
 *    history makes a restarted campaign inherit old failures and stop before it
 *    runs anything.
 *  - An operator may invalidate past cycles deliberately (a mismatched baseline,
 *    a corrected comparison). That is a repair, not a malfunction, and counting
 *    it as one halted a fresh 3-hour run at cycle zero.
 */
export function consecutiveFailures(store: Store, campaignId: string, sinceIso?: string): number {
  const rows = sinceIso
    ? store.db.prepare(
        `SELECT status FROM hypotheses WHERE campaign_id = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 20`,
      ).all(campaignId, sinceIso) as Array<{ status: string }>
    : store.db.prepare(
        `SELECT status FROM hypotheses WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 20`,
      ).all(campaignId) as Array<{ status: string }>;
  let n = 0;
  for (const r of rows) {
    if (r.status === "implementation_invalid") n++;
    else break;
  }
  return n;
}

/**
 * Choose the next lane, or stop.
 *
 * Selection is "most under-served lane first", with the falsify floor treated
 * as untouchable by anyone else. Ties break in LANES order so the choice is
 * reproducible from state alone.
 */
export function decide(
  store: Store,
  campaignId: string,
  budget: CampaignBudget,
  startedAtMs: number,
): Decision {
  const spend = currentSpend(store, campaignId, startedAtMs);

  // Stop with headroom rather than starting a cycle that cannot finish. A cycle
  // cut off mid-run wastes its whole cost and leaves an orphan worktree.
  // A non-positive budget means "no ceiling of this kind". Used for open-ended
  // runs that end when the operator says so, not when a number is reached.
  // Every OTHER stop condition still applies, and the operator stop is checked
  // at every cycle boundary, so an unlimited run is still a stoppable one.
  if (budget.wallMs > 0 && spend.wallMs >= budget.wallMs - CYCLE_HEADROOM_MS) {
    return stop("wall_clock_exhausted",
      `wall-clock budget of ${Math.round(budget.wallMs / 60000)}m is spent ` +
      `(stopping with ${Math.round(CYCLE_HEADROOM_MS / 60000)}m headroom rather than starting a cycle that cannot finish)`);
  }
  if (budget.costUsd > 0 && spend.costUsd >= budget.costUsd) {
    return stop("cost_exhausted", `cost budget of $${budget.costUsd} is spent`);
  }
  if (budget.maxCycles > 0 && spend.cycles >= budget.maxCycles) {
    return stop("cycle_limit_reached", `cycle limit of ${budget.maxCycles} reached`);
  }
  if (spend.consecutiveFailures >= budget.repairCap) {
    return stop(
      // NOT "infrastructure failure". The three invalids that first triggered
      // this had three different causes - a kernel that would not compile, an
      // edit to a config key outside the declared surface, and results that
      // were simply wrong. Every one was the harness working exactly as
      // designed. Reporting that as infrastructure failure tells the operator
      // the system is broken and sends them to repair a component that is fine,
      // when the real signal is that the EXECUTOR is producing bad candidates.
      "repeated_invalid_implementations",
      `${spend.consecutiveFailures} consecutive candidates were invalid (repair cap ${budget.repairCap}). `
      + "The harness rejected each one correctly; this is a signal about the executor's output, "
      + "not about the harness. Check the per-cycle reasons before changing anything.",
    );
  }

  const lanes = laneStates(store, campaignId);
  if (lanes.length === 0) return stop("no_admissible_lane", "no lane budgets are configured");

  // A lane is admissible if it has budget left. The falsify floor is not
  // available to anyone but falsify, which is the whole point of a floor.
  let admissible = lanes.filter((l) => l.remaining > 0);
  if (admissible.length === 0) {
    // Allocations are SHARES, not a fuel tank.
    //
    // Their job is to stop a promising direction from crowding out
    // falsification and replication - which is a question of proportion, and
    // stays meaningful however long the run goes on. Treating them as a
    // quantity that runs out ended a healthy campaign at 100 cycles with the
    // wall clock, the cost cap and the cycle cap all still unspent.
    //
    // When every lane is spent, renew them all in the same ratio and carry on.
    // The real ceilings - wall clock, cost, cycle count, operator stop - are
    // unaffected, and the deficit ordering below still serves whichever lane is
    // furthest behind its share.
    store.transact((s) => {
      for (const l of lanes) {
        s.db.prepare(
          `UPDATE budgets SET allocated = allocated + ?
           WHERE campaign_id = ? AND category = 'runs' AND lane = ?`,
        ).run(Math.max(1, l.allocated), campaignId, l.lane);
      }
      s.appendEvent({
        campaignId, aggregateKind: "campaign", aggregateId: campaignId, aggregateRevision: 12,
        eventType: "campaign.lanes_renewed", actorKind: "supervisor",
        idempotencyKey: `lanes.renewed:${campaignId}:${Date.now()}`,
        payload: { reason: "all lanes spent; shares renewed in the same ratio",
                   lanes: lanes.map((l) => ({ lane: l.lane, was: l.allocated })) },
      });
    });
    admissible = laneStates(store, campaignId).filter((l) => l.remaining > 0);
    if (admissible.length === 0) {
      return stop("no_admissible_lane", "no lane budgets are configured");
    }
  }

  // Serve the lane furthest below its intended share, so falsification and
  // replication cannot be perpetually deferred by a promising exploit lane.
  const totalAllocated = lanes.reduce((a, l) => a + l.allocated, 0) || 1;
  const totalConsumed = lanes.reduce((a, l) => a + l.consumed, 0);
  const scored = admissible
    .map((l) => {
      const targetShare = l.allocated / totalAllocated;
      const actualShare = totalConsumed === 0 ? 0 : l.consumed / totalConsumed;
      return { lane: l.lane, deficit: targetShare - actualShare, order: LANES.indexOf(l.lane) };
    })
    .sort((a, b) => b.deficit - a.deficit || a.order - b.order);

  const chosen = scored[0]!;
  // At least one parameter experiment is always allowed: a tiny campaign would
  // otherwise report the quota as spent before it began.
  const parameterAllowance = Math.max(1, Math.floor(budget.maxCycles * budget.parameterQuota));
  const parameterQuotaExhausted = spend.parameterCycles >= parameterAllowance;

  return {
    kind: "run",
    lane: chosen.lane,
    parameterQuotaExhausted,
    // An unlimited ceiling has no remainder. Subtracting spend from a zero
    // budget printed "cycle 10/0; -4m and $-0.11 left", which reads as a run
    // that has overshot its limits rather than one that was given none.
    explanation:
      `lane=${chosen.lane} (deficit ${chosen.deficit.toFixed(3)}); ` +
      `cycle ${spend.cycles + 1}${budget.maxCycles > 0 ? `/${budget.maxCycles}` : " (no cycle cap)"}; ` +
      (budget.wallMs > 0
        ? `${Math.round((budget.wallMs - spend.wallMs) / 60000)}m left`
        : `${Math.round(spend.wallMs / 60000)}m elapsed, no time cap`) +
      " and " +
      (budget.costUsd > 0
        ? `$${(budget.costUsd - spend.costUsd).toFixed(2)} left`
        : `$${spend.costUsd.toFixed(2)} spent, no cost cap`) +
      (parameterQuotaExhausted ? "; parameter quota SPENT — structural change required" : ""),
  };
}

function stop(reason: StopReason, explanation: string): Decision {
  return { kind: "stop", stopReason: reason, explanation };
}

/** Charge a completed cycle to its lane and to the campaign totals. */
export function chargeCycle(
  store: Store,
  campaignId: string,
  lane: Lane,
  costUsd: number,
  wallMs: number,
  opts: { chargeLaneRun?: boolean } = {},
): void {
  if (opts.chargeLaneRun !== false) {
    store.db.prepare(
      `UPDATE budgets SET consumed = consumed + 1 WHERE campaign_id = ? AND lane = ? AND category = 'runs'`,
    ).run(campaignId, lane);
  }

  // Cost and wall time are campaign-wide; attribute them to the spending lane
  // so a report can show which lane consumed the budget.
  store.db.prepare(
    `INSERT INTO budgets (campaign_id, lane, category, allocated, consumed, reserved_floor)
     VALUES (?,?,?,0,?,0)
     ON CONFLICT(campaign_id, lane, category) DO UPDATE SET consumed = consumed + excluded.consumed`,
  ).run(campaignId, lane, "model_cost_usd", costUsd);

  store.db.prepare(
    `INSERT INTO budgets (campaign_id, lane, category, allocated, consumed, reserved_floor)
     VALUES (?,?,?,0,?,0)
     ON CONFLICT(campaign_id, lane, category) DO UPDATE SET consumed = consumed + excluded.consumed`,
  ).run(campaignId, lane, "wall_seconds", Math.round(wallMs / 1000));
}

/**
 * Belief derived from verified evidence by a registered rule.
 *
 * Deliberately NOT the model's self-reported confidence, which is stored
 * separately as `belief_advisory` and never read by the scheduler. This is a
 * simple log-odds update with fixed per-kind weights; the point is that the
 * number is reproducible from the evidence table, not that it is sophisticated.
 */
export const BELIEF_RULE_VERSION = "belief.v1";

const WEIGHTS: Record<string, number> = {
  supports: 1.0,
  weakens: -0.6,
  refutes: -1.5,
  neutral: 0,
};
const KIND_MULTIPLIER: Record<string, number> = {
  metric: 1.0,
  replication: 1.5,     // an independent rerun is worth more than a first result
  counterexample: 1.2,
  negative_result: 1.0,
  shortcut: 2.0,        // a detected shortcut is strong evidence against the claim
  leakage: 2.0,
  provenance: 0.3,
  observation: 0.3,
};

export function deriveBelief(store: Store, hypothesisId: string): number {
  const rows = store.db
    .prepare(
      `SELECT kind, polarity FROM evidence WHERE hypothesis_id = ? AND status = 'verified'`,
    )
    .all(hypothesisId) as Array<{ kind: string; polarity: string }>;

  let logOdds = 0; // prior 0.5
  for (const r of rows) {
    logOdds += (WEIGHTS[r.polarity] ?? 0) * (KIND_MULTIPLIER[r.kind] ?? 1);
  }
  const p = 1 / (1 + Math.exp(-logOdds));
  return Math.min(0.99, Math.max(0.01, p));
}
