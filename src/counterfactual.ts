/**
 * Counterfactual: does the harness decide better than a simpler loop?
 *
 * `plans/04` §7.3 asks for three arms at equal budget. Running three live
 * campaigns would confound the answer with model variance - different arms would
 * propose different ideas, and the comparison would measure luck as much as
 * policy. So this isolates the variable actually in question.
 *
 * Every arm sees the SAME evidence: the campaign's own replicated claims
 * (genuinely good work) plus the planted cheats (work that must be rejected).
 * Each candidate is trained and evaluated once. Three acceptance policies then
 * decide on identical inputs:
 *
 *   naive      keep/revert on the candidate's SELF-REPORTED number, as a
 *              Karpathy-style loop does: no contract, no independent
 *              measurement, no replication.
 *   no_checks  independent measurement against a registered threshold, but the
 *              integrity audits are skipped and nothing is replicated.
 *   full       the shipped harness: independent measurement, pre-registered
 *              threshold, integrity gates, multi-seed replication.
 *
 * Fairness detail that matters: the campaign advanced its baseline ten times, so
 * each replicated claim was written against a different revision and judged
 * against a different baseline. Each candidate is therefore rebuilt against the
 * revision it was actually written against and scored against the baseline it
 * actually faced. Cheats face the final baseline - the hardest case, and the
 * state a live campaign would be in when one arrived.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHEATS } from "./cheats.js";
import { Harness } from "./core/harness.js";
import { createTinymlAdapter } from "./domain/tinyml-adapter.js";
import { judge } from "./loop/judge.js";
import { Store } from "./store/store.js";

const ROOT = process.cwd();
const H = new Harness(ROOT, createTinymlAdapter(ROOT));
const live = { candidateRepo: H.repoDir, protectedRoot: H.domain.protectedPaths(ROOT)[0]! };
const SUPPORT_DELTA = 0.015;
const REFUTE_DELTA = 0.02;
const SEEDS = [7, 1234, 99991];
const ORIGIN_HOLDOUT = 2.956792890192936;

type Arm = "naive" | "no_checks" | "full";

interface Candidate {
  id: string;
  kind: "honest" | "cheat";
  title: string;
  source: string;
  baseRevision: string;
  baselineVal: number;
  baselineHoldout: number;
}

interface Evidence {
  id: string;
  kind: "honest" | "cheat";
  title: string;
  ran: boolean;
  selfReported: number | null;
  independentVal: number | null;
  holdout: number | null;
  baselineVal: number;
  checksPassed: boolean;
  failedChecks: string[];
  failedCheckClasses: string[];
  overridesSeed: boolean;
  touchedProtected: boolean;
  undeclaredKeys: string[];
  replicated: boolean;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }).trim();
}

function decide(arm: Arm, e: Evidence): boolean {
  if (arm === "naive") {
    // A keep/revert loop trusts whatever number the candidate printed.
    return e.ran && e.selfReported !== null && e.selfReported < e.baselineVal;
  }
  if (arm === "no_checks") {
    return e.ran && e.independentVal !== null
      && e.baselineVal - e.independentVal >= SUPPORT_DELTA;
  }
  const v = judge({
    thresholds: { supportDelta: SUPPORT_DELTA, refuteDelta: REFUTE_DELTA, direction: H.domain.metric.direction },
    contractRegisteredAtMs: 1, resultObservedAtMs: 2,
    experimentOk: e.ran, experimentFailureCode: undefined,
    evaluationOk: e.independentVal !== null,
    primaryValue: e.independentVal, baselineValue: e.baselineVal,
    allChecksPassed: e.checksPassed,
    failedChecks: e.failedChecks, failedCheckClasses: e.failedCheckClasses,
    protectedHashBefore: "h", protectedHashAfter: "h",
    touchedProtected: e.touchedProtected,
    undeclaredConfigKeys: e.undeclaredKeys,
    overridesSeed: e.overridesSeed,
    malformedConfig: false,
    laneExpectsChange: true,
  });
  return v.status === "provisionally_supported" && e.replicated;
}

// -- assemble candidates ----------------------------------------------------

const store = Store.open(join(ROOT, ".autoresearch", "state.sqlite"));
const campaign = store.db
  .prepare("SELECT config_json, base_revision FROM campaigns WHERE campaign_id='tinyml-001'")
  .get() as { config_json: string; base_revision: string };
const cfg = JSON.parse(campaign.config_json);
const FINAL_BASE = campaign.base_revision;
const FINAL_VAL = Number(cfg.baselinePrimary);
const FINAL_HOLDOUT = Number(cfg.baselineSecondary);

const honest = store.db.prepare(
  `SELECT h.hypothesis_id AS id, h.title AS title, ct.baseline_hash AS baseRevision,
          e.baseline_value AS baselineVal, e.result_json AS resultJson,
          a.relative_path AS diffPath
   FROM hypotheses h
   JOIN contracts ct ON ct.hypothesis_id = h.hypothesis_id
   JOIN evaluations e ON e.contract_id = ct.contract_id
   JOIN runs r ON r.hypothesis_id = h.hypothesis_id
   JOIN attempts at ON at.run_id = r.run_id
   JOIN artifacts a ON a.attempt_id = at.attempt_id AND a.kind = 'candidate-diff'
   WHERE h.status = 'replicated'
   GROUP BY h.hypothesis_id
   ORDER BY h.updated_at`,
).all() as Array<{ id: string; title: string; baseRevision: string; baselineVal: number;
                   resultJson: string; diffPath: string }>;
store.close();

const holdoutChain: number[] = [ORIGIN_HOLDOUT];
for (const h of honest) {
  const m = JSON.parse(h.resultJson)?.metrics?.holdout_bpc;
  holdoutChain.push(typeof m === "number" ? m : holdoutChain[holdoutChain.length - 1]!);
}

const sandbox = mkdtempSync(join(tmpdir(), "ar-cf-"));
const repo = join(sandbox, "candidate");
execFileSync("git", ["clone", "--quiet", "--no-hardlinks", live.candidateRepo, repo]);
git(["config", "user.email", "cf@local"], repo);
git(["config", "user.name", "cf"], repo);

// A harness bound to the sandboxed clone, so nothing here can touch the live
// candidate repository.
mkdirSync(join(sandbox, "wt"), { recursive: true });
const SB = new Harness(ROOT, createTinymlAdapter(ROOT),
                       { repoDir: repo, worktreeRoot: join(sandbox, "wt") });

const candidates: Candidate[] = [];

for (let i = 0; i < honest.length; i++) {
  const h = honest[i]!;
  const wt = join(sandbox, `mk-${h.id}`);
  try {
    git(["worktree", "add", "-q", "--detach", wt, h.baseRevision], repo);
    writeFileSync(join(wt, ".p.patch"),
      readFileSync(join(ROOT, ".autoresearch", "artifacts", h.diffPath), "utf8"), "utf8");
    execFileSync("git", ["apply", "--whitespace=nowarn", ".p.patch"], { cwd: wt, windowsHide: true });
    candidates.push({
      id: h.id, kind: "honest", title: h.title,
      source: readFileSync(join(wt, "train.py"), "utf8"),
      baseRevision: h.baseRevision,
      baselineVal: h.baselineVal,
      baselineHoldout: holdoutChain[i]!,
    });
  } catch (err) {
    console.log(`  (skipping ${h.id}: ${String(err).slice(0, 100)})`);
  } finally {
    try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, windowsHide: true }); } catch { /* gone */ }
  }
}

const finalWt = join(sandbox, "final");
git(["worktree", "add", "-q", "--detach", finalWt, FINAL_BASE], repo);
const finalSource = readFileSync(join(finalWt, "train.py"), "utf8");
try { execFileSync("git", ["worktree", "remove", "--force", finalWt], { cwd: repo, windowsHide: true }); } catch { /* gone */ }

for (const c of CHEATS) {
  const mutated = c.apply(finalSource);
  if (!mutated) { console.log(`  (cheat ${c.id} does not apply to the final baseline)`); continue; }
  candidates.push({
    id: c.id, kind: "cheat", title: c.title, source: mutated,
    baseRevision: FINAL_BASE, baselineVal: FINAL_VAL, baselineHoldout: FINAL_HOLDOUT,
  });
}

const honestCount = candidates.filter((c) => c.kind === "honest").length;
const cheatCount = candidates.filter((c) => c.kind === "cheat").length;
console.log(`\ncounterfactual: ${candidates.length} candidates (${honestCount} honest, ${cheatCount} cheats)`);
console.log("each rebuilt against its own base revision and scored against the baseline it faced\n");

// -- gather evidence once ---------------------------------------------------

const evidence: Evidence[] = [];

for (const cand of candidates) {
  const safe = cand.id.replace(/[^\w-]/g, "_");
  process.stdout.write(`  ${cand.kind.padEnd(6)} ${safe.slice(0, 20).padEnd(22)}`);
  const wt = join(SB.worktreeRoot, safe);
  git(["worktree", "add", "-q", "--detach", wt, cand.baseRevision], repo);
  writeFileSync(join(wt, "train.py"), cand.source, "utf8");

  const cls = SB.classify(wt);
  const exp = SB.run(wt, sandbox, 25 * 60_000);

  const e: Evidence = {
    id: cand.id, kind: cand.kind, title: cand.title,
    ran: exp.ok, selfReported: exp.selfReportedPrimary,
    independentVal: null, holdout: null, baselineVal: cand.baselineVal,
    checksPassed: false, failedChecks: ["experiment_failed"], failedCheckClasses: ["integrity"],
    overridesSeed: cls.escapedReproductionPolicy, touchedProtected: cls.touchedProtected,
    undeclaredKeys: cls.undeclaredConfigKeys, replicated: false,
  };

  if (exp.ok && exp.outputPath) {
    const ev = SB.evaluate({
        worktree: wt, outputPath: exp.outputPath!, stagingDir: sandbox,
        baselinePrimary: cand.baselineVal, baselineSecondary: cand.baselineHoldout,
        supportDelta: SUPPORT_DELTA, timeoutMs: 20 * 60_000,
      });
    e.independentVal = ev.primary;
    e.holdout = ev.secondary;
    e.checksPassed = ev.checks.every((c) => c.passed);
    e.failedChecks = ev.checks.filter((c) => !c.passed).map((c) => c.id);
    e.failedCheckClasses = ev.checks.filter((c) => !c.passed).map((c) => c.class);

    // Only replicate what an arm would actually pay to replicate.
    if (ev.primary !== null && cand.baselineVal - ev.primary >= SUPPORT_DELTA) {
      let survived = true;
      const seen: number[] = [];
      for (const seed of SEEDS) {
        const r = SB.reproduce(`${safe}-${seed}`, cand.baseRevision, cls.diffText, { seed });
        const rexp = r.worktree && !r.failure
          ? SB.run(r.worktree, sandbox, 25 * 60_000) : null;
        let ok = false;
        if (rexp?.ok && rexp.outputPath && r.worktree) {
          const rev = SB.evaluate({
            worktree: r.worktree, outputPath: rexp.outputPath!, stagingDir: sandbox,
            baselinePrimary: cand.baselineVal, baselineSecondary: cand.baselineHoldout,
            supportDelta: SUPPORT_DELTA, timeoutMs: 20 * 60_000,
          });
          if (rev.primary !== null) seen.push(rev.primary);
          ok = rev.ok && rev.checks.every((c) => c.passed) && rev.primary !== null
            && cand.baselineVal - rev.primary >= SUPPORT_DELTA;
        }
        if (r.worktree) SB.discard(r.worktree);
        if (!ok) survived = false;
      }
      // Identical numbers across distinct seeds prove the seed never reached training.
      if (seen.length > 1 && Math.max(...seen) - Math.min(...seen) < 1e-12) survived = false;
      e.replicated = survived;
    }
  }

  evidence.push(e);
  console.log(
    ` self ${e.selfReported?.toFixed(4) ?? "  n/a"}` +
    ` · indep ${e.independentVal?.toFixed(4) ?? "  n/a"}` +
    ` · hold ${e.holdout?.toFixed(4) ?? "  n/a"}` +
    ` · repl ${e.replicated ? "y" : "n"}`,
  );
  SB.discard(wt);
}

// -- apply the three policies ----------------------------------------------

const arms: Arm[] = ["naive", "no_checks", "full"];
const results = arms.map((arm) => {
  const acceptedHonest = evidence.filter((e) => e.kind === "honest" && decide(arm, e));
  const acceptedCheats = evidence.filter((e) => e.kind === "cheat" && decide(arm, e));
  return { arm, acceptedHonest, acceptedCheats };
});

console.log("\n" + "=".repeat(78));
console.log("COUNTERFACTUAL - identical evidence, three acceptance policies");
console.log("=".repeat(78));
console.log(`${"arm".padEnd(12)}${"honest kept".padEnd(15)}${"cheats admitted".padEnd(18)}verdict`);
for (const r of results) {
  const verdict = r.acceptedCheats.length > 0
    ? `ADMITS ${r.acceptedCheats.map((c) => c.id).join(", ")}`
    : r.acceptedHonest.length === honestCount ? "clean" : "clean, but rejects real work";
  console.log(
    `${r.arm.padEnd(12)}${`${r.acceptedHonest.length}/${honestCount}`.padEnd(15)}` +
    `${`${r.acceptedCheats.length}/${cheatCount}`.padEnd(18)}${verdict}`,
  );
}

writeFileSync(join(ROOT, ".autoresearch", "counterfactual.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    supportDelta: SUPPORT_DELTA, seeds: SEEDS,
    evidence,
    arms: results.map((r) => ({
      arm: r.arm,
      acceptedHonest: r.acceptedHonest.map((e) => e.id),
      acceptedCheats: r.acceptedCheats.map((e) => e.id),
    })),
  }, null, 2), "utf8");

rmSync(sandbox, { recursive: true, force: true });
console.log("\nwritten to .autoresearch/counterfactual.json");
