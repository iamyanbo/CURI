import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { geminiApiKey, vertexApiKey } from "./env-file.js";
import type { RuntimeConfig } from "./runtime.js";
import { openRouterCredentialSource } from "./openrouter-auth.js";

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

  if (config.modelProvider === "openrouter") {
    const source = openRouterCredentialSource(env);
    checks.push({ name: "OpenRouter API key", ok: source !== "missing",
      detail: source === "environment" ? "configured in environment"
        : source === "pi-fallback" ? "available through read-only Pi auth fallback"
          : "set OPENROUTER_API_KEY or sign in to OpenRouter with Pi" });
  } else if (config.modelProvider === "openai-compatible") {
    const baseUrl = env.AR_MODEL_BASE_URL?.trim();
    checks.push({ name: "OpenAI-compatible model endpoint", ok: Boolean(baseUrl),
      detail: baseUrl ?? "set AR_MODEL_BASE_URL to the server's /v1 endpoint" });
    checks.push({ name: "Served model name", ok: Boolean(env.AR_MODEL?.trim()),
      detail: env.AR_MODEL?.trim() || "set AR_MODEL to the name returned by the server" });
  } else if (config.modelProvider === "gemini-api") {
    checks.push({ name: "Gemini API key", ok: Boolean(geminiApiKey(env)),
      detail: geminiApiKey(env) ? "configured" : "set GEMINI_API_KEY (or GOOGLE_API_KEY)" });
  } else if (vertexApiKey(env)) {
    // Express mode authenticates with a key and is regionless, so it needs
    // neither a project nor Application Default Credentials. Reporting those as
    // failures sent an otherwise correctly configured machine chasing nothing.
    checks.push({ name: "Vertex AI express key", ok: true, detail: "configured" });
  } else {
    const adcPath = env.GOOGLE_APPLICATION_CREDENTIALS
      ?? join(homedir(), ".config", "gcloud", "application_default_credentials.json");
    checks.push({ name: "Vertex project", ok: Boolean(env.GOOGLE_CLOUD_PROJECT),
      detail: env.GOOGLE_CLOUD_PROJECT ?? "set GOOGLE_CLOUD_PROJECT, or set VERTEX_API_KEY for express mode" });
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
