/** Portable Cloud Run task protocol for protected experiment evaluation. */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createGenericAdapter, loadDomainConfig } from "../domain/generic-adapter.js";
import type { EvaluationResult, ExperimentOutcome } from "../domain/types.js";
import { GcsArtifactStore } from "../artifacts/store.js";

export const CLOUD_TASK_VERSION = 1 as const;

export interface CloudEvaluationTask {
  version: typeof CLOUD_TASK_VERSION;
  taskId: string;
  domainConfigPath: string;
  candidateFiles: Record<string, string>;
  configPatch?: Record<string, unknown>;
  baselinePrimary: number;
  baselineSecondary: number | null;
  supportDelta: number;
  experimentTimeoutMs: number;
  evaluatorTimeoutMs: number;
}

export interface CloudEvaluationResult {
  version: typeof CLOUD_TASK_VERSION;
  taskId: string;
  taskIndex: number;
  experiment: ExperimentOutcome;
  evaluation: EvaluationResult | null;
  failure?: string;
}

function safeRelative(root: string, requested: string): string {
  if (!requested || isAbsolute(requested)) throw new Error(`invalid candidate path: ${requested}`);
  const base = resolve(root);
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`candidate path escapes task workspace: ${requested}`);
  }
  return target;
}

export function validateCloudTask(task: CloudEvaluationTask): void {
  if (task.version !== CLOUD_TASK_VERSION) throw new Error(`unsupported task version: ${task.version}`);
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(task.taskId)) throw new Error("invalid taskId");
  for (const [name, value] of Object.entries(task.candidateFiles)) {
    if (typeof value !== "string") throw new Error(`candidate file ${name} is not text`);
    safeRelative(process.cwd(), name);
  }
  for (const [name, value] of Object.entries({
    baselinePrimary: task.baselinePrimary, supportDelta: task.supportDelta,
    experimentTimeoutMs: task.experimentTimeoutMs, evaluatorTimeoutMs: task.evaluatorTimeoutMs,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  }
}

export function executeCloudTask(task: CloudEvaluationTask, projectRoot = process.cwd(), taskIndex = 0): CloudEvaluationResult {
  validateCloudTask(task);
  const workspace = mkdtempSync(join(tmpdir(), "adversarial-autoresearch-"));
  const staging = join(workspace, "staging");
  mkdirSync(staging, { recursive: true });
  try {
    const cfgPath = safeRelative(projectRoot, task.domainConfigPath);
    const cfg = loadDomainConfig(cfgPath);
    for (const [name, content] of Object.entries(task.candidateFiles)) {
      const target = safeRelative(workspace, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    if (task.configPatch) {
      if (!cfg.configFile) throw new Error("task has a config patch but the domain has no configFile");
      const configPath = safeRelative(workspace, cfg.configFile);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(configPath, JSON.stringify({ ...config, ...task.configPatch }, null, 2), "utf8");
    }

    const adapter = createGenericAdapter(projectRoot, cfg);
    const experiment = adapter.runExperiment({
      worktree: workspace, stagingDir: staging, timeoutMs: task.experimentTimeoutMs,
    });
    if (!experiment.ok || !experiment.outputPath) {
      return { version: CLOUD_TASK_VERSION, taskId: task.taskId, taskIndex, experiment, evaluation: null,
        failure: experiment.failureCode ?? "experiment failed" };
    }
    const evaluation = adapter.evaluate({
      worktree: workspace, outputPath: experiment.outputPath, stagingDir: staging,
      baselinePrimary: task.baselinePrimary, baselineSecondary: task.baselineSecondary,
      supportDelta: task.supportDelta, timeoutMs: task.evaluatorTimeoutMs,
    });
    return { version: CLOUD_TASK_VERSION, taskId: task.taskId, taskIndex, experiment, evaluation,
      ...(evaluation.ok ? {} : { failure: evaluation.failureCode ?? "evaluation failed" }) };
  } catch (error) {
    return {
      version: CLOUD_TASK_VERSION, taskId: task.taskId, taskIndex,
      experiment: { ok: false, failureCode: "CLOUD_TASK_ERROR", stdout: "", stderr: String(error),
        durationMs: 0, selfReportedPrimary: null, outputPath: null, outputHash: null },
      evaluation: null, failure: String(error),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Entrypoint used by the evaluator Cloud Run Job image. */
export async function runCloudTaskFromEnvironment(): Promise<void> {
  const bucket = process.env.AR_ARTIFACT_BUCKET;
  const batchKey = process.env.AR_TASK_BATCH_KEY;
  const batchSha256 = process.env.AR_TASK_BATCH_SHA256;
  const resultPrefix = process.env.AR_RESULT_PREFIX;
  const taskIndex = Number(process.env.CLOUD_RUN_TASK_INDEX ?? "0");
  if (!bucket || !batchKey || !batchSha256 || !resultPrefix || !Number.isInteger(taskIndex) || taskIndex < 0) {
    throw new Error("artifact bucket, task batch key/hash, result prefix and a valid CLOUD_RUN_TASK_INDEX are required");
  }
  const store = new GcsArtifactStore(bucket);
  const tasks = JSON.parse((await store.get(batchKey, batchSha256)).toString("utf8")) as CloudEvaluationTask[];
  const task = tasks[taskIndex];
  if (!task) throw new Error(`task index ${taskIndex} is outside batch of ${tasks.length}`);
  const result = executeCloudTask(task, process.cwd(), taskIndex);
  await store.put(`${resultPrefix}/${String(taskIndex).padStart(4, "0")}.json`, Buffer.from(JSON.stringify(result)));
  // Candidate/evaluator failure is a scientific result, not task-infrastructure
  // failure. Exit successfully after persisting it so the coordinator can read
  // and judge the entire batch. Missing credentials/GCS failures still throw.
}
