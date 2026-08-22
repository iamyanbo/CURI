/**
 * Audit every rejected claim: was it rejected for a reason you can inspect?
 *
 * A rejection with no readable evidence is indistinguishable from a wrong
 * rejection, which is the failure mode this project cares most about. For each
 * refuted / implementation_invalid / shortcut_suspected claim this prints the
 * verdict, the numbers it was judged on, the checks that failed, and whether a
 * trace and an evaluation record actually exist.
 */

import { Store } from "./src/store/store.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[3] ?? "C:/Users/yanbo/downloads/google-hackathon";
const CAMPAIGN = process.argv[2] ?? "cuda-001";
const s = Store.open(join(ROOT, ".autoresearch", "state.sqlite"));

const REJECTED = ["refuted", "implementation_invalid", "shortcut_suspected"];

const rows = s.db.prepare(
  `SELECT hypothesis_id, lane, title, status, created_at
   FROM hypotheses WHERE campaign_id = ? AND status IN (${REJECTED.map(() => "?").join(",")})
   ORDER BY created_at`,
).all(CAMPAIGN, ...REJECTED) as any[];

console.log(`${rows.length} rejected claims in ${CAMPAIGN}\n`);

const summary = { withChecks: 0, withoutChecks: 0, withTrace: 0, withoutTrace: 0 };
const suspicious: string[] = [];

for (const h of rows) {
  const prefix = h.hypothesis_id.replace(/^H-/, "");

  // The evaluation record: the protected evaluator's own output.
  const ev = s.db.prepare(
    `SELECT e.result_json, e.primary_value, e.baseline_value
     FROM evaluations e
     JOIN attempts a ON a.attempt_id = e.attempt_id
     JOIN runs r ON r.run_id = a.run_id
     WHERE r.hypothesis_id = ? ORDER BY e.accepted_at DESC LIMIT 1`,
  ).get(h.hypothesis_id) as any;

  // The judge's own recorded verdict.
  const judged = s.db.prepare(
    `SELECT payload_json FROM events
     WHERE campaign_id = ? AND event_type = 'claim.judged' AND aggregate_id = ?
     ORDER BY seq DESC LIMIT 1`,
  ).get(CAMPAIGN, h.hypothesis_id) as any;

  // Any agent trace sealed for this cycle.
  const traces = s.db.prepare(
    `SELECT a.relative_path, a.byte_length FROM artifacts a
     JOIN attempts at ON at.attempt_id = a.attempt_id
     JOIN runs r ON r.run_id = at.run_id
     WHERE a.campaign_id = ? AND a.kind = 'agent-trace'
       AND (r.hypothesis_id = ? OR r.idempotency_key LIKE ?)`,
  ).all(CAMPAIGN, h.hypothesis_id, `manager:${prefix}%`) as any[];

  let verdict = "(no claim.judged event)";
  let reasons: string[] = [];
  try {
    const p = JSON.parse(judged?.payload_json ?? "{}");
    verdict = p.explanation ?? p.status ?? verdict;
    reasons = p.reasons ?? [];
  } catch { /* leave default */ }

  let checks: any[] = [];
  let evalOk: unknown = "n/a";
  try {
    const raw = JSON.parse(ev?.result_json ?? "{}");
    checks = raw.checks ?? [];
    evalOk = raw.correct ?? raw.ok ?? "n/a";
  } catch { /* none */ }

  const failed = checks.filter((c: any) => !c.passed);
  if (checks.length) summary.withChecks++; else summary.withoutChecks++;
  const traceBytes = traces.reduce((n, t) => n + Number(t.byte_length || 0), 0);
  if (traceBytes > 0) summary.withTrace++; else summary.withoutTrace++;

  console.log("=".repeat(78));
  console.log(`${h.hypothesis_id}  [${h.lane}]  ${h.status}`);
  console.log(`  ${h.title}`);
  console.log(`  verdict : ${String(verdict).slice(0, 150)}`);
  if (reasons.length) console.log(`  reasons : ${reasons.join(", ")}`);
  console.log(`  measured: ${ev?.primary_value ?? "—"}   baseline: ${ev?.baseline_value ?? "—"}`);
  console.log(`  checks  : ${checks.length} recorded, ${failed.length} failed`);
  for (const c of failed) {
    console.log(`      FAIL ${c.id} [${c.class}] ${String(c.detail).replace(/\s+/g, " ").slice(0, 130)}`);
  }
  console.log(`  trace   : ${traces.length} artifact(s), ${traceBytes} bytes`);

  // What makes a rejection unauditable.
  const problems: string[] = [];
  if (!ev) problems.push("no evaluation record");
  if (checks.length === 0 && h.status !== "refuted") problems.push("no checks recorded");
  if (traceBytes === 0) problems.push("no agent trace");
  if (h.status === "implementation_invalid" && failed.length === 0 && checks.length > 0) {
    problems.push("marked invalid but every recorded check passed");
  }
  if (h.status === "refuted" && ev?.primary_value == null) {
    problems.push("refuted without a measured value");
  }
  if (problems.length) {
    console.log(`  ⚠ UNAUDITABLE: ${problems.join("; ")}`);
    suspicious.push(`${h.hypothesis_id} (${h.status}): ${problems.join("; ")}`);
  }
}

console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log(`  ${rows.length} rejected claims`);
console.log(`  evaluator checks recorded : ${summary.withChecks}   missing: ${summary.withoutChecks}`);
console.log(`  agent trace sealed        : ${summary.withTrace}   missing: ${summary.withoutTrace}`);
console.log(`  flagged unauditable       : ${suspicious.length}`);
for (const x of suspicious) console.log(`     - ${x}`);
s.close();
