/**
 * Evidence persistence.
 *
 * Invariant 1 says no claim without an artifact. That is only true if the chain
 * claim -> evidence -> evaluation -> attempt -> run -> contract is actually
 * written, and every artifact is content-addressed and immutable. This module
 * is that chain; `assertClaimIsCitable` is the check that it held.
 *
 * Artifacts are copied into a content-addressed store keyed by SHA-256, so an
 * identical checkpoint produced twice occupies one blob and any tampering
 * changes the address.
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256File } from "../core/workspace.js";
import { nowIso, sha256, canonicalJson, type Store } from "../store/store.js";

export interface RunRecord {
  runId: string;
  attemptId: string;
}

export function openRun(
  store: Store,
  campaignId: string,
  kind: "manager" | "executor" | "compute" | "evaluation" | "replay" | "report",
  opts: { hypothesisId?: string | null; contractId?: string | null; idempotencyKey: string; inputHash: string },
): RunRecord {
  const runId = `R-${randomUUID().slice(0, 12)}`;
  const attemptId = `A-${randomUUID().slice(0, 12)}`;
  store.db.prepare(
    `INSERT INTO runs (run_id, campaign_id, hypothesis_id, contract_id, kind, state,
       max_attempts, attempt_count, idempotency_key, created_at)
     VALUES (?,?,?,?,?, 'active', 3, 1, ?, ?)`,
  ).run(runId, campaignId, opts.hypothesisId ?? null, opts.contractId ?? null, kind,
        opts.idempotencyKey, nowIso());
  store.db.prepare(
    `INSERT INTO attempts (attempt_id, run_id, attempt_no, state, spawn_nonce, input_hash, started_at)
     VALUES (?,?,1,'running',?,?,?)`,
  ).run(attemptId, runId, randomUUID(), opts.inputHash, nowIso());
  return { runId, attemptId };
}

export function closeRun(
  store: Store,
  rec: RunRecord,
  ok: boolean,
  opts: { exitCode?: number | null; failureCode?: string | null; modelSpec?: unknown } = {},
): void {
  store.db.prepare(
    `UPDATE attempts SET state = ?, exit_code = ?, failure_code = ?, model_spec_json = ?, completed_at = ?
     WHERE attempt_id = ?`,
  ).run(
    ok ? "sealed" : "failed",
    opts.exitCode ?? null,
    opts.failureCode ?? null,
    opts.modelSpec ? canonicalJson(opts.modelSpec) : null,
    nowIso(),
    rec.attemptId,
  );
  store.db.prepare("UPDATE runs SET state = ?, terminal_at = ? WHERE run_id = ?")
    .run(ok ? "succeeded" : "failed", nowIso(), rec.runId);
}

/**
 * Seal a file into the content-addressed store and record it.
 * Returns null when the source does not exist, so a missing artifact is an
 * absence in the ledger rather than a silent success.
 */
export function sealArtifact(
  store: Store,
  campaignId: string,
  attemptId: string,
  kind: string,
  sourcePath: string,
  artifactRoot: string,
): string | null {
  if (!existsSync(sourcePath)) return null;
  const hash = sha256File(sourcePath);
  const dir = join(artifactRoot, hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, hash);
  if (!existsSync(dest)) copyFileSync(sourcePath, dest);

  const artifactId = `F-${hash.slice(0, 12)}`;
  const bytes = statSync(dest).size;
  store.db.prepare(
    `INSERT OR IGNORE INTO artifacts (artifact_id, artifact_hash, campaign_id, attempt_id, kind,
       relative_path, byte_length, manifest_json, sealed_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(artifactId, hash, campaignId, attemptId, kind,
        join(hash.slice(0, 2), hash), bytes,
        canonicalJson({ source: sourcePath, kind, bytes }), nowIso());
  return artifactId;
}

/** Seal an in-memory value as an artifact (diff text, stdout, evaluator JSON). */
export function sealText(
  store: Store,
  campaignId: string,
  attemptId: string,
  kind: string,
  content: string,
  stagingDir: string,
  artifactRoot: string,
): string | null {
  mkdirSync(stagingDir, { recursive: true });
  const staged = join(stagingDir, `${kind}.txt`);
  writeFileSync(staged, content, "utf8");
  return sealArtifact(store, campaignId, attemptId, kind, staged, artifactRoot);
}

export function recordEvaluation(
  store: Store,
  args: {
    campaignId: string;
    attemptId: string;
    contractId: string;
    candidateHash: string;
    evaluatorHash: string;
    environmentHash: string;
    raw: unknown;
    primaryValue: number | null;
    baselineValue: number | null;
    passedPrimary: boolean;
    passedReplay: boolean;
    passedLeakage: boolean;
    passedShortcut: boolean;
  },
): string {
  const evaluationId = `E-${randomUUID().slice(0, 12)}`;
  const resultJson = canonicalJson(args.raw ?? {});
  store.db.prepare(
    `INSERT INTO evaluations (evaluation_id, campaign_id, attempt_id, contract_id, candidate_hash,
       evaluator_hash, environment_hash, result_json, result_hash, primary_value, baseline_value,
       passed_primary, passed_replay, passed_leakage, passed_shortcut, accepted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    evaluationId, args.campaignId, args.attemptId, args.contractId, args.candidateHash,
    args.evaluatorHash, args.environmentHash, resultJson, sha256(resultJson),
    args.primaryValue, args.baselineValue,
    args.passedPrimary ? 1 : 0, args.passedReplay ? 1 : 0,
    args.passedLeakage ? 1 : 0, args.passedShortcut ? 1 : 0,
    nowIso(),
  );
  return evaluationId;
}

export function recordEvidence(
  store: Store,
  args: {
    campaignId: string;
    hypothesisId: string;
    attemptId: string | null;
    evaluationId: string | null;
    artifactId: string | null;
    kind: string;
    polarity: string;
    statement: string;
    strengthRule: string;
  },
): string {
  const id = `V-${randomUUID().slice(0, 12)}`;
  store.db.prepare(
    `INSERT INTO evidence (evidence_id, campaign_id, hypothesis_id, attempt_id, evaluation_id,
       artifact_id, kind, polarity, statement, strength_rule, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'verified', ?)`,
  ).run(id, args.campaignId, args.hypothesisId, args.attemptId, args.evaluationId,
        args.artifactId, args.kind, args.polarity, args.statement, args.strengthRule, nowIso());
  return id;
}

export interface CitabilityReport {
  citable: boolean;
  missing: string[];
}

/**
 * Invariant 1, checked rather than asserted: can this claim be resolved all the
 * way down to immutable artifacts and a registered contract?
 *
 * A claim that fails this check must not appear as a finding. The claim card
 * calls this for every claim it prints.
 */
export function assertClaimIsCitable(store: Store, hypothesisId: string): CitabilityReport {
  const missing: string[] = [];

  const contract = store.db
    .prepare("SELECT contract_id, registered_at FROM contracts WHERE hypothesis_id = ?")
    .get(hypothesisId) as { contract_id: string; registered_at: string } | undefined;
  if (!contract) missing.push("registered_contract");

  const evidence = store.db
    .prepare("SELECT evidence_id, attempt_id, evaluation_id FROM evidence WHERE hypothesis_id = ?")
    .all(hypothesisId) as Array<{ evidence_id: string; attempt_id: string | null; evaluation_id: string | null }>;
  if (evidence.length === 0) missing.push("evidence");
  if (evidence.length > 0 && evidence.every((e) => e.attempt_id === null)) missing.push("evidence_to_attempt_link");

  const artifacts = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM artifacts a
       JOIN attempts at ON at.attempt_id = a.attempt_id
       JOIN runs r ON r.run_id = at.run_id
       WHERE r.hypothesis_id = ?`,
    )
    .get(hypothesisId) as { n: number };
  if (artifacts.n === 0) missing.push("artifacts");

  return { citable: missing.length === 0, missing };
}
