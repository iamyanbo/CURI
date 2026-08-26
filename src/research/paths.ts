/**
 * Where CURI keeps its state on disk.
 *
 * The directory name used to be written out at every call site, which meant the
 * project's name was a fact spread across twenty files instead of one decision.
 * It is defined here once, and every path in the runtime is built from it.
 *
 * The name is resolved rather than fixed, because a run in progress cannot be
 * renamed underneath itself: the store records attempt directories, and git
 * registers each worktree by absolute path, so moving the directory is a
 * migration and not a rename. A project that already has the legacy directory
 * therefore keeps using it, and only a fresh project gets the current name.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR = ".curi";
/** The name used before the project was renamed to CURI. */
export const LEGACY_STATE_DIR = ".autoresearch";

/**
 * The state directory name for a project: an explicit override first, then an
 * existing directory of either name, and the current name when neither exists.
 */
export function stateDirName(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CURI_STATE_DIR?.trim();
  if (override) return override;
  if (existsSync(join(projectRoot, STATE_DIR))) return STATE_DIR;
  if (existsSync(join(projectRoot, LEGACY_STATE_DIR))) return LEGACY_STATE_DIR;
  return STATE_DIR;
}

export function stateDir(projectRoot: string, env?: NodeJS.ProcessEnv): string {
  return join(projectRoot, stateDirName(projectRoot, env));
}

/** A path inside the state directory. */
export function statePath(projectRoot: string, ...parts: string[]): string {
  return join(stateDir(projectRoot), ...parts);
}
