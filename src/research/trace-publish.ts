/**
 * Publishing agent traces without publishing the machine that produced them.
 *
 * A trace is the most informative part of a run — the reasoning, the code the
 * agent wrote, the checks it ran — and it is also the part most likely to carry
 * something personal, because tool output is whatever the machine printed. The
 * two are not separable by inspection: a stack trace embeds a home directory, a
 * failed request can echo a key, `git log` carries an email address.
 *
 * So the boundary is not a scrub, it is a verification. Text is redacted first,
 * and then *checked* against identifiers taken from the running environment —
 * the actual username, hostname, home directory, and the value of every
 * credential-shaped variable. A step whose text still contains one of those is
 * withheld rather than published. A pattern this module fails to anticipate
 * therefore costs a missing step, never a leak, and the withheld marker makes
 * the omission visible instead of silent.
 *
 * Tool *output* is withheld by default even when it passes: it is unbounded
 * machine output rather than research, so publishing it is an explicit choice
 * (`--with-tool-output`) rather than something a default turns on.
 */

import { homedir, hostname, userInfo } from "node:os";

/** Steps kept per run. Bounds what a runaway attempt can push into the mirror. */
export const MAX_PUBLISHED_STEPS = 5_000;
/** Characters kept per step, before the identifier check. */
export const MAX_PUBLISHED_STEP_CHARS = 2_000;

/**
 * A drive letter is a single letter, so the lookbehind matters: without it
 * `file:///…` and `https://…` both parse as one — the `e:` in "file" and the
 * `s:` in "https" — and every URL in the published research would be replaced
 * by a path marker.
 */
const HOME_PATH = /(?<![A-Za-z])(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/(?:home|Users)\/[^/\s"']+)/g;
const WINDOWS_PATH = /(?<![A-Za-z])[A-Za-z]:[\\/]+[^\s"']*/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Credential shapes that appear verbatim in provider errors and shell echoes. */
const SECRET_SHAPED = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|ya29\.[A-Za-z0-9_-]{16,})/g;
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;

/**
 * Literal strings that must not survive into the published record, read from
 * the environment rather than guessed. Short values are dropped: a two-letter
 * username would match half the corpus and withhold every step.
 */
export function machineIdentifiers(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined | null) => {
    const text = String(value ?? "").trim();
    if (text.length >= 4) found.add(text);
  };
  add(env.USERNAME); add(env.USER); add(env.LOGNAME);
  add(env.COMPUTERNAME); add(env.HOSTNAME);
  try { add(userInfo().username); } catch { /* unavailable in some sandboxes */ }
  try { add(hostname()); } catch { /* unavailable in some sandboxes */ }
  try { add(homedir()); } catch { /* unavailable in some sandboxes */ }
  add(env.GIT_AUTHOR_EMAIL); add(env.GIT_COMMITTER_EMAIL); add(env.EMAIL);
  // The values of credentials, not their names: a key echoed by a failing tool
  // is the worst thing a trace can carry.
  for (const [name, value] of Object.entries(env)) {
    if (CREDENTIAL_NAME.test(name) && value && value.trim().length >= 8) found.add(value.trim());
  }
  return [...found];
}

/** Removes the shapes we can recognise. The identifier check is what enforces. */
export function redactTraceText(text: string): string {
  return String(text ?? "")
    .replace(SECRET_SHAPED, "<redacted-credential>")
    .replace(HOME_PATH, "<workspace>")
    .replace(WINDOWS_PATH, "<path>")
    .replace(EMAIL, "<email>")
    .replace(IPV4, "<ip>");
}

/** The first identifier still present, or null. Case-insensitive by design. */
export function residualIdentifier(text: string, identifiers: string[]): string | null {
  const haystack = String(text ?? "").toLowerCase();
  for (const identifier of identifiers) {
    if (haystack.includes(identifier.toLowerCase())) return identifier;
  }
  return null;
}

export interface PublishedTraceStep {
  seq: number; atMs: number; kind: string;
  toolName?: string; content: string; isError?: boolean; withheld?: string;
}

/**
 * Firestore rejects a document containing `undefined`, so an absent field has
 * to be an absent key rather than a key set to nothing. A step without a tool
 * name is the common case, so this is the difference between publishing and
 * failing the whole batch.
 */
function withoutUndefined(step: PublishedTraceStep): PublishedTraceStep {
  return Object.fromEntries(Object.entries(step)
    .filter(([, value]) => value !== undefined)) as unknown as PublishedTraceStep;
}

/**
 * One step as it may appear publicly, or null when the step has no public form.
 * Content that fails the identifier check is replaced rather than dropped, so a
 * reader sees that something was withheld at that point in the run.
 */
export function publishableTraceStep(step: Record<string, unknown>, options: {
  identifiers: string[]; includeToolOutput?: boolean;
}): PublishedTraceStep | null {
  const kind = String(step.kind ?? "");
  if (!kind) return null;
  const seq = Number(step.seq ?? 0);
  const atMs = Number(step.atMs ?? 0);
  const toolName = step.toolName ? String(step.toolName) : undefined;
  const isError = Boolean(step.isError);
  const raw = String(step.content ?? "");

  if (kind === "tool_result" && !options.includeToolOutput) {
    // Not published, but its shape is: how much a check printed and whether it
    // failed are part of reading a run, and neither is machine-identifying.
    return withoutUndefined({ seq, atMs, kind, toolName, isError,
      content: `[${raw.length.toLocaleString()} characters of tool output; not published]`,
      withheld: "tool-output" });
  }

  const truncated = raw.length > MAX_PUBLISHED_STEP_CHARS
    ? `${raw.slice(0, MAX_PUBLISHED_STEP_CHARS)}\n[truncated at ${MAX_PUBLISHED_STEP_CHARS} characters]`
    : raw;
  const redacted = redactTraceText(truncated);
  if (residualIdentifier(redacted, options.identifiers)) {
    return withoutUndefined({ seq, atMs, kind, toolName, isError,
      content: "[withheld: this step still contained machine-identifying text after redaction]",
      withheld: "identifier" });
  }
  return withoutUndefined({ seq, atMs, kind, toolName, isError, content: redacted });
}

export function publishableTrace(steps: Array<Record<string, unknown>>, options: {
  identifiers: string[]; includeToolOutput?: boolean;
}): PublishedTraceStep[] {
  return steps.slice(0, MAX_PUBLISHED_STEPS)
    .map((step) => publishableTraceStep(step, options))
    .filter((step): step is PublishedTraceStep => step !== null);
}

/**
 * Steps are grouped into documents rather than written one per document.
 *
 * A trace is append-only, so all but the last group are final once written and
 * republishing them is idempotent. Grouping turns a sync of a thousand-step run
 * into a dozen writes instead of a thousand, which is what makes republishing
 * every couple of minutes affordable, and it keeps each document far below the
 * 1 MB Firestore limit.
 */
export const STEPS_PER_CHUNK = 100;

export function chunkTraceSteps(runId: string, steps: PublishedTraceStep[]): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [];
  for (let index = 0; index < steps.length; index += STEPS_PER_CHUNK) {
    const slice = steps.slice(index, index + STEPS_PER_CHUNK);
    chunks.push({
      chunk_id: `${runId}__${String(index / STEPS_PER_CHUNK).padStart(4, "0")}`,
      run_id: runId, from_seq: slice[0]?.seq ?? 0, steps: slice,
    });
  }
  return chunks;
}
