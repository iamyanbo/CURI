import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { RuntimeConfig } from "./runtime.js";

export interface DoctorCheck { name: string; ok: boolean; detail: string }

const command = (name: string, args: string[]) => {
  const result = spawnSync(name, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return { ok: result.status === 0, detail: (result.stdout || result.stderr || "not found").trim().split(/\r?\n/)[0]! };
};

export function runtimeDoctor(config: RuntimeConfig, env = process.env): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "Node.js >=22.19", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  const git = command("git", ["--version"]);
  checks.push({ name: "Git", ...git });

  if (config.modelProvider === "gemini-api") {
    checks.push({ name: "Gemini API key", ok: Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
      detail: env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? "configured" : "set GEMINI_API_KEY" });
  } else {
    const adcPath = env.GOOGLE_APPLICATION_CREDENTIALS
      ?? join(homedir(), ".config", "gcloud", "application_default_credentials.json");
    checks.push({ name: "Vertex project", ok: Boolean(env.GOOGLE_CLOUD_PROJECT),
      detail: env.GOOGLE_CLOUD_PROJECT ?? "set GOOGLE_CLOUD_PROJECT" });
    checks.push({ name: "Application Default Credentials", ok: existsSync(adcPath),
      detail: existsSync(adcPath) ? adcPath : "run: gcloud auth application-default login" });
  }

  if (config.compute === "cloud-run" || config.store === "firestore") {
    for (const [name, key] of [
      ["Artifact bucket", "AR_ARTIFACT_BUCKET"], ["Evaluator job", "AR_EVALUATOR_JOB"],
    ] as const) {
      checks.push({ name, ok: Boolean(env[key]), detail: env[key] ?? `set ${key}` });
    }
  }
  return checks;
}

export function assertCampaignRuntime(config: RuntimeConfig): void {
  if (config.compute !== "local" || config.store !== "sqlite") {
    throw new Error(
      "the authoritative campaign coordinator currently requires --compute local --store sqlite. " +
      "Use cloud-evaluate for Cloud Run GPU batches and migrate:firestore for the verified ledger copy; " +
      "this guard prevents a cloud flag from silently writing local state.",
    );
  }
}
