/** Coordinator-side Cloud Run Jobs dispatcher. Judgement stays in the coordinator. */

import { randomUUID } from "node:crypto";
import { JobsClient } from "@google-cloud/run";

import { GcsArtifactStore } from "../artifacts/store.js";
import type { CloudEvaluationResult, CloudEvaluationTask } from "./evaluation-task.js";

export interface CloudRunDispatcherOptions {
  projectId: string;
  region: string;
  jobName: string;
  bucket: string;
  containerName?: string;
  timeoutSeconds?: number;
}

export class CloudRunDispatcher {
  constructor(readonly options: CloudRunDispatcherOptions, readonly jobs = new JobsClient()) {}

  async evaluate(tasks: CloudEvaluationTask[]): Promise<CloudEvaluationResult[]> {
    if (tasks.length < 1 || tasks.length > 100) throw new Error("a Cloud Run batch must contain 1-100 tasks");
    const batchId = randomUUID();
    const batchKey = `tasks/${batchId}.json`;
    const resultPrefix = `results/${batchId}`;
    const artifacts = new GcsArtifactStore(this.options.bucket);
    const storedBatch = await artifacts.put(batchKey, Buffer.from(JSON.stringify(tasks)));

    const name = this.options.jobName.includes("/")
      ? this.options.jobName
      : `projects/${this.options.projectId}/locations/${this.options.region}/jobs/${this.options.jobName}`;
    const [operation] = await this.jobs.runJob({
      name,
      overrides: {
        taskCount: tasks.length,
        timeout: { seconds: this.options.timeoutSeconds ?? 3300 },
        containerOverrides: [{
          ...(this.options.containerName ? { name: this.options.containerName } : {}),
          env: [
            { name: "AR_ARTIFACT_BUCKET", value: this.options.bucket },
            { name: "AR_TASK_BATCH_KEY", value: batchKey },
            { name: "AR_TASK_BATCH_SHA256", value: storedBatch.sha256 },
            { name: "AR_RESULT_PREFIX", value: resultPrefix },
          ],
        }],
      },
    });
    await operation.promise();

    const results: CloudEvaluationResult[] = [];
    for (let index = 0; index < tasks.length; index++) {
      const content = await artifacts.get(`${resultPrefix}/${String(index).padStart(4, "0")}.json`);
      const result = JSON.parse(content.toString("utf8")) as CloudEvaluationResult;
      if (result.version !== 1 || result.taskIndex !== index || result.taskId !== tasks[index]!.taskId) {
        throw new Error(`Cloud Run result identity mismatch at task ${index}`);
      }
      results.push(result);
    }
    return results;
  }
}
