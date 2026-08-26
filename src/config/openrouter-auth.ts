import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve OpenRouter credentials without ever copying them into campaign state.
 *
 * Pi's auth file is a compatibility fallback for the hackathon, not a runtime
 * dependency: an explicit environment variable always wins and deployments can
 * omit Pi entirely.  Callers must never log the returned value.
 */
export function resolveOpenRouterApiKey(
  env: NodeJS.ProcessEnv = process.env,
  piAuthPath = join(homedir(), ".pi", "agent", "auth.json"),
): string | null {
  const explicit = env.OPENROUTER_API_KEY?.trim();
  if (explicit) return explicit;
  if (!existsSync(piAuthPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(piAuthPath, "utf8")) as {
      openrouter?: { key?: unknown };
    };
    const key = typeof parsed.openrouter?.key === "string" ? parsed.openrouter.key.trim() : "";
    return key || null;
  } catch {
    return null;
  }
}

export function openRouterCredentialSource(
  env: NodeJS.ProcessEnv = process.env,
  piAuthPath = join(homedir(), ".pi", "agent", "auth.json"),
): "environment" | "pi-fallback" | "missing" {
  if (env.OPENROUTER_API_KEY?.trim()) return "environment";
  return resolveOpenRouterApiKey(env, piAuthPath) ? "pi-fallback" : "missing";
}
