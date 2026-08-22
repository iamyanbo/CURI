/**
 * Candidate workspace management — domain-independent.
 *
 * Everything here works the same whether the candidate is a training script, a
 * trading strategy, or an assay protocol: give the executor an isolated copy at
 * a pinned revision, capture exactly what it changed, seal that as evidence, and
 * be able to rebuild it later from the sealed diff alone.
 *
 * This was previously inside the tinyml adapter, which made it look
 * domain-specific. It is not. Roughly 80% of that file was this.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Content hash of a whole directory tree — order-stable, path-normalised. */
export function sha256Tree(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        h.update(relative(root, full).split(sep).join("/"));
        h.update(sha256File(full));
      }
    }
  };
  walk(root);
  return h.digest("hex");
}

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }).trim();
}

/** Create the candidate repository if absent; returns its current revision. */
export function ensureRepo(repoDir: string, seed: (dir: string) => void): string {
  if (!existsSync(join(repoDir, ".git"))) {
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-q", "-b", "main"], repoDir);
    git(["config", "user.email", "harness@local"], repoDir);
    git(["config", "user.name", "autoresearch"], repoDir);
    seed(repoDir);
    git(["add", "-A"], repoDir);
    git(["commit", "-q", "-m", "baseline"], repoDir);
  }
  return git(["rev-parse", "HEAD"], repoDir);
}

/**
 * Does this revision exist in the repository?
 *
 * A campaign records the revision each experiment was built on. If the
 * candidate repository is recreated, those recorded revisions become dangling
 * and every later operation fails with an opaque git error. Checking first lets
 * callers report an unrecoverable ledger state plainly instead of crashing.
 */
export function revisionExists(repoDir: string, revision: string): boolean {
  const res = spawnSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: repoDir, windowsHide: true });
  return res.status === 0;
}

export function createWorktree(repoDir: string, worktreeRoot: string, id: string, revision: string): string {
  mkdirSync(worktreeRoot, { recursive: true });
  const dir = join(worktreeRoot, id.replace(/[^\w-]/g, "_"));
  git(["worktree", "add", "-q", "--detach", dir, revision], repoDir);
  return dir;
}

export function removeWorktree(repoDir: string, dir: string): void {
  spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: repoDir, windowsHide: true });
}

/** Raw diff facts, before any domain interpretation. */
export function diffAgainstHead(worktree: string): { changedPaths: string[]; diffText: string } {
  const names = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: worktree, encoding: "utf8", windowsHide: true });
  const diff = spawnSync("git", ["diff", "HEAD"], {
    cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return {
    changedPaths: (names.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
    diffText: diff.stdout ?? "",
  };
}

/** Which keys differ between two config objects. */
export function changedConfigKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) keys.push(k);
  }
  return keys;
}

/**
 * Does the diff pin something the harness owns?
 *
 * Generic across domains because the failure is generic: a candidate that fixes
 * its own seed, fold, or date window has escaped the reproduction policy and
 * made replication meaningless. In this project a candidate wrote
 * `cfg["seed"] = 12345`, and three "independent" reruns returned identical
 * numbers that were scored as three confirmations.
 *
 * Written with explicit character classes rather than a word-boundary escape:
 * an earlier version used one, was generated through a heredoc that turned it
 * into a literal backspace byte, and matched nothing for an entire campaign.
 */
export function escapesReproductionPolicy(diffText: string, reservedKeys: Iterable<string>): boolean {
  for (const key of reservedKeys) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\+.*cfg\\s*\\[\\s*["']${k}["']\\s*\\]\\s*=`, "m").test(diffText)) return true;
    if (new RegExp(`^\\+\\s*${k}\\s*=\\s*[\\d"']`, "m").test(diffText)) return true;
  }
  return /^\+.*(?:torch\.manual_seed|random\.seed|np\.random\.seed)\s*\(\s*\d+\s*\)/m.test(diffText);
}

export function touchesProtected(diffText: string, changedPaths: string[], protectedPaths: string[]): boolean {
  const marks = protectedPaths.map((p) => p.split(sep).pop() ?? p);
  if (changedPaths.some((f) => marks.some((m) => f.includes(m)))) return true;
  return marks.some((m) => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(diffText));
}

/** Rebuild a sealed candidate at a pinned revision, optionally patching its config. */
export function materialiseCandidate(
  repoDir: string,
  worktreeRoot: string,
  id: string,
  revision: string,
  diffText: string,
  configFile: string | null,
  configPatch: Record<string, unknown>,
): { worktree: string | null; failure?: string } {
  let worktree: string | null = null;
  try {
    worktree = createWorktree(repoDir, worktreeRoot, id, revision);
    if (diffText.trim().length > 0) {
      const patchPath = join(worktree, ".candidate.patch");
      writeFileSync(patchPath, diffText, "utf8");
      const applied = spawnSync("git", ["apply", "--whitespace=nowarn", ".candidate.patch"], {
        cwd: worktree, encoding: "utf8", windowsHide: true });
      try { unlinkSync(patchPath); } catch { /* best effort */ }
      if (applied.status !== 0) {
        return { worktree, failure: `PATCH_DID_NOT_APPLY: ${(applied.stderr ?? "").slice(0, 300)}` };
      }
    }
    if (configFile && Object.keys(configPatch).length > 0) {
      const p = join(worktree, configFile);
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      Object.assign(cfg, configPatch);
      writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
    }
    return { worktree };
  } catch (err) {
    return { worktree, failure: `MATERIALISE_FAILED: ${String(err).slice(0, 300)}` };
  }
}

/**
 * Commit a validated candidate onto the repo, producing the new base revision.
 *
 * Kept reachable by a ref rather than a branch: `main` is checked out in the
 * repository and git refuses to force-update a checked-out branch. Worktrees are
 * created detached from an explicit SHA, so no branch is required.
 */
export function commitCandidate(
  repoDir: string,
  worktreeRoot: string,
  baseRevision: string,
  diffText: string,
  message: string,
): { ok: true; revision: string } | { ok: false; failure: string } {
  const dir = join(worktreeRoot, `advance-${Date.now()}`);
  try {
    git(["worktree", "add", "-q", "--detach", dir, baseRevision], repoDir);
    if (diffText.trim().length > 0) {
      const patch = join(dir, ".advance.patch");
      writeFileSync(patch, diffText, "utf8");
      const applied = spawnSync("git", ["apply", "--whitespace=nowarn", ".advance.patch"], {
        cwd: dir, encoding: "utf8", windowsHide: true });
      try { unlinkSync(patch); } catch { /* best effort */ }
      if (applied.status !== 0) {
        return { ok: false, failure: `patch did not apply to current base: ${(applied.stderr ?? "").slice(0, 200)}` };
      }
    }
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", message], dir);
    const revision = git(["rev-parse", "HEAD"], dir);
    git(["update-ref", `refs/autoresearch/baseline/${revision}`, revision], repoDir);
    git(["update-ref", "refs/autoresearch/baseline/current", revision], repoDir);
    return { ok: true, revision };
  } catch (err) {
    return { ok: false, failure: String(err).slice(0, 200) };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: repoDir, windowsHide: true });
  }
}
