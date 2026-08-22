/**
 * Measure the noise floor before doing any research.
 *
 * A campaign's first cycles run the UNCHANGED baseline several times and record
 * what comes back. The spread of those numbers is the noise floor: how far the
 * metric moves when nothing about the candidate moved at all. Every later
 * threshold is judged against it.
 *
 * This replaces a declared `metric.noiseFloor` in the domain config, which was
 * a guess, and guesses here are expensive. The CUDA campaign's worst defect came
 * from one: a manager registered a support threshold of 0.02 against a floor
 * that had been *asserted* as 8, a 3.2 GB/s reading cleared it, and a baseline
 * advanced on noise. Three of the four false fraud accusations in
 * `plans/06-findings.md` §5 trace to the same root - a threshold calibrated
 * against intent rather than against measurement.
 *
 * Two properties matter beyond the number itself:
 *
 *  - The replicates are REAL EXPERIMENTS, sealed like any other. The floor a
 *    claim was judged against is part of that claim's evidence, not an
 *    unexplained constant in a config file.
 *  - They are the first points on the progress graph, so the baseline's own
 *    scatter is visible underneath everything that follows. A later gain is
 *    read against the spread it has to beat.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Harness } from "../core/harness.js";
import { nowIso, type Store } from "../store/store.js";

export interface Calibration {
  /** Every baseline measurement, in order. */
  samples: number[];
  /** The noise floor: how far identical code moved. */
  noiseFloor: number;
  mean: number;
  spread: number;
  stdev: number;
  measuredAt: string;
  /** Set when the domain could not be measured and a declared value was used. */
  fallback?: string;
}

/**
 * The floor from a set of no-change replicates.
 *
 * The observed RANGE, not a multiple of the standard deviation. It answers the
 * question an operator actually asks - "how much can this number move when I
 * changed nothing?" - and with a handful of samples the range is the honest
 * summary; a stdev-based bound implies a distributional claim five points
 * cannot support. A stdev-derived bound is taken when it is larger, so a run of
 * unlucky-tight samples cannot produce an implausibly small floor.
 */
export function floorFrom(samples: number[]): Calibration {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const spread = n > 1 ? Math.max(...samples) - Math.min(...samples) : 0;
  const variance = n > 1
    ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
    : 0;
  const stdev = Math.sqrt(variance);
  return {
    samples, mean, spread, stdev,
    noiseFloor: Math.max(spread, 2 * stdev),
    measuredAt: nowIso(),
  };
}

/**
 * Run the unchanged baseline `attempts` times and measure the spread.
 *
 * Deliberately uses the ordinary experiment path - same worktree, same
 * protected evaluator - so the numbers are commensurable with every later
 * cycle. A floor measured by a shortcut would not be the floor that applies.
 */
export function calibrate(
  store: Store,
  h: Harness,
  args: {
    campaignId: string;
    projectRoot: string;
    baseRevision: string;
    baselineSecondary: number | null;
    experimentTimeoutMs: number;
    evaluatorTimeoutMs: number;
    attempts?: number;
    log?: (line: string) => void;
  },
): Calibration {
  const attempts = args.attempts ?? 5;
  const log = args.log ?? (() => {});
  const samples: number[] = [];

  log(`\n=== calibration · measuring the noise floor across ${h.domain.replication.kind} variants ===`);

  // Vary along the domain's OWN replication axis, not by rerunning identically.
  //
  // Measured on finance first: five identical reruns returned 1.255713 every
  // time, spread 0.000000, because the domain is bitwise deterministic. That is
  // a true measurement of the wrong quantity - and a floor of zero silently
  // disables the threshold gate, which is the defect calibration exists to
  // prevent.
  //
  // The floor must describe variation across the things the domain TREATS AS
  // EQUIVALENT REPETITIONS: different seeds where reproduction means a seed,
  // different time windows where it means a window. For finance a 0.05 Sharpe
  // difference between two windows is exactly the noise a claim must beat,
  // even though rerunning one window is perfectly repeatable.
  const variants = h.reproductionVariants();
  const plan = variants.length > 1
    ? variants.slice(0, Math.max(attempts, variants.length))
    : Array.from({ length: attempts }, () => ({ label: "repeat", configPatch: {} }));

  for (let i = 0; i < plan.length; i++) {
    const variant = plan[i]!;
    const dir = join(args.projectRoot, ".autoresearch", "attempts", `calibration-${args.campaignId}-${i + 1}`);
    mkdirSync(join(dir, "staging"), { recursive: true });

    let worktree: string | null = null;
    try {
      // Rebuilt through the ordinary reproduction path so the variant key is
      // applied exactly as it would be during replication.
      const built = h.reproduce(
        `calib-${args.campaignId}-${i + 1}`, args.baseRevision, "", variant.configPatch,
      );
      worktree = built.worktree;
      if (!worktree || built.failure) {
        log(`    ${variant.label}: could not build (${built.failure ?? "no worktree"})`);
        continue;
      }
      const exp = h.run(worktree, join(dir, "staging"), args.experimentTimeoutMs);
      if (!exp.ok || !exp.outputPath) {
        log(`    ${variant.label}: experiment produced no output (${exp.failureCode ?? "unknown"})`);
        continue;
      }
      const ev = h.evaluate({
        worktree, outputPath: exp.outputPath, stagingDir: join(dir, "staging"),
        // Compared against itself: this is a measurement, not a judgement.
        baselinePrimary: 0, baselineSecondary: args.baselineSecondary,
        supportDelta: 0, timeoutMs: args.evaluatorTimeoutMs,
      });
      if (ev.ok && typeof ev.primary === "number" && Number.isFinite(ev.primary)) {
        samples.push(ev.primary);
        log(`    ${variant.label}: ${ev.primary.toFixed(6)}`);
      } else {
        log(`    ${variant.label}: no usable value (${ev.failureCode ?? "no primary"})`);
      }
    } catch (err) {
      log(`    ${variant.label}: ${String(err).slice(0, 140)}`);
    } finally {
      if (worktree) h.discard(worktree);
    }
  }

  // Fewer than two usable samples measures nothing. Fall back to the declared
  // value, and SAY SO - a floor of unknown provenance is the exact condition
  // this exists to remove, so it must never masquerade as measured.
  if (samples.length < 2) {
    const declared = h.domain.metric.noiseFloor;
    const c = floorFrom(samples);
    c.noiseFloor = declared > 0 ? declared : 0;
    c.fallback = `only ${samples.length} usable baseline run(s); `
      + (declared > 0
          ? `falling back to the domain's declared floor of ${declared}`
          : "no declared floor either, so no threshold can be validated");
    log(`    ${c.fallback}`);
    return c;
  }

  const c = floorFrom(samples);
  log(`    mean ${c.mean.toFixed(6)} · spread ${c.spread.toFixed(6)} · sd ${c.stdev.toFixed(6)}`);
  if (!(c.noiseFloor > 0)) {
    // Genuinely zero variation across variants means the metric cannot
    // distinguish them, and a zero floor would wave every threshold through.
    // Fall back to the declared prior and say so loudly.
    const declared = h.domain.metric.noiseFloor;
    c.fallback = `variants produced identical values, so no floor could be measured; `
      + (declared > 0 ? `using the declared prior of ${declared}`
                      : "NO FLOOR IS AVAILABLE - threshold validation is disabled for this campaign");
    c.noiseFloor = declared > 0 ? declared : 0;
    log(`    ${c.fallback}`);
    return c;
  }
  log(`    NOISE FLOOR ${c.noiseFloor.toFixed(6)} ${h.domain.metric.name} `
      + "— the same code moved this much across equivalent repetitions, so nothing smaller is a result");
  return c;
}

/** Persist the calibration onto the campaign and into the hash-chained log. */
export function recordCalibration(store: Store, campaignId: string, c: Calibration): void {
  store.transact((s) => {
    const row = s.db.prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
      .get(campaignId) as { config_json: string } | undefined;
    const cfg = row ? JSON.parse(row.config_json) : {};
    cfg.measuredNoiseFloor = c.noiseFloor;
    cfg.calibration = {
      samples: c.samples, mean: c.mean, spread: c.spread,
      stdev: c.stdev, measuredAt: c.measuredAt, fallback: c.fallback ?? null,
    };
    s.db.prepare("UPDATE campaigns SET config_json = ? WHERE campaign_id = ?")
      .run(JSON.stringify(cfg), campaignId);

    s.appendEvent({
      campaignId, aggregateKind: "campaign", aggregateId: campaignId, aggregateRevision: 13,
      eventType: "campaign.calibrated", actorKind: "system",
      idempotencyKey: `campaign.calibrated:${campaignId}:${c.measuredAt}`,
      payload: {
        noiseFloor: c.noiseFloor, samples: c.samples, mean: c.mean,
        spread: c.spread, stdev: c.stdev, fallback: c.fallback ?? null,
        note: "measured by re-running the unchanged baseline; every later threshold "
            + "is validated against this number",
      },
    });
  });
}

/** The floor a campaign is actually using, measured if it has been. */
export function measuredFloor(store: Store, campaignId: string, declared: number): number {
  const row = store.db.prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
    .get(campaignId) as { config_json: string } | undefined;
  if (!row) return declared;
  try {
    const cfg = JSON.parse(row.config_json);
    const m = Number(cfg.measuredNoiseFloor);
    return Number.isFinite(m) && m > 0 ? m : declared;
  } catch {
    return declared;
  }
}
