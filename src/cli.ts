/**
 * autoresearch CLI. Foreground driver for v0 (the daemon arrives on day 4).
 *
 *   tsx src/cli.ts init
 *   tsx src/cli.ts cycle [--cycles N] [--manager-model M] [--executor-model M] [--keep-worktree]
 *   tsx src/cli.ts status
 *   tsx src/cli.ts verify
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { claimOwnership, clearRunFile, detach, inspect, requestStop } from "./daemon.js";
import { renderClaimCard } from "./report/claim-card.js";
import { runCampaign } from "./loop/campaign.js";
import { runCycle } from "./loop/cycle.js";
import { Harness } from "./core/harness.js";
import { createTinymlAdapter } from "./domain/tinyml-adapter.js";
import { createGenericAdapter, loadDomainConfig } from "./domain/generic-adapter.js";
import { DEFAULT_LANE_SHARES } from "./loop/portfolio.js";
import { latestCampaignId, normaliseCampaignConfig, nowIso, Store } from "./store/store.js";
import { clearSteer, requestSteer } from "./steer.js";
import { formatDuration, IntervalRecorder } from "./trace/intervals.js";

const PROJECT_ROOT = resolve(process.cwd());
const STATE_DIR = join(PROJECT_ROOT, ".autoresearch");
const DB_PATH = join(STATE_DIR, "state.sqlite");
/** Campaign to operate on. A project can hold several, one per domain. */
// No hardcoded campaign. A tool pointed at the wrong campaign reports the
// wrong campaign's state, which is worse than reporting nothing: the
// heartbeat once watched `tinyml-001` while `cuda-001` was the live run.
const CAMPAIGN_ID = argOf("campaign") ?? process.env.AR_CAMPAIGN ?? latestCampaignId();
/**
 * Baseline at campaign creation, at FULL precision.
 *
 * A truncated value here is not cosmetic: an unchanged model then differs from
 * the baseline by ~5e-7, which defeats the exact-no-change detection and makes
 * both CONTROL_CONFIRMED and INTERVENTION_HAD_NO_EFFECT unreachable.
 *
 * After a baseline advance the live value lives in campaigns.config_json; this
 * constant is only the seed.
 */
const BASELINE_BPC = 2.916446493250693;
/** Holdout metric of the seed baseline; leakage is judged on divergence from it. */
const BASELINE_HOLDOUT_BPC = 2.956792890192936;

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function arg(name: string, fallback?: string): string | undefined {
  return argOf(name) ?? fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function openStore(): Store {
  mkdirSync(STATE_DIR, { recursive: true });
  return Store.open(DB_PATH);
}

function ensureCampaign(store: Store): void {
  const existing = store.db
    .prepare("SELECT campaign_id FROM campaigns WHERE campaign_id = ?")
    .get(CAMPAIGN_ID);
  if (existing) return;

  store.transact((s) => {
    s.db.prepare(
      `INSERT INTO campaigns (campaign_id, title, objective, status, base_revision, config_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      CAMPAIGN_ID,
      arg("title", CAMPAIGN_ID)!,
      arg("objective", "Improve the primary metric without violating the task contract.")!,
      "running", "pending",
      JSON.stringify({
        baselinePrimary: Number(arg("baseline-primary", String(BASELINE_BPC))),
        baselineSecondary: Number(arg("baseline-secondary", String(BASELINE_HOLDOUT_BPC))),
        domain: argOf("domain") ?? "tinyml",
      }),
      nowIso(),
    );

    // Lane budgets. The falsify floor is non-borrowable: no other lane can
    // consume it, from the first hypothesis rather than from the third.
    // Falsify and moonshot carry non-borrowable floors: the work most likely to
    // disprove the leader, and the work that needs several cycles to pay off,
    // are exactly what a promising direction would otherwise consume.
    const floors: Partial<Record<string, number>> = { falsify: 0.15, moonshot: 0.10 };
    for (const [lane, share] of Object.entries(DEFAULT_LANE_SHARES)) {
      const floor = floors[lane] ?? 0;
      s.db.prepare(
        `INSERT INTO budgets (campaign_id, lane, category, allocated, reserved_floor)
         VALUES (?,?,'runs',?,?)`,
      ).run(CAMPAIGN_ID, lane, share * 100, floor * 100);
    }

    s.db.prepare(
      `INSERT INTO human_interventions (intervention_id, campaign_id, kind, changed_frontier, detail, occurred_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(`I-${Date.now()}`, CAMPAIGN_ID, "start", 0, "campaign created via CLI", nowIso());

    s.appendEvent({
      campaignId: CAMPAIGN_ID, aggregateKind: "campaign", aggregateId: CAMPAIGN_ID,
      aggregateRevision: 0, eventType: "campaign.created", actorKind: "human",
      idempotencyKey: `campaign.created:${CAMPAIGN_ID}`,
      payload: { baselinePrimary: BASELINE_BPC },
    });
  });
}

/**
 * The baseline the campaign is currently measured against.
 *
 * This MUST come from campaign state rather than the seed constant: after a
 * baseline advance, comparing new candidates against the original baseline
 * would credit every later result with the already-banked improvement.
 */
function currentBaselineHoldoutBpc(store: Store): number {
  const row = store.db.prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
    .get(CAMPAIGN_ID) as { config_json: string } | undefined;
  if (!row) return BASELINE_HOLDOUT_BPC;
  const v = Number(normaliseCampaignConfig(row.config_json).baselineSecondary);
  return Number.isFinite(v) ? v : BASELINE_HOLDOUT_BPC;
}

function currentBaselineBpc(store: Store): number {
  const row = store.db.prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
    .get(CAMPAIGN_ID) as { config_json: string } | undefined;
  if (!row) return BASELINE_BPC;
  const v = Number(normaliseCampaignConfig(row.config_json).baselinePrimary);
  return Number.isFinite(v) ? v : BASELINE_BPC;
}

/**
 * Build the harness for the configured domain.
 *
 * `--domain path/to/domain.json` runs any config-described field; with no flag
 * the built-in tinyml adapter is used. The loop itself never learns which.
 */
function makeHarness(): Harness {
  const domainPath = arg("domain");
  const adapter = domainPath
    ? createGenericAdapter(PROJECT_ROOT, loadDomainConfig(domainPath))
    : createTinymlAdapter(PROJECT_ROOT);
  return new Harness(PROJECT_ROOT, adapter);
}

/** Keep campaigns.base_revision truthful from the first cycle onward. */
function syncBaseRevision(store: Store): void {
  const base = makeHarness().ensureRepo();
  store.db
    .prepare("UPDATE campaigns SET base_revision = ? WHERE campaign_id = ? AND base_revision = 'pending'")
    .run(base, CAMPAIGN_ID);
}

/**
 * Run an unattended campaign under hard ceilings.
 *
 * Defaults are sized from measurement, not guesswork: a full cycle costs about
 * 235s and $0.005, so five hours is roughly 75 cycles and well under a dollar.
 * Wall clock is the binding constraint here, not money.
 */

async function cmdCampaign(): Promise<void> {
  // `--detach` re-launches this same command in a background process that
  // outlives the terminal, then returns immediately.
  if (flag("detach") && !process.env.AUTORESEARCH_DETACHED) {
    mkdirSync(STATE_DIR, { recursive: true });
    const self = fileURLToPath(import.meta.url);
    const passthrough = process.argv.slice(2).filter((a) => a !== "--detach");
    const { pid, logPath } = detach(STATE_DIR, self, passthrough);
    console.log(`campaign detached · pid ${pid}`);
    console.log(`log    : ${logPath}`);
    console.log(`follow : tail -f "${logPath}"`);
    console.log(`status : npx tsx src/cli.ts status`);
    console.log(`stop   : npx tsx src/cli.ts stop`);
    return;
  }

  const store = openStore();
  ensureCampaign(store);
  syncBaseRevision(store);

  // 0 means run until stopped. Every other ceiling still applies, and the
  // operator stop is honoured at each cycle boundary.
  const hours = Number(arg("hours", "5"));
  const budget = {
    wallMs: hours * 3_600_000,
    costUsd: Number(arg("max-cost", "5")),
    maxCycles: Number(arg("max-cycles", "120")),
    parameterQuota: Number(arg("parameter-quota", "0.20")),
    repairCap: Number(arg("repair-cap", "3")),
  };

  if (process.env.AUTORESEARCH_DETACHED) {
    claimOwnership(STATE_DIR, "(detached)", process.argv.slice(2));
  }

  console.log(`campaign start: ${hours}h ceiling, $${budget.costUsd} cost cap, ` +
              `${budget.maxCycles} cycle cap, repair cap ${budget.repairCap}`);
  console.log(`started at ${nowIso()}`);

  const summary = await runCampaign(store, {
    budget,
    stateDir: STATE_DIR,
    cycleDefaults: {
      projectRoot: PROJECT_ROOT,
      harness: makeHarness(),
      campaignId: CAMPAIGN_ID,
      managerModel: arg("manager-model"),
      executorModel: arg("executor-model"),
      managerTimeoutMs: 300_000,
      executorTimeoutMs: 900_000,
      experimentTimeoutMs: 900_000,
      evaluatorTimeoutMs: 600_000,
      baselinePrimary: currentBaselineBpc(store),
      baselineSecondary: currentBaselineHoldoutBpc(store),
      keepWorktree: false,
      stateDir: STATE_DIR,
    },
  });

  console.log(`\ncycles ${summary.cycles} · ${formatDuration(summary.wallMs)} · $${summary.costUsd.toFixed(4)}`);
  console.log(`statuses: ${Object.entries(summary.statuses).map(([k, v]) => `${v} ${k}`).join(" · ")}`);
  console.log(`
${renderClaimCard(store, CAMPAIGN_ID)}`);
  clearRunFile(STATE_DIR);
  store.close();
}

/** Ask a detached campaign to stop at the next cycle boundary. */
function cmdStop(): void {
  const live = inspect(STATE_DIR);
  if (live.state === "none") { console.log("no campaign is running"); return; }
  if (live.state === "stale") {
    console.log(`no campaign is running (${live.reason}); clearing the stale run file`);
    clearRunFile(STATE_DIR);
    return;
  }
  requestStop(STATE_DIR, arg("reason", "operator requested stop")!);
  console.log(`stop requested · pid ${live.run.pid} will finish its current cycle and exit`);
  console.log(`a cycle can take several minutes; watch ${live.run.logPath}`);
}

async function cmdCycle(): Promise<void> {
  const store = openStore();
  ensureCampaign(store);
  syncBaseRevision(store);
  const cycles = Number(arg("cycles", "1"));

  for (let i = 0; i < cycles; i++) {
    console.log(`\n=== cycle ${i + 1}/${cycles} ===`);
    const result = await runCycle(store, {
      projectRoot: PROJECT_ROOT,
      harness: makeHarness(),
      campaignId: CAMPAIGN_ID,
      managerModel: arg("manager-model"),
      executorModel: arg("executor-model"),
      managerTimeoutMs: 300_000,
      executorTimeoutMs: 900_000,
      experimentTimeoutMs: 900_000,
      evaluatorTimeoutMs: 600_000,
      baselinePrimary: currentBaselineBpc(store),
      baselineSecondary: currentBaselineHoldoutBpc(store),
      keepWorktree: flag("keep-worktree"),
    });

    const cost = result.usage.manager.costUsd + result.usage.executor.costUsd;
    console.log(`status        : ${result.status}`);
    if (result.verdict) console.log(`why           : ${result.verdict.explanation}`);
    if (result.abortReason) console.log(`abort         : ${result.abortReason}`);
    if (result.primaryValue !== null) {
      console.log(`${makeHarness().domain.metric.name.padEnd(14)}: ${result.primaryValue.toFixed(6)} ` +
                  `(baseline ${currentBaselineBpc(store).toFixed(6)})`);
      console.log(`holdout_bpc   : ${result.holdoutValue?.toFixed(6) ?? "n/a"}`);
    }
    if (result.declaredChangeClass) {
      console.log(
        `change_class  : declared=${result.declaredChangeClass} actual=${result.actualChangeClass}` +
        `${result.classMismatch ? "  <-- MISMATCH, charged to actual" : ""}`,
      );
    }
    console.log(`cost          : $${cost.toFixed(4)}  (${result.usage.manager.totalTokens + result.usage.executor.totalTokens} tokens)`);
    console.log(`duration      : ${formatDuration(result.durationMs)}`);
  }
  store.close();
}

function cmdStatus(): void {
  const store = openStore();
  const c = store.db.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").get(CAMPAIGN_ID) as any;
  if (!c) {
    console.log("no campaign yet — run `cycle` first");
    store.close();
    return;
  }

  const first = store.db.prepare("SELECT MIN(started_ms) AS a FROM intervals WHERE campaign_id = ?")
    .get(CAMPAIGN_ID) as { a: number | null };
  const rec = new IntervalRecorder(store);
  const spanStart = first.a ?? Date.now();
  const d = rec.decompose(CAMPAIGN_ID, "campaign", spanStart, Date.now());

  const live = inspect(STATE_DIR);
  const liveness = live.state === "running"
    ? `RUNNING (pid ${live.run.pid}, since ${live.run.startedAt})`
    : live.state === "stale"
      ? `NOT RUNNING — ${live.reason}`
      : "not running";
  console.log(`CAMPAIGN  ${c.campaign_id}   STATUS  ${c.status}   PROCESS  ${liveness}`);
  if (live.state === "running") console.log(`LOG       ${live.run.logPath}`);
  console.log(`SPAN      ${formatDuration(d.spanMs)}`);
  for (const [cat, ms] of Object.entries(d.byCategory).sort((a, b) => b[1] - a[1])) {
    const pct = d.spanMs > 0 ? ((ms / d.spanMs) * 100).toFixed(1) : "0.0";
    console.log(`  ${cat.padEnd(16)} ${formatDuration(ms).padStart(9)}  (${pct}%)`);
  }
  console.log(`  exact decomposition: ${d.exact}`);

  const byStatus = store.db.prepare(
    "SELECT status, COUNT(*) AS n FROM hypotheses WHERE campaign_id = ? GROUP BY status",
  ).all(CAMPAIGN_ID) as Array<{ status: string; n: number }>;
  console.log(`CLAIMS    ${byStatus.map((r) => `${r.n} ${r.status}`).join(" · ") || "none yet"}`);

  const byLane = store.db.prepare(
    "SELECT lane, COUNT(*) AS n FROM hypotheses WHERE campaign_id = ? GROUP BY lane",
  ).all(CAMPAIGN_ID) as Array<{ lane: string; n: number }>;
  console.log(`LANES     ${byLane.map((r) => `${r.lane}=${r.n}`).join(" · ") || "none yet"}`);

  const hi = store.db.prepare(
    "SELECT COUNT(*) AS n, SUM(changed_frontier) AS f FROM human_interventions WHERE campaign_id = ?",
  ).get(CAMPAIGN_ID) as { n: number; f: number | null };
  console.log(`HUMAN     ${hi.n} interventions (${hi.f ?? 0} changed the frontier)`);

  const ev = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ?")
    .get(CAMPAIGN_ID) as { n: number };
  console.log(`EVENTS    ${ev.n} (chain ${store.verifyEventChain().ok ? "verified" : "BROKEN"})`);
  console.log(`LADDER    A3 ceiling by construction — no novelty or external validation (SCOPE.md)`);
  store.close();
}

/**
 * Advance the baseline onto the best replicated claim.
 *
 * Normally the campaign driver does this automatically after replication. This
 * command exists for the case where that failed and an operator repairs it —
 * and it records the repair as a human intervention, because a human moving the
 * baseline is exactly the kind of thing the intervention count exists to expose.
 */
function cmdAdvance(): void {
  const store = openStore();
  const best = store.db.prepare(
    `SELECT h.hypothesis_id, h.title FROM hypotheses h
     WHERE h.campaign_id = ? AND h.status = 'replicated'
     ORDER BY h.updated_at DESC LIMIT 1`,
  ).get(CAMPAIGN_ID) as { hypothesis_id: string; title: string } | undefined;
  if (!best) { console.log("no replicated claim to advance onto"); store.close(); return; }

  const row = store.db.prepare(
    `SELECT a.relative_path FROM artifacts a
     JOIN attempts at ON at.attempt_id = a.attempt_id
     JOIN runs r ON r.run_id = at.run_id
     WHERE r.hypothesis_id = ? AND a.kind = 'candidate-diff'
     ORDER BY a.sealed_at DESC LIMIT 1`,
  ).get(best.hypothesis_id) as { relative_path: string } | undefined;
  if (!row) { console.log("candidate diff not sealed; cannot advance"); store.close(); return; }

  const diff = readFileSync(join(STATE_DIR, "artifacts", row.relative_path), "utf8");
  const from = (store.db.prepare("SELECT base_revision FROM campaigns WHERE campaign_id = ?")
    .get(CAMPAIGN_ID) as { base_revision: string }).base_revision;
  const commit = makeHarness().advance(from, diff, `advance: ${best.hypothesis_id}`);
  if (!commit.ok) { console.log(`advance failed: ${commit.failure}`); store.close(); return; }

  const primary = store.db.prepare(
    `SELECT e.primary_value FROM evaluations e
     JOIN attempts at ON at.attempt_id = e.attempt_id
     JOIN runs r ON r.run_id = at.run_id
     WHERE r.hypothesis_id = ? ORDER BY e.accepted_at DESC LIMIT 1`,
  ).get(best.hypothesis_id) as { primary_value: number } | undefined;

  store.transact((s) => {
    s.db.prepare("UPDATE campaigns SET base_revision = ?, revision = revision + 1 WHERE campaign_id = ?")
      .run(commit.revision, CAMPAIGN_ID);
    if (primary?.primary_value !== undefined && Number.isFinite(primary.primary_value)) {
      const cfgRow = s.db.prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
        .get(CAMPAIGN_ID) as { config_json: string };
      const cfg = normaliseCampaignConfig(cfgRow.config_json);
      cfg.baselinePrimary = primary.primary_value;
      s.db.prepare("UPDATE campaigns SET config_json = ? WHERE campaign_id = ?")
        .run(JSON.stringify(cfg), CAMPAIGN_ID);
    }
    s.db.prepare(
      `INSERT INTO human_interventions (intervention_id, campaign_id, kind, changed_frontier, detail, occurred_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(`I-${Date.now()}`, CAMPAIGN_ID, "manual_fix", 1,
          `operator advanced baseline onto ${best.hypothesis_id} after an automatic advance failed`, nowIso());
    s.appendEvent({
      campaignId: CAMPAIGN_ID, aggregateKind: "campaign", aggregateId: CAMPAIGN_ID,
      aggregateRevision: 3, eventType: "baseline.advanced", actorKind: "human",
      idempotencyKey: `baseline.advanced:${best.hypothesis_id}`,
      payload: { from, to: commit.revision, hypothesisId: best.hypothesis_id,
                 newBaselineBpc: primary?.primary_value ?? null, byOperator: true },
    });
  });
  console.log(`baseline ${from.slice(0, 8)} -> ${commit.revision.slice(0, 8)} on ${best.hypothesis_id}`);
  console.log(`  ${best.title}`);
  console.log(`  new baseline ${makeHarness().domain.metric.name}: ` +
              `${primary?.primary_value?.toFixed(6) ?? "unknown"}`);
  console.log(`  recorded as a human intervention (changed_frontier=1)`);
  store.close();
}

/**
 * Register a deliberate change to the protected evaluator.
 *
 * Run this AFTER editing anything under .autoresearch-protected/. Without it,
 * the next cycle sees an unexplained mutation and reports the candidate for
 * evasion - which is what happened when the leakage floor was recalibrated
 * mid-campaign. Registering does not excuse the change: in-flight cycles are
 * still void, because they were measured against a moving evaluator.
 */
/**
 * Leave a note for the manager, applied at the next cycle boundary.
 *
 * Deliberately NOT a way to change thresholds, verdicts, or the evaluator: a
 * steer redirects attention, and the contract still decides what is true. It is
 * recorded as a human intervention so the ledger shows every hand that shaped a
 * finding.
 */
function cmdSteer(): void {
  if (flag("clear")) {
    clearSteer(STATE_DIR);
    console.log("pending steer withdrawn");
    return;
  }
  const text = process.argv.slice(3).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!text) {
    console.log('usage: cli.ts steer "what the manager should consider next"');
    console.log("       cli.ts steer --clear     (withdraw a pending steer)");
    return;
  }
  requestSteer(STATE_DIR, text);
  console.log("steer queued; the manager sees it at the next cycle boundary:");
  console.log(`  "${text}"`);
  console.log("recorded as a human intervention; it cannot change any threshold");
}

function cmdEvaluatorChange(): void {
  const store = openStore();
  const hash = makeHarness().protectedHash();
  const reason = arg("reason", "unspecified operator change")!;
  store.transact((s) => {
    s.appendEvent({
      campaignId: CAMPAIGN_ID, aggregateKind: "campaign", aggregateId: CAMPAIGN_ID,
      aggregateRevision: 8, eventType: "evaluator.changed", actorKind: "human",
      idempotencyKey: `evaluator.changed:${hash}`,
      payload: { protectedHash: hash, reason, at: nowIso() },
    });
    s.db.prepare(
      `INSERT INTO human_interventions (intervention_id, campaign_id, kind, changed_frontier, detail, occurred_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(`I-${Date.now()}`, CAMPAIGN_ID, "config_change", 1,
      `operator changed the protected evaluator: ${reason}`, nowIso());
  });
  console.log(`registered protected-tree hash ${hash.slice(0, 16)}`);
  console.log(`reason: ${reason}`);
  console.log("in-flight cycles remain void; later cycles will accept this evaluator");
  store.close();
}

function cmdVerify(): void {
  const store = openStore();
  const chain = store.verifyEventChain();
  const rec = new IntervalRecorder(store);
  const overlaps = rec.findOverlaps(CAMPAIGN_ID, "campaign");
  console.log(`event chain : ${chain.ok ? "OK" : `BROKEN at seq ${(chain as any).brokenAtSeq}: ${(chain as any).reason}`}`);
  console.log(`overlaps    : ${overlaps.length === 0 ? "none" : JSON.stringify(overlaps)}`);
  store.close();
  if (!chain.ok || overlaps.length > 0) process.exitCode = 1;
}

const cmd = process.argv[2];
switch (cmd) {
  case "init": openStore().close(); console.log(`initialised ${DB_PATH}`); break;
  case "cycle": await cmdCycle(); break;
  case "campaign": await cmdCampaign(); break;
  case "status": cmdStatus(); break;
  case "advance": { cmdAdvance(); break; }
  case "stop": cmdStop(); break;
  case "steer": cmdSteer(); break;
  case "evaluator-change": cmdEvaluatorChange(); break;
  case "card": {
    const s2 = openStore();
    console.log(renderClaimCard(s2, CAMPAIGN_ID));
    s2.close();
    break;
  }
  case "verify": cmdVerify(); break;
  default:
    console.log([
      "usage:",
      "  cli.ts init",
      "  cli.ts cycle    [--cycles N] [--manager-model M] [--executor-model M] [--keep-worktree]",
      "  cli.ts campaign [--detach] [--domain path/to/domain.json] [--hours 5] [--max-cost 5] [--max-cycles 120] [--repair-cap 3]",
      "                  [--parameter-quota 0.20] [--manager-model M] [--executor-model M]",
      "  cli.ts stop [--reason \"...\"]",
      "  cli.ts steer \"try shared-memory staging next\"   (applied at the next cycle boundary)",
      "  cli.ts evaluator-change --reason \"...\"   (run after editing .autoresearch-protected/)",
      "  cli.ts status",
      "  cli.ts card",
      "  cli.ts advance",
      "  cli.ts verify",
    ].join("\n"));
    process.exitCode = 1;
}
