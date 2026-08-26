/**
 * Moving a project's state directory to the current name.
 *
 * The directory cannot simply be renamed. Two things record where it is: the
 * store keeps absolute attempt and workspace paths, and git registers every
 * worktree by absolute path in `.git/worktrees`. Renaming the directory without
 * updating both leaves a store pointing at paths that no longer exist and a set
 * of worktrees git considers broken.
 *
 * So this is a migration with an order that matters — move, rewrite, repair —
 * and it refuses to run while anything is live, because a supervisor mid-attempt
 * holds open handles and would write the old paths straight back.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_STATE_DIR, STATE_DIR } from "./paths.js";
import { ResearchStore } from "./store.js";

export interface MigrationPlan {
  from: string; to: string;
  attemptDirs: number; workspacePaths: number; sourcePaths: number; worktrees: string[];
}

export interface MigrationResult extends MigrationPlan {
  moved: boolean; repaired: string[]; repairFailures: string[];
}

/** Live daemons, by the pid files they leave behind. */
export function livePidFiles(projectRoot: string, stateDirName: string): string[] {
  const dir = join(projectRoot, stateDirName);
  if (!existsSync(dir)) return [];
  const live: string[] = [];
  for (const entry of readdirSafe(dir)) {
    if (!entry.endsWith(".pid")) continue;
    try {
      const pid = Number(readFileSync(join(dir, entry), "utf8").trim());
      process.kill(pid, 0);
      live.push(`${entry} (pid ${pid})`);
    } catch { /* a stale pid file is not a live process */ }
  }
  return live;
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** What the migration would touch, without touching anything. */
export function planMigration(projectRoot: string, options: {
  from?: string; to?: string;
} = {}): MigrationPlan {
  const from = options.from ?? LEGACY_STATE_DIR;
  const to = options.to ?? STATE_DIR;
  const dbPath = join(projectRoot, from, "research.sqlite");
  const plan: MigrationPlan = { from, to, attemptDirs: 0, workspacePaths: 0, sourcePaths: 0, worktrees: [] };
  if (!existsSync(dbPath)) return plan;

  const store = ResearchStore.open(dbPath);
  try {
    const count = (sql: string) => Number((store.db.prepare(sql).get() as { n: number }).n);
    const needle = `%${from}%`;
    plan.attemptDirs = count(`SELECT COUNT(*) n FROM runs WHERE attempt_dir LIKE '${needle}'`);
    plan.workspacePaths = count(`SELECT COUNT(*) n FROM tasks WHERE workspace_path LIKE '${needle}'`);
    plan.sourcePaths = count(
      `SELECT COUNT(*) n FROM sources WHERE raw_path LIKE '${needle}' OR normalized_path LIKE '${needle}'`);
  } finally { store.close(); }

  plan.worktrees = registeredWorktrees(projectRoot)
    .filter((path) => path.replace(/\\/g, "/").includes(`/${from}/`));
  return plan;
}

function registeredWorktrees(projectRoot: string): string[] {
  try {
    return execFileSync("git", ["worktree", "list", "--porcelain"],
      { cwd: projectRoot, encoding: "utf8", windowsHide: true })
      .split(/\r?\n/).filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  } catch { return []; }
}

/**
 * Moves the directory, rewrites the recorded paths, and repairs the worktrees.
 * Refuses rather than half-migrating: a partial move is worse than none.
 */
export function migrateState(projectRoot: string, options: {
  from?: string; to?: string;
} = {}): MigrationResult {
  const from = options.from ?? LEGACY_STATE_DIR;
  const to = options.to ?? STATE_DIR;
  const source = join(projectRoot, from);
  const target = join(projectRoot, to);

  if (!existsSync(source)) throw new Error(`nothing to migrate: ${from} does not exist`);
  if (existsSync(target)) throw new Error(`refusing to migrate: ${to} already exists`);
  const live = livePidFiles(projectRoot, from);
  if (live.length > 0) {
    throw new Error(
      `refusing to migrate while research is running: ${live.join(", ")}. `
      + "Stop the supervisor, watcher and dashboard first — a running attempt would write the old paths back.");
  }

  const plan = planMigration(projectRoot, { from, to });
  // Move first: the store lives inside the directory being moved, so rewriting
  // paths beforehand would edit a database that is about to change location.
  renameSync(source, target);

  const store = ResearchStore.open(join(target, "research.sqlite"));
  try {
    // The separator is part of the match so a directory merely *named* like the
    // state directory elsewhere in a path is not rewritten.
    for (const [table, column] of [["runs", "attempt_dir"], ["tasks", "workspace_path"],
      ["sources", "raw_path"], ["sources", "normalized_path"]] as const) {
      for (const separator of ["\\", "/"]) {
        store.db.prepare(
          `UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE ${column} LIKE ?`,
        ).run(`${separator}${from}${separator}`, `${separator}${to}${separator}`, `%${separator}${from}${separator}%`);
      }
    }
  } finally { store.close(); }

  const repaired: string[] = [];
  const repairFailures: string[] = [];
  for (const worktree of plan.worktrees) {
    const moved = worktree.replace(`/${from}/`, `/${to}/`).replace(`\\${from}\\`, `\\${to}\\`);
    try {
      execFileSync("git", ["worktree", "repair", moved], { cwd: projectRoot, windowsHide: true });
      repaired.push(moved);
    } catch (error) {
      // A worktree that cannot be repaired is reported rather than hidden: the
      // attempt it holds is still on disk and can be recovered by hand.
      repairFailures.push(`${moved}: ${String(error).split(/\r?\n/)[0]}`);
    }
  }
  try { execFileSync("git", ["worktree", "prune"], { cwd: projectRoot, windowsHide: true }); } catch { /* best effort */ }

  return { ...plan, moved: true, repaired, repairFailures };
}
