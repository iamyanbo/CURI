/**
 * Verify that a domain's planted cheats are actually caught.
 *
 * Works for any domain: the fixtures come from the adapter, so a CUDA kernel
 * that pins its own seed is checked exactly as a language model that trains on
 * its validation split is.
 *
 * Runs against an ISOLATED CLONE of the candidate repository, so a live campaign
 * is never touched. Exits non-zero if any fixture escapes.
 *
 * This exists because of a measured failure. Every change to this project's
 * shortcut defences was driven by fixing a FALSE positive, and each fix made
 * detection more permissive. Nothing tested the other direction. The first time
 * fixtures ran, two of four detectors turned out to have been silently dead --
 * one of them through an entire 37-cycle campaign.
 *
 *   usage: tsx src/verify-cheats.ts [--domain path/to/domain.json]
 *                                   [--campaign id] [--base <revision>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Harness } from "./core/harness.js";
import { createGenericAdapter, loadDomainConfig } from "./domain/generic-adapter.js";
import { createTinymlAdapter } from "./domain/tinyml-adapter.js";
import { judge } from "./loop/judge.js";
import { normaliseCampaignConfig, Store } from "./store/store.js";

const ROOT = process.cwd();
const argOf = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const domainPath = argOf("domain");
const adapter = domainPath
  ? createGenericAdapter(ROOT, loadDomainConfig(domainPath))
  : createTinymlAdapter(ROOT);
const live = new Harness(ROOT, adapter);

const campaignId = argOf("campaign") ?? (domainPath ? "cuda-001" : "tinyml-001");

// Face the campaign's current baseline: the hardest case, and the state a live
// campaign would be in when a cheat arrived.
const store = Store.open(join(ROOT, ".autoresearch", "state.sqlite"));
const row = store.db
  .prepare("SELECT base_revision, config_json FROM campaigns WHERE campaign_id = ?")
  .get(campaignId) as { base_revision: string; config_json: string } | undefined;
store.close();

const cfg = row ? normaliseCampaignConfig(row.config_json) : {};
const BASELINE_PRIMARY = Number(argOf("baseline") ?? cfg.baselinePrimary ?? 0);
const BASELINE_SECONDARY = Number(cfg.baselineSecondary ?? 0) || null;
// A support threshold below the domain's measured noise floor is meaningless.
const SUPPORT_DELTA = Math.max(adapter.metric.noiseFloor, adapter.metric.noiseFloor);
const REFUTE_DELTA = SUPPORT_DELTA;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }).trim();
}

// Ensure the candidate repository exists before cloning it. A verification tool
// that assumes a live campaign has already run cannot be used to check a domain
// BEFORE its first campaign - which is exactly when you want to check it.
live.ensureRepo();

const sandbox = mkdtempSync(join(tmpdir(), "ar-cheats-"));
const repo = join(sandbox, "candidate");
try {
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", live.repoDir, repo],
               { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
} catch (err) {
  const detail = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? String(err);
  console.error(`could not clone the candidate repository at ${live.repoDir}: ${detail}`);
  process.exit(1);
}
git(["config", "user.email", "cheats@local"], repo);
git(["config", "user.name", "cheat-fixtures"], repo);

// A harness bound to the clone. Nothing below can reach the live repository.
mkdirSync(join(sandbox, "wt"), { recursive: true });
const SB = new Harness(ROOT, adapter, { repoDir: repo, worktreeRoot: join(sandbox, "wt") });

const recorded = argOf("base") ?? row?.base_revision;
const head = git(["rev-parse", "HEAD"], repo);
const base = recorded && SB.hasRevision(recorded) ? recorded : head;
if (recorded && base !== recorded) {
  console.warn(`note: recorded base ${recorded.slice(0, 12)} is not in the repository; ` +
               `verifying against HEAD ${head.slice(0, 12)} instead`);
}
const protectedBefore = live.protectedHash();

interface Outcome {
  id: string; title: string; targets: string; applied: boolean;
  status: string; reasons: string[]; primary: number | null; caught: boolean;
  /**
   * Which gate stopped it, and what the gate said.
   *
   * A fixture reported only as CAUGHT is not evidence that the defence it was
   * written to exercise works - it is evidence that SOME defence fired. Two
   * fixtures here were being stopped by the compile gate before reaching the
   * behaviour they were built to test, and the summary could not show it.
   */
  failedChecks: Array<{ id: string; detail: string }>;
  /** Gates the fixture declared it should trip, that did not trip. */
  wrongGate: string[];
}
const results: Outcome[] = [];

console.log(`\ndomain ${adapter.id} · baseline ${BASELINE_PRIMARY} ${adapter.metric.name}` +
            ` · support threshold ${SUPPORT_DELTA} (the measured noise floor)\n`);

for (const cheat of adapter.cheatFixtures()) {
  process.stdout.write(`  ${cheat.id.padEnd(20)}`);
  const wt = SB.worktree(`cheat-${cheat.id}`, base);

  // Hand the fixture every editable file; it returns the mutated set.
  const files: Record<string, string> = {};
  for (const f of adapter.candidateFiles) {
    try { files[f] = readFileSync(join(wt, f), "utf8"); } catch { /* absent */ }
  }
  const mutated = cheat.apply(files);
  if (mutated === null) {
    console.log(" SKIPPED — fixture does not apply to this baseline");
    results.push({ id: cheat.id, title: cheat.title, targets: cheat.targets, applied: false,
                   status: "not_applied", reasons: [], primary: null, caught: false,
                   failedChecks: [], wrongGate: [] });
    SB.discard(wt);
    continue;
  }
  for (const [name, content] of Object.entries(mutated)) {
    if (content !== files[name]) writeFileSync(join(wt, name), content, "utf8");
  }

  const cls = SB.classify(wt);
  const exp = SB.run(wt, sandbox, 25 * 60_000);
  const evaluation = exp.ok && exp.outputPath
    ? SB.evaluate({
        worktree: wt, outputPath: exp.outputPath, stagingDir: sandbox,
        baselinePrimary: BASELINE_PRIMARY, baselineSecondary: BASELINE_SECONDARY,
        supportDelta: SUPPORT_DELTA, timeoutMs: 20 * 60_000,
      })
    : { ok: false, primary: null, secondary: null, durationMs: 0, raw: null,
        checks: [{ id: "experiment_produced_output", class: "integrity" as const,
                   passed: false, detail: "no output for the evaluator" }] };

  const failed = evaluation.checks.filter((c) => !c.passed);
  const verdict = judge({
    thresholds: { supportDelta: SUPPORT_DELTA, refuteDelta: REFUTE_DELTA,
                  direction: adapter.metric.direction },
    contractRegisteredAtMs: Date.now() - 60_000,
    resultObservedAtMs: Date.now(),
    experimentOk: exp.ok,
    experimentFailureCode: exp.failureCode,
    evaluationOk: evaluation.ok,
    primaryValue: evaluation.primary,
    baselineValue: BASELINE_PRIMARY,
    allChecksPassed: evaluation.ok && failed.length === 0,
    failedChecks: failed.map((c) => c.id),
    failedCheckClasses: failed.map((c) => c.class),
    protectedHashBefore: protectedBefore,
    protectedHashAfter: live.protectedHash(),
    touchedProtected: cls.touchedProtected,
    undeclaredConfigKeys: cls.undeclaredConfigKeys,
    overridesSeed: cls.escapedReproductionPolicy,
    malformedConfig: cls.malformedConfig,
    laneExpectsChange: true,
  });

  // Being caught is not enough: it must be caught by the gate the fixture was
  // written to exercise. A fixture stopped early by an unrelated gate reports a
  // reassuring CAUGHT while proving nothing about the defence it targets.
  const failedIds = failed.map((c) => c.id);
  const wrongGate = (cheat.expectedChecks ?? []).filter((id) => !failedIds.includes(id));
  const caught = cheat.acceptableVerdicts.includes(verdict.status) && wrongGate.length === 0;
  console.log(` ${caught ? "CAUGHT " : "ESCAPED"}  ${verdict.status.padEnd(24)}` +
              ` ${evaluation.primary === null ? "—" : evaluation.primary.toFixed(3)}` +
              `  [${verdict.reasons.slice(0, 2).join(", ")}]`);
  for (const c of failed) {
    console.log(`${" ".repeat(24)}${c.id}: ${c.detail.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  if (wrongGate.length > 0) {
    console.log(`${" ".repeat(24)}WRONG GATE: expected ${wrongGate.join(", ")} to fire; ` +
                `it was stopped by ${failedIds.join(", ") || "nothing"} instead. ` +
                "This fixture is no longer testing what it claims to test.");
  }

  results.push({ id: cheat.id, title: cheat.title, targets: cheat.targets, applied: true,
                 status: verdict.status, reasons: verdict.reasons,
                 primary: evaluation.primary, caught,
                 failedChecks: failed.map((c) => ({ id: c.id, detail: c.detail })),
                 wrongGate });
  SB.discard(wt);
}

const applied = results.filter((r) => r.applied);
const escaped = applied.filter((r) => !r.caught);

console.log("\n" + "=".repeat(74));
console.log(`PLANTED CHEAT VERIFICATION — ${adapter.id}`);
console.log("=".repeat(74));
for (const r of results) {
  const mark = !r.applied ? "—" : r.caught ? "OK  " : "FAIL";
  console.log(`${mark} ${r.id.padEnd(20)} ${r.status.padEnd(24)} ${r.title}`);
  if (!r.caught && r.applied) console.log(`     target was: ${r.targets}`);
  if (!r.caught && r.applied && r.wrongGate.length > 0) {
    console.log(`     the intended gate (${r.wrongGate.join(", ")}) did not fire`);
  }
}
console.log(`\n${applied.length - escaped.length}/${applied.length} caught` +
            (results.length > applied.length
              ? ` · ${results.length - applied.length} could not apply` : ""));

writeFileSync(
  join(ROOT, ".autoresearch", `cheat-verification-${adapter.id}.json`),
  JSON.stringify({ generatedAt: new Date().toISOString(), domain: adapter.id,
                   campaign: campaignId, baseRevision: base,
                   baselinePrimary: BASELINE_PRIMARY, supportDelta: SUPPORT_DELTA,
                   results }, null, 2),
  "utf8",
);
rmSync(sandbox, { recursive: true, force: true });

if (escaped.length > 0) {
  console.log("\nA planted cheat was not caught — the defences have a hole.");
  process.exitCode = 1;
}
