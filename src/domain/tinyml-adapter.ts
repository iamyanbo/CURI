/**
 * tinyml: character-level language model on a fixed text corpus.
 *
 * This is what a domain actually has to supply once the general machinery lives
 * in the core. Compare with the 431-line file this replaces: worktrees, diff
 * capture, protected-tree hashing, seed-escape detection and candidate
 * rebuilding were never domain-specific and have moved to `src/core`.
 *
 * What genuinely belongs to a domain is the four answers below: how to run one
 * experiment, how to measure it out of the candidate's reach, what reproduction
 * means here, and what would count as cheating.
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { sha256File } from "../core/workspace.js";
import { CHEATS } from "../cheats.js";
import type {
  ChangeClass, CheatFixture, DomainAdapter, EvaluationContext, EvaluationResult,
  ExperimentContext, ExperimentOutcome, ReplicationVariant,
} from "./types.js";

/** Config keys the harness owns. A candidate editing one has escaped its contract. */
const RESERVED = new Set(["seed", "eval_tokens"]);

/** Keys that change the model's shape rather than its optimisation schedule. */
const ARCHITECTURE = new Set(["d_model", "n_layer", "n_head", "mlp_ratio", "block_size"]);

export function createTinymlAdapter(projectRoot: string): DomainAdapter {
  const dataDir = join(projectRoot, "domains", "tinyml", "data");
  const protectedRoot = join(projectRoot, ".autoresearch-protected");
  const evaluator = join(protectedRoot, "evaluate.py");

  return {
    id: "tinyml",

    metric: {
      name: "val_bpc",
      direction: "minimize",
      // MEASURED, not chosen: three seeds of one candidate spanned 0.027 bpc.
      // Three of this project's four false fraud accusations came from
      // thresholds picked by reasoning instead of measurement.
      noiseFloor: 0.03,
    },

    // Enforced: OMP_NUM_THREADS=1, deterministic algorithms, fixed seeds. Two
    // independent runs produce byte-identical checkpoints, so clean replay is a
    // hash comparison rather than a statistical test. This is the exception
    // among research domains, not the rule.
    determinism: "bitwise",

    // Read by the executor prompt builder. Without these the prompt cannot
    // describe this domain and falls back to generic wording.
    runCommand: ["python", "train.py"],
    outputPath: "out/model.pt",
    executorRules: [
      "2b. `train.py` MUST keep its `load_for_eval(ckpt_path)` function working - the",
      "    protected evaluator calls it to reload your model. If you change the",
      "    architecture, that function must still rebuild it from the checkpoint.",
    ].join("\n"),

    replication: {
      kind: "seed",
      attempts: 3,
      // Unanimity on a noisy metric is the most likely way to reject real work:
      // a claim was lost when one seed of three missed a threshold by 0.01.
      // See plans/06-findings.md §5.1.
      minAgreement: 2,
      // The seed changes training, so the metric must move.
      variantSensitiveMetric: true,
      variants(n: number): ReplicationVariant[] {
        const seeds = [7, 1234, 99991, 31337, 20260821];
        return seeds.slice(0, n).map((s) => ({ label: `seed=${s}`, configPatch: { seed: s } }));
      },
    },

    cost: { typicalSeconds: 240 },

    candidateFiles: ["train.py", "config.json"],

    protectedPaths: () => [protectedRoot],

    initialise(root: string, repoDir: string): void {
      const src = join(root, "domains", "tinyml", "candidate");
      for (const f of ["train.py", "config.json"]) cpSync(join(src, f), join(repoDir, f));
    },

    runExperiment(ctx: ExperimentContext): ExperimentOutcome {
      const started = Date.now();
      const res = spawnSync("python", [join(ctx.worktree, "train.py")], {
        cwd: ctx.worktree,
        encoding: "utf8",
        timeout: ctx.timeoutMs > 0 ? ctx.timeoutMs : undefined,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, TINYML_DATA: dataDir, OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1" },
      });
      const stdout = res.stdout ?? "";
      const ckpt = join(ctx.worktree, "out", "model.pt");
      const m = stdout.match(/val_bpc=([0-9.]+)/);
      const selfReported = m?.[1] ? Number(m[1]) : null;

      if (res.status !== 0 || !existsSync(ckpt)) {
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
        outputPath: ckpt, outputHash: sha256File(ckpt),
      };
    },

    /**
     * Measurement runs outside the candidate's reach: a separate process, its
     * own loss implementation, and a holdout split the candidate has never seen.
     * The candidate's printed number is passed in only so the evaluator can
     * report the discrepancy — never to be believed.
     */
    evaluate(ctx: EvaluationContext): EvaluationResult {
      const started = Date.now();
      const out = join(ctx.stagingDir, "evaluation.json");
      const args = [
        evaluator,
        "--candidate", ctx.worktree,
        "--checkpoint", ctx.outputPath,
        "--out", out,
        "--baseline-bpc", String(ctx.baselinePrimary),
        "--support-delta", String(ctx.supportDelta),
      ];
      if (ctx.baselineSecondary !== null) {
        args.push("--baseline-holdout-bpc", String(ctx.baselineSecondary));
      }

      const res = spawnSync("python", args, {
        cwd: protectedRoot, encoding: "utf8", timeout: ctx.timeoutMs > 0 ? ctx.timeoutMs : undefined,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, TINYML_DATA: dataDir, OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1" },
      });

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
        primary: raw.metrics?.val_bpc ?? null,
        secondary: raw.metrics?.holdout_bpc ?? null,
        checks: (raw.checks ?? []).map((c: any) => ({
          id: c.id, class: c.class ?? "integrity", passed: Boolean(c.passed), detail: c.detail ?? "",
        })),
        raw,
        durationMs: Date.now() - started,
      };
    },

    reservedConfigKeys: () => RESERVED,

    /**
     * Derived from the CURRENT baseline, never a build-time list. After a claim
     * introduced `alibi_slopes_learnable`, a hardcoded surface rejected a
     * legitimate ablation that toggled it.
     */
    parameterSurface(baselineConfig: Record<string, unknown>): Set<string> {
      const keys = new Set<string>();
      for (const k of Object.keys(baselineConfig)) {
        if (k.startsWith("_") || RESERVED.has(k) || ARCHITECTURE.has(k)) continue;
        keys.add(k);
      }
      return keys;
    },

    cheatFixtures(): CheatFixture[] {
      return CHEATS.map((c) => ({
        id: c.id, title: c.title, description: c.description, targets: c.targets,
        acceptableVerdicts: c.acceptableVerdicts,
        apply(files: Record<string, string>): Record<string, string> | null {
          const src = files["train.py"];
          if (src === undefined) return null;
          const out = c.apply(src);
          return out === null ? null : { ...files, "train.py": out };
        },
      }));
    },

    classifyChange(_diffText: string, changedPaths: string[], configKeysChanged: string[]): ChangeClass {
      const configOnly = changedPaths.length > 0 && changedPaths.every((f) => f === "config.json");
      if (configOnly && configKeysChanged.some((k) => ARCHITECTURE.has(k))) return "architecture";
      if (configOnly) return "parameter";
      if (changedPaths.includes("train.py")) return "mechanism";
      return "replication";
    },
  };
}
