/**
 * Campaign driver: run cycles until a stop condition is met.
 *
 * The important property is that this loop has no way to express "keep going".
 * Every iteration asks the portfolio allocator for a decision, and the allocator
 * is free to answer "stop". Wall clock, cost, cycle count, lane exhaustion, and
 * consecutive infrastructure failure are all terminal — an honest end, not a
 * harness failure.
 *
 * The driver also owns replication and baseline advance, because both are
 * cross-cycle decisions that no single cycle can make for itself.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";


import { runCycle, type CycleConfig, type CycleResult } from "./cycle.js";
import type { Harness } from "../core/harness.js";
import { closeRun, openRun, recordEvidence } from "./persist.js";
import { chargeCycle, decide, deriveBelief, type CampaignBudget, type StopReason } from "./portfolio.js";
import { normaliseCampaignConfig, nowIso, sha256, type Store } from "../store/store.js";
import { formatDuration } from "../trace/intervals.js";
import { clearStopRequest, processStartId, stopRequested } from "../daemon.js";
import { calibrate, measuredFloor, recordCalibration } from "./calibrate.js";
import { ProgressHeartbeat } from "../supervision/progress-heartbeat.js";
import { observeBlockingOperation } from "../supervision/progress-heartbeat.js";

export interface CampaignOptions {
  budget: CampaignBudget;
  /** Directory holding the run/stop control files; enables graceful stop. */
  stateDir?: string;
  cycleDefaults: Omit<CycleConfig, "assignedLane" | "parameterQuotaExhausted">;

  onCycle?: (result: CycleResult, index: number) => void;
  log?: (line: string) => void;
}

export interface CampaignSummary {
  cycles: number;
  stopReason: StopReason;
  stopExplanation: string;
  wallMs: number;
  costUsd: number;
  statuses: Record<string, number>;
}

/** Aborted cycles do no research; too many in a row means the harness is broken. */
const MAX_CONSECUTIVE_ABORTS = 4;

/** A cycle that never reached a worker spent no tokens. */
const NO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

export async function runCampaign(store: Store, opts: CampaignOptions): Promise<CampaignSummary> {
  const { campaignId } = opts.cycleDefaults;
  const startedAtMs = Date.now();
  const log = opts.log ?? ((l: string) => console.log(l));

  let cycles = 0;
  let costUsd = 0;
  let consecutiveAborts = 0;
  const statuses: Record<string, number> = {};

  // Clear any previous stop reason: a running campaign that still reports why it
  // last stopped is a status field telling a falsehood, which is the one thing
  // this system is not allowed to do.
  store.db.prepare("UPDATE campaigns SET status = 'running', stop_reason = NULL WHERE campaign_id = ?")
    .run(campaignId);

  // Measure the noise floor before doing any research.
  //
  // The first thing a campaign does is re-run its own unchanged baseline a few
  // times and look at the spread. Nothing smaller than that spread can be a
  // result, and every threshold registered later is validated against it. A
  // declared floor is a guess, and a guessed floor is what let a baseline
  // advance on 3.2 GB/s of noise.
  const h0: Harness = opts.cycleDefaults.harness;
  if (measuredFloor(store, campaignId, 0) <= 0) {
    const cal = calibrate(store, h0, {
      campaignId,
      projectRoot: opts.cycleDefaults.projectRoot,
      baseRevision: baseRevisionOf(store, campaignId),
      baselineSecondary: opts.cycleDefaults.baselineSecondary ?? null,
      experimentTimeoutMs: opts.cycleDefaults.experimentTimeoutMs,
      evaluatorTimeoutMs: opts.cycleDefaults.evaluatorTimeoutMs,
      log,
    });
    recordCalibration(store, campaignId, cal);
    // The measured mean is a better baseline than a hand-entered constant: it
    // is this device, this build, today.
    if (cal.samples.length >= 2 && Number.isFinite(cal.mean)) {
      opts.cycleDefaults.baselinePrimary = cal.mean;
      store.transact((st) => {
        const row = st.db.prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
          .get(campaignId) as { config_json: string };
        const cfg = JSON.parse(row.config_json);
        cfg.baselinePrimary = cal.mean;
        st.db.prepare("UPDATE campaigns SET config_json = ? WHERE campaign_id = ?")
          .run(JSON.stringify(cfg), campaignId);
      });
      log(`    baseline set from measurement: ${cal.mean.toFixed(6)}`);
    }
  }

  for (;;) {
    // An operator stop is honoured at a cycle boundary, so a night's work is
    // never abandoned half-finished.
    const requested = opts.stateDir ? stopRequested(opts.stateDir) : null;
    if (requested) {
      log(`
STOP: operator_stop — ${requested.reason}`);
      store.transact((s) => {
        s.db.prepare("UPDATE campaigns SET status='stopped', stop_reason=? WHERE campaign_id=?")
          .run("operator_stop", campaignId);
        s.appendEvent({
          campaignId, aggregateKind: "campaign", aggregateId: campaignId, aggregateRevision: 7,
          eventType: "campaign.stopped", actorKind: "human",
          idempotencyKey: `campaign.operator_stop:${Date.now()}`,
          payload: { reason: requested.reason, cycles },
        });
      });
      if (opts.stateDir) clearStopRequest(opts.stateDir);
      return {
        cycles, stopReason: "operator_stop", stopExplanation: requested.reason,
        wallMs: Date.now() - startedAtMs, costUsd, statuses,
      };
    }

    const decision = decide(store, campaignId, opts.budget, startedAtMs);
    if (decision.kind === "stop") {
      log(`\nSTOP: ${decision.stopReason} — ${decision.explanation}`);
      store.transact((s) => {
        s.db.prepare("UPDATE campaigns SET status = 'stopped', stop_reason = ? WHERE campaign_id = ?")
          .run(decision.stopReason!, campaignId);
        s.appendEvent({
          campaignId, aggregateKind: "campaign", aggregateId: campaignId, aggregateRevision: 1,
          eventType: "campaign.stopped", actorKind: "supervisor",
          idempotencyKey: `campaign.stopped:${campaignId}:${Date.now()}`,
          payload: { reason: decision.stopReason, explanation: decision.explanation, cycles },
        });
      });
      return {
        cycles, stopReason: decision.stopReason!, stopExplanation: decision.explanation,
        wallMs: Date.now() - startedAtMs, costUsd, statuses,
      };
    }

    cycles++;
    log(`\n=== cycle ${cycles} · ${decision.explanation} ===`);

    // An unexpected throw inside a cycle used to kill the campaign outright.
    // That is the wrong blast radius: one malformed candidate, one dangling
    // revision, or one harness defect should cost a cycle, not a night's work.
    // The error becomes an aborted cycle and flows into the existing
    // consecutive-abort machinery, so a systematic fault still stops the run
    // after MAX_CONSECUTIVE_ABORTS instead of spinning through the budget.
    // The message is recorded, because a crash whose reason is lost cannot be
    // fixed in the morning.
    let result: CycleResult;
    try {
      result = await runCycle(store, {
        ...opts.cycleDefaults,
        assignedLane: decision.lane!,
        parameterQuotaExhausted: decision.parameterQuotaExhausted ?? false,
      });
    } catch (err) {
      const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      log(`  CYCLE THREW — ${detail.split("\n")[0]}`);
      store.appendEvent({
        campaignId, aggregateKind: "cycle", aggregateId: `cycle-${cycles}`, aggregateRevision: 0,
        eventType: "cycle.threw", actorKind: "system",
        idempotencyKey: `cycle.threw:${campaignId}:${cycles}:${Date.now()}`,
        payload: { lane: decision.lane, detail: detail.slice(0, 4000) },
      });
      result = {
        cycleId: `cycle-${cycles}-threw`, status: "aborted", verdict: null,
        hypothesisId: null, contractId: null,
        declaredChangeClass: null, actualChangeClass: null, classMismatch: false,
        primaryValue: null, holdoutValue: null,
        usage: { architect: NO_USAGE, manager: NO_USAGE, executor: NO_USAGE },
        abortReason: "cycle_threw", durationMs: 0, lane: decision.lane!,
        citable: false, missingCitations: [], costUsd: 0,
      };
    }

    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    costUsd += result.costUsd;

    // An aborted cycle did no research, so it must not consume the lane's
    // allocation — otherwise a failed manager call silently spends the
    // protected falsification budget (observed in calibration: one abort
    // consumed the only falsify slot, and the lane was never served again).
    // Cost and wall time are still charged, because they were really spent.
    chargeCycle(store, campaignId, decision.lane!, result.costUsd, result.durationMs, {
      chargeLaneRun: result.status !== "aborted",
    });

    if (result.status === "aborted" && result.abortReason?.startsWith("provider_rate_limited")) {
      consecutiveAborts = 0;
      await waitForProviderQuota(opts, result.abortReason, log);
      continue;
    }

    if (result.status === "aborted") {
      consecutiveAborts++;
      // Charge a repeatedly-aborting lane so the allocator stops re-serving it.
      // Aborts deliberately cost no research budget, but that lets one broken
      // lane keep winning the deficit race and march the campaign into the
      // abort cap. After two aborts in a row, the lane pays for the next one.
      if (consecutiveAborts >= 2) {
        chargeCycle(store, campaignId, decision.lane!, 0, 0, { chargeLaneRun: true });
        log(`  (lane ${decision.lane} charged after ${consecutiveAborts} consecutive aborts)`);
      }
      if (consecutiveAborts >= MAX_CONSECUTIVE_ABORTS) {
        log(`
STOP: repeated_aborted_cycles — ${consecutiveAborts} in a row, so no research is being produced`);
        store.db.prepare("UPDATE campaigns SET status='stopped', stop_reason=? WHERE campaign_id=?")
          .run("repeated_aborted_cycles", campaignId);
        return {
          cycles, stopReason: "repeated_aborted_cycles",
          stopExplanation: `${consecutiveAborts} consecutive aborted cycles`,
          wallMs: Date.now() - startedAtMs, costUsd, statuses,
        };
      }
    } else {
      consecutiveAborts = 0;
    }

    logResult(log, result, opts.cycleDefaults.harness.domain.metric.name);
    opts.onCycle?.(result, cycles);

    // Replication is not optional for a claim that wants to be believed: a
    // single-seed win is exactly the "lucky seed" the audit warns about.
    if (result.status === "provisionally_supported" && result.hypothesisId) {
      await replicate(store, opts, result, log);
    }
  }
}

async function waitForProviderQuota(
  opts: CampaignOptions,
  reason: string,
  log: (line: string) => void,
): Promise<void> {
  const now = Date.now();
  const daily = reason.includes("free-models-per-day");
  const nextUtc = Date.UTC(
    new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1,
  ) + 30_000;
  const resumeAt = daily ? nextUtc : now + 5 * 60_000;
  const stateDir = opts.stateDir ?? join(opts.cycleDefaults.projectRoot, ".autoresearch");
  const heartbeat = new ProgressHeartbeat(
    join(stateDir, "attempts", "provider-wait", opts.cycleDefaults.campaignId, "heartbeat.json"),
    { campaignId: opts.cycleDefaults.campaignId, cycleId: "provider-wait", processStartId: processStartId(process.pid) },
  );
  log(`  provider quota unavailable; pausing without spending attempts until ${new Date(resumeAt).toISOString()}`);

  while (Date.now() < resumeAt) {
    if (opts.stateDir && stopRequested(opts.stateDir)) {
      heartbeat.complete("operator requested stop during provider wait");
      return;
    }
    const remaining = resumeAt - Date.now();
    heartbeat.activity(
      "waiting_external",
      `OpenRouter quota cooldown; resume in ${Math.max(0, Math.ceil(remaining / 60_000))}m`,
      null,
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.max(1, remaining))));
  }
  heartbeat.complete("provider cooldown complete");
}

/**
 * Re-run a supported candidate under fresh seeds. The candidate code is fixed;
 * only the seed moves, so a result that survives is not a seed artifact.
 *
 * A claim that survives all seeds becomes `replicated` and is eligible for
 * baseline advance. One that does not is downgraded to `inconclusive`, because
 * "it worked once" is not a finding.
 */
async function replicate(
  store: Store,
  opts: CampaignOptions,
  result: CycleResult,
  log: (l: string) => void,
): Promise<void> {
  const hypothesisId = result.hypothesisId!;
  const cfg = opts.cycleDefaults;
  log(`  reproducing ${hypothesisId} via ${cfg.harness.domain.replication.kind}…`);

  // Replication runs are recorded but do not consume a research lane: they are
  // the cost of believing a result, not a new direction.
  const survived = await runReplications(store, opts, result, log);

  store.transact((s) => {
    const status = survived ? "replicated" : "inconclusive";
    s.db.prepare("UPDATE hypotheses SET status = ?, updated_at = ? WHERE hypothesis_id = ?")
      .run(status, nowIso(), hypothesisId);
    s.appendEvent({
      campaignId: opts.cycleDefaults.campaignId,
      aggregateKind: "hypothesis", aggregateId: hypothesisId, aggregateRevision: 2,
      eventType: survived ? "claim.replicated" : "claim.replication_failed",
      actorKind: "supervisor",
      idempotencyKey: `claim.replication:${hypothesisId}`,
      payload: {
        reproduction: cfg.harness.domain.replication.kind,
        variants: cfg.harness.reproductionVariants().map((v) => v.label),
        minAgreement: cfg.harness.minAgreement,
        survived,
      },
    });
  });

  if (survived) {
    log("  REPLICATED");
    advanceBaseline(store, opts, result, log);
  } else {
    log("  replication failed — downgraded to inconclusive (a single-seed win is not a finding)");
  }
}

/**
 * Advance the campaign baseline onto a replicated result.
 *
 * This is the operation that lets a campaign compound. The design removed
 * winner-descend without replacing it, which left no way for a portfolio to
 * build on its own wins. The replacement is deliberately expensive: only a
 * replicated claim, whose diff still applies to the current base, may move it.
 *
 * Open contracts registered against the old base are closed as `superseded`,
 * because a threshold measured against a different baseline is not comparable.
 */
function advanceBaseline(
  store: Store,
  opts: CampaignOptions,
  result: CycleResult,
  log: (l: string) => void,
): void {
  const cfg = opts.cycleDefaults;
  const diffText = loadSealedDiff(store, result.hypothesisId!, cfg.projectRoot);
  if (diffText === null) {
    log("  baseline NOT advanced: candidate diff unavailable");
    return;
  }

  const from = baseRevisionOf(store, cfg.campaignId);
  const contract = store.db.prepare(
    `SELECT baseline_hash FROM contracts WHERE hypothesis_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(result.hypothesisId) as { baseline_hash: string } | undefined;
  // A compound program's final diff is relative to its last validated
  // checkpoint. Committing it on the campaign baseline would silently omit all
  // earlier milestones; materialise from the contract's exact implementation
  // base, then advance the public baseline to the resulting cumulative commit.
  const materialisationBase = contract?.baseline_hash ?? from;
  const commit = cfg.harness.advance(materialisationBase, diffText, `advance: ${result.hypothesisId}`);
  if (!commit.ok) {
    log(`  baseline NOT advanced: ${commit.failure}`);
    return;
  }

  store.transact((s) => {
    s.db.prepare("UPDATE campaigns SET base_revision = ?, revision = revision + 1 WHERE campaign_id = ?")
      .run(commit.revision, cfg.campaignId);
    s.db.prepare(
      `UPDATE contracts SET status = 'superseded'
       WHERE status = 'registered' AND hypothesis_id <> ?`,
    ).run(result.hypothesisId);
    if (result.primaryValue !== null && Number.isFinite(result.primaryValue)) {
      const cfgRow = s.db.prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
        .get(cfg.campaignId) as { config_json: string };
      const parsed = normaliseCampaignConfig(cfgRow.config_json);
      parsed.baselinePrimary = result.primaryValue;
      if (result.holdoutValue !== null) parsed.baselineSecondary = result.holdoutValue;
      s.db.prepare("UPDATE campaigns SET config_json = ? WHERE campaign_id = ?")
        .run(JSON.stringify(parsed), cfg.campaignId);
    }
    s.appendEvent({
      campaignId: cfg.campaignId, aggregateKind: "campaign", aggregateId: cfg.campaignId,
      aggregateRevision: 2, eventType: "baseline.advanced", actorKind: "supervisor",
      idempotencyKey: `baseline.advanced:${result.hypothesisId}`,
      payload: { from, materialisationBase, to: commit.revision, hypothesisId: result.hypothesisId,
                 newBaselineBpc: result.primaryValue },
    });
  });

  if (result.primaryValue !== null) cfg.baselinePrimary = result.primaryValue;
  if (result.holdoutValue !== null) cfg.baselineSecondary = result.holdoutValue;
  log(`  BASELINE ADVANCED ${from.slice(0, 8)} -> ${commit.revision.slice(0, 8)} (new baseline ${result.primaryValue?.toFixed(6)})`);
}

/**
 * Re-run the sealed candidate under fresh seeds and re-measure each with the
 * protected evaluator.
 *
 * The candidate is rebuilt from the pinned base revision plus its sealed diff,
 * not from the original worktree, so what gets replicated is exactly what was
 * judged. A seed that fails to reproduce the effect is decisive: the claim was
 * a seed artifact.
 */
async function runReplications(
  store: Store,
  opts: CampaignOptions,
  result: CycleResult,
  log: (l: string) => void,
): Promise<boolean> {
  const cfg = opts.cycleDefaults;
  const h: Harness = cfg.harness;
  const diffText = loadSealedDiff(store, result.hypothesisId!, cfg.projectRoot);
  if (diffText === null) {
    log("  reproduction skipped: the candidate diff was not sealed, so it cannot be rebuilt");
    return false;
  }

  const supportDelta = registeredSupportDelta(store, result.hypothesisId!);
  const variants = h.reproductionVariants();
  const observed: number[] = [];
  let agreed = 0;
  // Leakage votes are collected here rather than acted on per run. See the
  // pooled judgement below.
  const leakageVotes: Array<{ label: string; failed: boolean; detail: string }> = [];

  for (const variant of variants) {
    const id = `rep-${result.cycleId.slice(0, 8)}-${variant.label}`;
    const staging = join(cfg.projectRoot, ".autoresearch", "attempts", result.cycleId,
                         `replica-${variant.label.replace(/[^\w-]/g, "_")}`);
    mkdirSync(staging, { recursive: true });

    const rec = openRun(store, cfg.campaignId, "replay", {
      hypothesisId: result.hypothesisId, contractId: result.contractId,
      idempotencyKey: `replay:${result.cycleId}:${variant.label}`,
      inputHash: sha256(diffText),
    });

    const pinnedBaseRevision = baseRevisionOf(store, cfg.campaignId);
    const candidateBaseRevision = registeredBaseRevision(store, result.hypothesisId!) ?? pinnedBaseRevision;
    let variantBaseline = cfg.baselinePrimary;
    let variantBaselineFailure: string | null = null;

    // Temporal windows are different measurement regimes, not interchangeable
    // scalar values. Compare candidate and baseline on the SAME held-back
    // window; using the default window's baseline for every fold can promote a
    // candidate merely because one historical period has a higher raw Sharpe.
    if (h.domain.replication.kind === "temporal_fold") {
      const baselineId = `${id}-baseline`;
      const baselineStaging = join(staging, "paired-baseline");
      mkdirSync(baselineStaging, { recursive: true });
      const builtBaseline = h.reproduce(
        baselineId, pinnedBaseRevision, "", variant.configPatch,
      );
      if (!builtBaseline.worktree || builtBaseline.failure) {
        variantBaselineFailure = builtBaseline.failure ?? "paired baseline worktree unavailable";
      } else {
        try {
          const baselineExp = observeBlockingOperation(
            join(baselineStaging, "compute", "heartbeat.json"),
            { campaignId: cfg.campaignId, cycleId: result.cycleId, attemptId: rec.attemptId, processStartId: processStartId(process.pid) },
            `paired baseline experiment ${variant.label}`,
            () => h.run(builtBaseline.worktree!, baselineStaging, cfg.experimentTimeoutMs),
          );
          if (!baselineExp.ok || !baselineExp.outputPath) {
            variantBaselineFailure = baselineExp.failureCode ?? "paired baseline experiment failed";
          } else {
            const baselineEval = observeBlockingOperation(
              join(baselineStaging, "evaluation", "heartbeat.json"),
              { campaignId: cfg.campaignId, cycleId: result.cycleId, attemptId: rec.attemptId, processStartId: processStartId(process.pid) },
              `paired baseline evaluator ${variant.label}`,
              () => h.evaluate({
              worktree: builtBaseline.worktree!,
              outputPath: baselineExp.outputPath!,
              stagingDir: baselineStaging,
              baselinePrimary: 0,
              baselineSecondary: null,
              supportDelta: 0,
              timeoutMs: cfg.evaluatorTimeoutMs,
              }),
            );
            if (baselineEval.ok && baselineEval.primary !== null && Number.isFinite(baselineEval.primary)) {
              variantBaseline = baselineEval.primary;
              log(`    ${variant.label}: paired baseline ${variantBaseline.toFixed(6)}`);
            } else {
              variantBaselineFailure = baselineEval.failureCode ?? "paired baseline evaluation failed";
            }
          }
        } finally {
          h.discard(builtBaseline.worktree);
        }
      }
    }

    const { worktree, failure } = h.reproduce(
      id, candidateBaseRevision, diffText, variant.configPatch,
    );

    let ok = false;
    let value: number | null = null;
    if (worktree && !failure) {
      const exp = observeBlockingOperation(
        join(staging, "compute", "heartbeat.json"),
        { campaignId: cfg.campaignId, cycleId: result.cycleId, attemptId: rec.attemptId, processStartId: processStartId(process.pid) },
        `replication experiment ${variant.label}`,
        () => h.run(worktree, staging, cfg.experimentTimeoutMs),
      );
      if (exp.ok && exp.outputPath) {
        const ev = observeBlockingOperation(
          join(staging, "evaluation", "heartbeat.json"),
          { campaignId: cfg.campaignId, cycleId: result.cycleId, attemptId: rec.attemptId, processStartId: processStartId(process.pid) },
          `replication evaluator ${variant.label}`,
          () => h.evaluate({
          worktree, outputPath: exp.outputPath!, stagingDir: staging,
          baselinePrimary: variantBaseline,
          baselineSecondary: cfg.baselineSecondary ?? null,
          supportDelta, timeoutMs: cfg.evaluatorTimeoutMs,
          }),
        );
        value = ev.primary;
        // Leakage is a property of the CANDIDATE, not of a single run, so it is
        // pooled below instead of being able to kill the claim here. Judging it
        // per run applied a noisy test three times and took the worst answer:
        // three chances to fail, any one of which was fatal. That cost a
        // genuine claim whose third seed missed the follow-ratio bar by 0.01
        // (`plans/06-findings.md` §5.1). Integrity and shortcut checks stay
        // per-run - those are not noisy, and one failure is decisive.
        const leaks = ev.checks.filter((c) => c.class === "leakage");
        const failedLeak = leaks.filter((c) => !c.passed);
        leakageVotes.push({
          label: variant.label,
          failed: failedLeak.length > 0,
          detail: failedLeak.map((c) => c.detail).join("; "),
        });
        const clean = ev.ok && ev.checks.every((c) => c.class === "leakage" || c.passed);
        const better = value !== null && improvement(h, variantBaseline, value) >= supportDelta;
        ok = variantBaselineFailure === null && clean && better;
      }
    }

    if (value !== null) observed.push(value);
    if (ok) agreed++;

    closeRun(store, rec, ok, { failureCode: failure ?? null });
    recordEvidence(store, {
      campaignId: cfg.campaignId, hypothesisId: result.hypothesisId!,
      attemptId: rec.attemptId, evaluationId: null, artifactId: null,
      kind: "replication",
      polarity: ok ? "supports" : "weakens",
      statement: ok
        ? `${variant.label} reproduced the effect (${value?.toFixed(6)} against paired baseline ${variantBaseline.toFixed(6)})`
        : `${variant.label} did not reproduce (${variantBaselineFailure ?? failure ?? `value ${value?.toFixed(6) ?? "n/a"} against baseline ${variantBaseline.toFixed(6)}`})`,
      strengthRule: "replication.v2",
    });

    log(`    ${variant.label}: ${ok ? "reproduced" : "did NOT reproduce"}` +
        `${value !== null ? ` (${value.toFixed(6)})` : ""}`);
    if (worktree) h.discard(worktree);
  }

  // Reproduction that cannot detect its own failure is theatre. Distinct
  // variants MUST produce distinct numbers; identical results prove the
  // variation never reached the experiment. Observed live: a candidate that
  // pinned its own seed returned three identical "independent" confirmations.
  //
  // But only where the metric is supposed to move. On a memory-bound GPU kernel
  // the seed changes the input data and throughput does not care, so identical
  // numbers are the expected physics. Applying this rule there accused a real
  // 19 GB/s improvement of reproduction theatre - the fourth time in this
  // project that a rule calibrated in one domain was applied to another and
  // produced a false accusation.
  // Only say this when the values ACTUALLY are identical. Printing it whenever
  // the domain declares the metric variant-insensitive put the words "identical
  // values across variants are expected" directly above three numbers that
  // differed by 55 GB/s - a log line contradicting the data beside it, which is
  // the same misreporting class as a correctness check citing a passing figure
  // as its reason for failing.
  if (observed.length > 1 && !h.domain.replication.variantSensitiveMetric
      && Math.max(...observed) - Math.min(...observed) < 1e-12) {
    log(`    (identical values across variants are expected for ${h.domain.metric.name}: ` +
        "this domain declares the metric insensitive to the reproduction variant, " +
        "so seed-pinning is caught by the reproduction-policy gate instead)");
  }
  if (observed.length > 1 && h.domain.replication.variantSensitiveMetric) {
    const spread = Math.max(...observed) - Math.min(...observed);
    if (spread < 1e-12) {
      log(`    REPRODUCTION VOID: all ${observed.length} variants returned ${observed[0]!.toFixed(6)} - ` +
          "the candidate does not honour the reproduction policy");
      recordEvidence(store, {
        campaignId: cfg.campaignId, hypothesisId: result.hypothesisId!,
        attemptId: null, evaluationId: null, artifactId: null,
        kind: "shortcut", polarity: "refutes",
        statement: `reproduction void: ${observed.length} distinct variants all produced ` +
          `${observed[0]!.toFixed(6)}, so the runs are not independent`,
        strengthRule: "variant_sensitivity.v1",
      });
      return false;
    }
  }

  // -- pooled leakage judgement --------------------------------------------
  //
  // A single run's leakage signal cannot separate honest work from a cheat:
  // measured single-run follow ratios span 0.49-0.77 while a planted label leak
  // scores 0.43, so the distributions overlap. Pooled across runs they separate
  // cleanly. The candidate fails only if leakage is flagged in MORE THAN HALF
  // its reproductions - a majority of the evidence, not the unluckiest sample.
  if (leakageVotes.length > 0) {
    const failedVotes = leakageVotes.filter((v) => v.failed);
    const majority = failedVotes.length * 2 > leakageVotes.length;
    if (majority) {
      log(`    LEAKAGE (pooled): flagged in ${failedVotes.length}/${leakageVotes.length} ` +
          `reproductions - ${failedVotes[0]!.detail}`);
      recordEvidence(store, {
        campaignId: cfg.campaignId, hypothesisId: result.hypothesisId!,
        attemptId: null, evaluationId: null, artifactId: null,
        kind: "leakage", polarity: "refutes",
        statement: `leakage flagged in ${failedVotes.length} of ${leakageVotes.length} ` +
          `reproductions (pooled, majority rule): ${failedVotes[0]!.detail}`,
        strengthRule: "leakage.pooled.v1",
      });
      return false;
    }
    if (failedVotes.length > 0) {
      log(`    leakage flagged in ${failedVotes.length}/${leakageVotes.length} reproductions - ` +
          "below the majority needed to refute, so it is recorded but not decisive");
      recordEvidence(store, {
        campaignId: cfg.campaignId, hypothesisId: result.hypothesisId!,
        attemptId: null, evaluationId: null, artifactId: null,
        kind: "leakage", polarity: "weakens",
        statement: `leakage flagged in a minority of reproductions ` +
          `(${failedVotes.length}/${leakageVotes.length}): ${failedVotes[0]!.detail}`,
        strengthRule: "leakage.pooled.v1",
      });
    }
  }

  const belief = deriveBelief(store, result.hypothesisId!);
  store.db.prepare("UPDATE hypotheses SET belief_derived = ? WHERE hypothesis_id = ?")
    .run(belief, result.hypothesisId);

  // Not unanimity. A noisy metric makes all-must-agree the most likely way to
  // reject real work - a validated claim was lost when one variant of three
  // missed its threshold by 0.01 (plans/06-findings.md §5.1).
  const survived = agreed >= h.minAgreement;
  log(`    ${agreed}/${variants.length} reproduced; policy requires ${h.minAgreement}`);
  return survived;
}

/** Positive means better, whichever way the domain's metric points. */
function improvement(h: Harness, baseline: number, value: number): number {
  return h.domain.metric.direction === "minimize" ? baseline - value : value - baseline;
}

/** Recover the sealed candidate diff from the content-addressed artifact store. */
function loadSealedDiff(store: Store, hypothesisId: string, projectRoot: string): string | null {
  const row = store.db
    .prepare(
      `SELECT a.relative_path FROM artifacts a
       JOIN attempts at ON at.attempt_id = a.attempt_id
       JOIN runs r ON r.run_id = at.run_id
       WHERE r.hypothesis_id = ? AND a.kind = 'candidate-diff'
       ORDER BY a.sealed_at DESC LIMIT 1`,
    )
    .get(hypothesisId) as { relative_path: string } | undefined;
  if (!row) return null;
  const full = join(projectRoot, ".autoresearch", "artifacts", row.relative_path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function registeredSupportDelta(store: Store, hypothesisId: string): number {
  const row = store.db
    .prepare("SELECT threshold_json FROM contracts WHERE hypothesis_id = ? ORDER BY revision DESC LIMIT 1")
    .get(hypothesisId) as { threshold_json: string } | undefined;
  if (!row) return Number.POSITIVE_INFINITY;
  return JSON.parse(row.threshold_json).support_delta ?? Number.POSITIVE_INFINITY;
}

function registeredBaseRevision(store: Store, hypothesisId: string): string | null {
  const row = store.db.prepare(
    "SELECT baseline_hash FROM contracts WHERE hypothesis_id = ? ORDER BY revision DESC LIMIT 1",
  ).get(hypothesisId) as { baseline_hash: string } | undefined;
  return row?.baseline_hash ?? null;
}

function baseRevisionOf(store: Store, campaignId: string): string {
  const row = store.db
    .prepare("SELECT base_revision FROM campaigns WHERE campaign_id = ?")
    .get(campaignId) as { base_revision: string };
  return row.base_revision;
}

function logResult(log: (l: string) => void, r: CycleResult, metricName = "primary"): void {
  log(`  status   : ${r.status}${r.citable ? "" : `  [NOT CITABLE: ${r.missingCitations.join(",")}]`}`);
  if (r.verdict) log(`  why      : ${r.verdict.explanation}`);
  if (r.abortReason) log(`  abort    : ${r.abortReason}`);
  if (r.primaryValue !== null) {
    // The metric's own name. Logging every domain's number as "val_bpc" made a
    // GB/s reading look like a bits-per-char reading in the one artifact an
    // operator actually reads.
    log(`  ${metricName.padEnd(9)}: ${r.primaryValue.toFixed(6)}   holdout: ${r.holdoutValue?.toFixed(6) ?? "n/a"}`);
  }
  if (r.classMismatch) {
    log(`  MISMATCH : declared ${r.declaredChangeClass}, actual ${r.actualChangeClass} — charged to actual`);
  }
  log(`  cost     : $${r.costUsd.toFixed(4)}   duration: ${formatDuration(r.durationMs)}`);
}
