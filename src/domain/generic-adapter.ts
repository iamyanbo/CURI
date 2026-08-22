/**
 * The generic adapter: a research domain described by a config file.
 *
 * Most domains do not need TypeScript. They need to answer four questions, and
 * those answers are a command, a command, a directory, and a list. This adapter
 * takes a `domain.json` and produces a working `DomainAdapter`, so adding
 * finance, bio, or a vision model is a config file plus an evaluator script.
 *
 * The evaluator script is the one piece that cannot be generic, and that is not
 * an accident of implementation. It is where the field's own judgement lives:
 * what counts as a valid measurement, what data is held back, and what would
 * count as cheating here. The counterfactual in `plans/06-findings.md` §3 shows
 * why it carries the weight - a planted cheat that produced a genuine 14%
 * improvement was caught ONLY by a held-back measurement it could not reach.
 * Without that, this system degrades to the `no_checks` arm, which admitted it.
 *
 * Contract with the evaluator script: it is invoked as
 *
 *   <evaluatorCommand> --candidate DIR --output PATH --out RESULT.json
 *                      --baseline-primary N [--baseline-secondary N]
 *                      --support-delta N
 *
 * and must write RESULT.json of the form
 *
 *   { "primary": <number>,            // independently recomputed, never trusted from the candidate
 *     "secondary": <number|null>,     // the held-back measurement
 *     "checks": [ { "id", "class": "integrity"|"leakage"|"shortcut", "passed", "detail" } ] }
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { sha256File } from "../core/workspace.js";
import type {
  ChangeClass, CheatFixture, DeterminismClass, DomainAdapter, EvaluationContext,
  EvaluationResult, ExperimentContext, ExperimentOutcome, ReplicationKind, ReplicationVariant,
} from "./types.js";

export interface DomainConfig {
  id: string;

  metric: { name: string; direction: "minimize" | "maximize"; noiseFloor: number };

  /**
   * How faithfully a rerun reproduces. Declare it honestly: claiming `bitwise`
   * for a GPU workload makes clean replay fail constantly, and claiming it for a
   * wet-lab protocol is simply false.
   */
  determinism: DeterminismClass;

  replication: {
    kind: ReplicationKind;
    attempts: number;
    minAgreement: number;
    /**
     * The config key that carries the variation, and the values to use.
     * For `seed` that is a seed number; for `temporal_fold` a date or window
     * label; for `resample` a fold index. The harness owns this key - a
     * candidate that sets it has escaped the reproduction policy.
     */
    variantKey: string;
    variantValues: Array<string | number>;
    /**
     * Whether the primary metric should move when the variant moves. Defaults
     * to true, which is the safe direction: a domain that forgets to declare it
     * keeps the strict check. See `ReplicationPolicy.variantSensitiveMetric`.
     */
    variantSensitiveMetric?: boolean;
  };

  cost: { typicalSeconds: number; typicalUsd?: number; consumesScarceResource?: boolean };

  /** Files the executor may edit, relative to the candidate root. */
  candidateFiles: string[];
  /** The JSON config the executor may tune, if any. */
  configFile?: string;
  /** Directories the executor may never read or write, relative to project root. */
  protectedPaths: string[];
  /** Files copied in to seed a fresh candidate repository. */
  seedFiles: Array<{ from: string; to: string }>;

  /** argv for one experiment, run inside the candidate worktree. */
  runCommand: string[];
  /** argv prefix for the evaluator; the harness appends the documented flags. */
  evaluatorCommand: string[];
  /** Environment given to both, merged over the harness environment. */
  env?: Record<string, string>;

  /** False where the holdout is time; see `DomainAdapter.agentSearch`. */
  agentSearch?: boolean;
  /** ISO date fence for literature; see `DomainAdapter.leadsAsOf`. */
  leadsAsOf?: string;

  /** Field-specific rules spliced into the executor prompt. */
  executorRules?: string;

  /** Regex applied to the run's stdout to recover the candidate's self-report. */
  selfReportPattern?: string;
  /** Path, relative to the worktree, of whatever the evaluator consumes. */
  outputPath: string;

  /** Config keys the harness owns. `variantKey` is added automatically. */
  reservedConfigKeys: string[];
  /** Config keys that count as structural rather than tuning. */
  architectureKeys?: string[];

  /**
   * Planted cheats for this field, as text patches.
   *
   * A domain without these cannot be trusted: every defence in this project was
   * tuned by fixing false positives, and the first time fixtures ran, two of
   * four detectors turned out to have been silently dead for a whole campaign.
   */
  cheats?: Array<{
    id: string;
    title: string;
    targets: string;
    /**
     * Which domain-independent way of faking a result this plants. The doctor
     * requires one fixture per kind, which is what stops a generated domain
     * pairing a weak evaluator with weak tests.
     */
    kind?: "do_nothing" | "peek" | "partial_work" | "other";
    acceptableVerdicts: string[];
    /** The check that must be the one to stop it. See `CheatFixture`. */
    expectedChecks?: string[];
    file: string;
    /** Insert after the first line containing this text. */
    insertAfter: string;
    insert: string;
  }>;
}

export function loadDomainConfig(path: string): DomainConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as DomainConfig;
  const required: Array<keyof DomainConfig> = [
    "id", "metric", "determinism", "replication", "candidateFiles",
    "protectedPaths", "runCommand", "evaluatorCommand", "outputPath",
  ];
  for (const k of required) {
    if (cfg[k] === undefined) throw new Error(`domain config is missing "${String(k)}"`);
  }
  if (cfg.replication.minAgreement > cfg.replication.attempts) {
    throw new Error("minAgreement cannot exceed attempts");
  }
  if (cfg.replication.variantValues.length < cfg.replication.attempts) {
    throw new Error("not enough variantValues for the requested attempts");
  }
  if (!cfg.cheats || cfg.cheats.length === 0) {
    throw new Error(
      `domain "${cfg.id}" declares no cheat fixtures. A defence that has never been shown to ` +
      "fire is indistinguishable from a defence with nothing to catch - two of this project's " +
      "detectors were silently dead for an entire campaign before fixtures exposed them.",
    );
  }
  // Optional now. The campaign MEASURES the floor by re-running its own
  // baseline before doing any research, so a declared value is only a prior -
  // used if measurement proves impossible, and overridden by data when it is.
  if (cfg.metric.noiseFloor === undefined) cfg.metric.noiseFloor = 0;
  if (cfg.metric.noiseFloor < 0) {
    // A zero noise floor means every gate can be tighter than the measurement
    // error, which is how this project produced three false fraud accusations.
    throw new Error("metric.noiseFloor cannot be negative");
  }
  return cfg;
}

export function createGenericAdapter(projectRoot: string, cfg: DomainConfig): DomainAdapter {
  const reserved = new Set([...cfg.reservedConfigKeys, cfg.replication.variantKey]);
  const architecture = new Set(cfg.architectureKeys ?? []);
  const protectedAbs = cfg.protectedPaths.map((p) => resolve(projectRoot, p));
  const baseEnv = { ...process.env, ...(cfg.env ?? {}) };

  return {
    id: cfg.id,
    metric: cfg.metric,
    determinism: cfg.determinism,
    runCommand: cfg.runCommand,
    outputPath: cfg.outputPath,
    executorRules: cfg.executorRules,
    agentSearch: cfg.agentSearch ?? true,
    leadsAsOf: cfg.leadsAsOf,
    cost: cfg.cost,
    candidateFiles: cfg.candidateFiles,
    protectedPaths: () => protectedAbs,

    replication: {
      kind: cfg.replication.kind,
      attempts: cfg.replication.attempts,
      minAgreement: cfg.replication.minAgreement,
      variantSensitiveMetric: cfg.replication.variantSensitiveMetric ?? true,
      variants(n: number): ReplicationVariant[] {
        return cfg.replication.variantValues.slice(0, n).map((v) => ({
          label: `${cfg.replication.variantKey}=${v}`,
          configPatch: { [cfg.replication.variantKey]: v },
        }));
      },
    },

    initialise(root: string, repoDir: string): void {
      for (const f of cfg.seedFiles ?? []) {
        const src = resolve(root, f.from);
        if (!existsSync(src)) throw new Error(`seed file not found: ${src}`);
        const dest = join(repoDir, f.to);
        spawnSync("node", ["-e", `require('fs').copyFileSync(${JSON.stringify(src)}, ${JSON.stringify(dest)})`]);
      }
    },

    runExperiment(ctx: ExperimentContext): ExperimentOutcome {
      const started = Date.now();
      const [cmd, ...args] = cfg.runCommand;
      const res = spawnSync(cmd!, args, {
        cwd: ctx.worktree, encoding: "utf8", timeout: ctx.timeoutMs,
        maxBuffer: 16 * 1024 * 1024, env: baseEnv, windowsHide: true });
      const stdout = res.stdout ?? "";
      const output = join(ctx.worktree, cfg.outputPath);

      let selfReported: number | null = null;
      if (cfg.selfReportPattern) {
        const m = stdout.match(new RegExp(cfg.selfReportPattern));
        if (m?.[1]) selfReported = Number(m[1]);
      }

      if (res.status !== 0 || !existsSync(output)) {
        return {
          ok: false,
          failureCode: res.signal ? "PROCESS_TIMEOUT" : `PROCESS_EXIT_${res.status}`,
          stdout, stderr: (res.stderr ?? "").slice(-8000),
          durationMs: Date.now() - started,
          selfReportedPrimary: selfReported, outputPath: null, outputHash: null,
        };
      }
      return {
        ok: true, stdout, stderr: (res.stderr ?? "").slice(-8000),
        durationMs: Date.now() - started,
        selfReportedPrimary: selfReported,
        outputPath: output, outputHash: sha256File(output),
      };
    },

    evaluate(ctx: EvaluationContext): EvaluationResult {
      const started = Date.now();
      const out = join(ctx.stagingDir, "evaluation.json");
      const [cmd, ...prefix] = cfg.evaluatorCommand;

      // `String(undefined)` is "undefined", and a command line accepts it
      // happily. A missing threshold therefore reached the evaluator as a
      // plausible-looking argument and failed 15 minutes later as an integrity
      // error, which reads like the candidate's fault rather than the
      // harness's. Numbers crossing a process boundary are checked here, once,
      // so no caller can leak a non-number into an argv again.
      const numeric = (flag: string, value: number): string => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(
            `refusing to invoke the evaluator: ${flag} is ${String(value)}, not a finite number. ` +
            "This is a harness defect, not a candidate failure - the caller must resolve the " +
            "value before evaluation, because the evaluator cannot distinguish a missing " +
            "threshold from a real one.",
          );
        }
        return String(value);
      };

      const args = [
        ...prefix,
        "--candidate", ctx.worktree,
        "--output", ctx.outputPath,
        "--out", out,
        "--baseline-primary", numeric("--baseline-primary", ctx.baselinePrimary),
        "--support-delta", numeric("--support-delta", ctx.supportDelta),
      ];
      if (ctx.baselineSecondary !== null) {
        args.push("--baseline-secondary", numeric("--baseline-secondary", ctx.baselineSecondary));
      }

      const res = spawnSync(cmd!, args, {
        cwd: projectRoot, encoding: "utf8", timeout: ctx.timeoutMs,
        maxBuffer: 16 * 1024 * 1024, env: baseEnv, windowsHide: true });

      if (res.status !== 0 || !existsSync(out)) {
        return {
          ok: false, failureCode: `EVALUATOR_EXIT_${res.status}`,
          primary: null, secondary: null,
          checks: [{ id: "evaluator_completed", class: "integrity", passed: false,
                     detail: (res.stderr ?? "").slice(-500) || "evaluator did not complete" }],
          raw: { stderr: (res.stderr ?? "").slice(-8000) },
          durationMs: Date.now() - started,
        };
      }

      const raw = JSON.parse(readFileSync(out, "utf8"));
      return {
        ok: true,
        primary: typeof raw.primary === "number" ? raw.primary : null,
        secondary: typeof raw.secondary === "number" ? raw.secondary : null,
        measurementResolution: typeof raw.measurement_resolution === "number"
          && Number.isFinite(raw.measurement_resolution) && raw.measurement_resolution >= 0
          ? raw.measurement_resolution : 0,
        checks: (raw.checks ?? []).map((c: any) => ({
          id: String(c.id), class: c.class ?? "integrity",
          passed: Boolean(c.passed), detail: String(c.detail ?? ""),
        })),
        raw,
        durationMs: Date.now() - started,
      };
    },

    reservedConfigKeys: () => reserved,

    parameterSurface(baselineConfig: Record<string, unknown>): Set<string> {
      const keys = new Set<string>();
      for (const k of Object.keys(baselineConfig)) {
        if (k.startsWith("_") || reserved.has(k) || architecture.has(k)) continue;
        keys.add(k);
      }
      return keys;
    },

    cheatFixtures(): CheatFixture[] {
      return (cfg.cheats ?? []).map((c) => ({
        id: c.id, title: c.title, description: c.targets, targets: c.targets,
        acceptableVerdicts: c.acceptableVerdicts,
        expectedChecks: c.expectedChecks,
        apply(files: Record<string, string>): Record<string, string> | null {
          const src = files[c.file];
          if (src === undefined) return null;
          const lines = src.split("\n");
          const i = lines.findIndex((l) => l.includes(c.insertAfter));
          if (i < 0) return null;
          const indent = (lines[i]!.match(/^\s*/) ?? [""])[0];
          lines.splice(i + 1, 0, ...c.insert.split("\n").map((l) => (l ? indent + l : l)));
          return { ...files, [c.file]: lines.join("\n") };
        },
      }));
    },

    classifyChange(_diff: string, changedPaths: string[], configKeysChanged: string[]): ChangeClass {
      const configOnly = cfg.configFile !== undefined
        && changedPaths.length > 0 && changedPaths.every((f) => f === cfg.configFile);
      if (configOnly && configKeysChanged.some((k) => architecture.has(k))) return "architecture";
      if (configOnly) return "parameter";
      if (changedPaths.length > 0) return "mechanism";
      return "replication";
    },
  };
}
