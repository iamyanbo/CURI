import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Local credential loading for a project that also has to run in the cloud.
 *
 * Node's own `process.loadEnvFile` is used rather than a dependency, and its
 * precedence is the reason this is safe to ship: a variable already present in
 * the real environment always beats the file. On Cloud Run there is no `.env`
 * in the image and configuration arrives as service environment variables or
 * Secret Manager references, so this call is a no-op there; locally it saves
 * exporting keys by hand into every shell that starts a daemon.
 *
 * The file is therefore a developer convenience, never a deployment artefact.
 * It must stay untracked: a committed `.env` would both leak credentials and
 * silently shadow nothing, since the environment wins anyway.
 */
export function loadEnvFile(projectRoot = process.cwd(), fileName = ".env"): string | null {
  const path = resolve(projectRoot, fileName);
  if (!existsSync(path)) return null;
  try {
    process.loadEnvFile(path);
    return path;
  } catch (error) {
    // A malformed .env must not take the runtime down: the real environment may
    // already carry everything needed, and the doctor reports what is missing.
    process.emitWarning(`ignoring unreadable ${fileName}: ${String(error)}`);
    return null;
  }
}

/**
 * The credential this project reads for the Gemini API. Google tooling hands
 * out the same key under either name depending on where it was created, and the
 * runtime accepted only one of them.
 */
export function geminiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined;
}

/**
 * The credential for Vertex AI express mode. Vertex normally authenticates with
 * Application Default Credentials, but an express-mode API key is a distinct
 * pool from the Gemini API key, so it gets its own variable rather than being
 * conflated with `GEMINI_API_KEY`.
 */
export function vertexApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.VERTEX_API_KEY?.trim() || env.GOOGLE_VERTEX_API_KEY?.trim() || undefined;
}
