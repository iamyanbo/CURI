/**
 * The bridge between the research loop and a domain.
 *
 * `cycle.ts` and `campaign.ts` talk only to this. They never import a domain,
 * never know what a seed is, and never assume an experiment is cheap or
 * reproducible. Everything field-specific arrives through the `DomainAdapter`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ChangeClass, DiffFacts, DomainAdapter, EvaluationResult, ExperimentOutcome,
} from "../domain/types.js";
import {
  changedConfigKeys, commitCandidate, commitProgramCheckpoint, createWorktree, diffAgainstHead, ensureRepo,
  escapesReproductionPolicy, git, materialiseCandidate, removeWorktree,
  revisionExists, sha256Tree, touchesProtected,
} from "./workspace.js";

export class Harness {
  readonly repoDir: string;
  readonly worktreeRoot: string;

  /**
   * `sandbox` redirects the candidate repository and worktree root elsewhere.
   *
   * This is a first-class capability, not a workaround: verification tools -
   * planted-cheat fixtures, the counterfactual - must run real experiments
   * without touching a live campaign's repository. Making it explicit is safer
   * than letting those tools reach in and mutate the fields.
   */
  constructor(
    readonly projectRoot: string,
    readonly domain: DomainAdapter,
    sandbox?: { repoDir: string; worktreeRoot: string },
  ) {
    // Scoped per DOMAIN, not per project.
    //
    // A single shared `candidate/` meant the second domain to run inherited the
    // first one's files: the finance fixtures went looking for `strategy.py` in
    // a repository holding `kernel.cu`, reported "does not apply", and passed
    // verification by testing nothing. Two domains cannot share one candidate
    // repository, and the failure is silent when they try.
    const slug = domain.id.replace(/[^\w.-]/g, "_");
    this.repoDir = sandbox?.repoDir ?? join(projectRoot, ".autoresearch", "candidate", slug);
    this.worktreeRoot = sandbox?.worktreeRoot ?? join(projectRoot, ".autoresearch", "worktrees", slug);
  }

  /** Initialise the candidate repository if needed; returns its git HEAD. */
  ensureRepo(): string {
    return ensureRepo(this.repoDir, (dir) => this.domain.initialise(this.projectRoot, dir));
  }

  /** Hash of everything the candidate must never touch. */
  protectedHash(): string {
    const parts = this.domain.protectedPaths(this.projectRoot)
      .filter((p) => existsSync(p))
      .map((p) => sha256Tree(p));
    return parts.join(":");
  }

  hasRevision(revision: string): boolean {
    return revisionExists(this.repoDir, revision);
  }

  worktree(id: string, revision: string): string {
    if (!revisionExists(this.repoDir, revision)) {
      throw new Error(
        `revision ${revision.slice(0, 12)} is not in ${this.repoDir}. The campaign ledger ` +
        "references a commit the candidate repository no longer has - usually because the " +
        "repository was recreated. The ledger and the repository must be reconciled before " +
        "any further experiment can be trusted.",
      );
    }
    return createWorktree(this.repoDir, this.worktreeRoot, id, revision);
  }

  discard(dir: string): void {
    removeWorktree(this.repoDir, dir);
  }

  /**
   * What the executor actually changed — generic facts plus the domain's own
   * reading of them. Never the worker's self-description: a candidate calling a
   * knob tweak a "mechanism" cannot spend the mechanism lane's budget.
   */
  classify(worktree: string): DiffFacts {
    const { changedPaths, diffText } = diffAgainstHead(worktree);
    const reserved = this.domain.reservedConfigKeys();
    const protectedPaths = this.domain.protectedPaths(this.projectRoot);

    let configKeysChanged: string[] = [];
    let undeclared: string[] = [];
    const configFile = this.domain.candidateFiles.find((f) => f.endsWith(".json"));

    let malformedConfig = false;
    if (configFile && changedPaths.includes(configFile)) {
      // A candidate that writes malformed JSON must produce a VERDICT, not an
      // exception. Parsing its output unguarded let a candidate crash the whole
      // campaign - a denial of service any executor could trigger by accident.
      try {
        const before = JSON.parse(git(["show", `HEAD:${configFile}`], worktree));
        const after = JSON.parse(readFileSync(join(worktree, configFile), "utf8"));
        configKeysChanged = changedConfigKeys(before, after);
        const declared = this.domain.parameterSurface(before);
        const configOnly = changedPaths.every((f) => f === configFile);
        undeclared = configKeysChanged.filter((k) => {
          if (reserved.has(k)) return true;            // harness-owned, always a violation
          if (declared.has(k)) return false;
          return configOnly;                            // a new knob with no code behind it
        });
      } catch {
        malformedConfig = true;
        undeclared = [`${configFile}:unparseable`];
      }
    }

    const touched = touchesProtected(diffText, changedPaths, protectedPaths);
    const escaped = escapesReproductionPolicy(diffText, reserved);

    const changeClass: ChangeClass = touched
      ? "evaluation"
      : this.domain.classifyChange(diffText, changedPaths, configKeysChanged);

    return {
      changedPaths, diffText, changeClass,
      touchedProtected: touched,
      undeclaredConfigKeys: undeclared,
      escapedReproductionPolicy: escaped,
      malformedConfig,
    };
  }

  /**
   * The candidate's own source at a revision, for the manager's context.
   *
   * The manager could previously see the metric, the history and the file
   * NAMES, but never the code. It therefore proposed changes the candidate
   * already contained - observed live: it proposed float4 vectorised stores for
   * a kernel whose stores were already float4, and the executor spent a cycle
   * verifying that before correctly refusing to invent a diff.
   *
   * Bounded on purpose. An unbounded context packet once exceeded the OS argv
   * limit and crashed a run, so each file and the total are clipped.
   */
  candidateSource(revision: string, maxPerFile = 8000, maxTotal = 16000): Record<string, string> {
    const out: Record<string, string> = {};
    let budget = maxTotal;
    let tracked: string[] = [];
    try { tracked = git(["ls-tree", "-r", "--name-only", revision], this.repoDir).split(/\r?\n/).filter(Boolean); }
    catch { /* candidate entrypoints below remain available */ }
    const files = [...new Set([...this.domain.candidateFiles, ...tracked])];
    for (const file of files) {
      if (budget <= 0) break;
      try {
        const text = git(["show", `${revision}:${file}`], this.repoDir);
        const limit = Math.min(maxPerFile, budget);
        out[file] = text.length > limit
          ? `${text.slice(0, limit)}
... [clipped: ${text.length - limit} more characters]`
          : text;
        budget -= out[file]!.length;
      } catch {
        // A file absent at this revision is not an error worth failing a cycle.
      }
    }
    return out;
  }

  run(worktree: string, stagingDir: string, timeoutMs: number): ExperimentOutcome {
    return this.domain.runExperiment({ worktree, stagingDir, timeoutMs });
  }

  evaluate(args: {
    worktree: string; outputPath: string; stagingDir: string;
    baselinePrimary: number; baselineSecondary: number | null;
    supportDelta: number; timeoutMs: number;
  }): EvaluationResult {
    return this.domain.evaluate(args);
  }

  /**
   * Reproduce a sealed candidate under one variant of the domain's reproduction
   * policy — a seed, a time window, an independent run. Rebuilt from the pinned
   * revision plus the sealed diff, never from the original worktree, so what is
   * reproduced is exactly what was judged.
   */
  reproduce(
    id: string, revision: string, diffText: string, configPatch: Record<string, unknown>,
  ): { worktree: string | null; failure?: string } {
    const configFile = this.domain.candidateFiles.find((f) => f.endsWith(".json")) ?? null;
    return materialiseCandidate(
      this.repoDir, this.worktreeRoot, id, revision, diffText, configFile, configPatch,
    );
  }

  advance(baseRevision: string, diffText: string, message: string) {
    return commitCandidate(this.repoDir, this.worktreeRoot, baseRevision, diffText, message);
  }

  checkpoint(baseRevision: string, diffText: string, message: string, programKey: string) {
    return commitProgramCheckpoint(
      this.repoDir, this.worktreeRoot, baseRevision, diffText, message, programKey,
    );
  }

  /** The reproduction variants to attempt, from the domain's own policy. */
  reproductionVariants() {
    return this.domain.replication.variants(this.domain.replication.attempts);
  }

  /**
   * How many reproductions must clear the bar.
   *
   * Not always all of them. Unanimity on a noisy metric is the most likely way
   * to reject real work: a validated claim was lost when one seed of three
   * missed its threshold by 0.01 (`plans/06-findings.md` §5.1).
   */
  get minAgreement(): number {
    return this.domain.replication.minAgreement;
  }
}
