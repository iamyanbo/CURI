/**
 * Does this domain actually work, and do its defences actually fire?
 *
 * A domain is ~20 config fields, a candidate, an evaluator and a set of planted
 * cheats. Nothing checked any of it against reality until a campaign spent real
 * cycles finding out. That produced two failures in one afternoon: a config
 * declaring `out/positions.parquet` while the candidate wrote `positions.npy`
 * (which would have failed every cycle), and cheat fixtures written for a
 * pandas contract against a numpy candidate (which reported "does not apply"
 * and passed by testing nothing).
 *
 * This runs the whole contract mechanically and returns plain-language failures.
 * It is also the gate a generated domain must pass before it may start a
 * campaign - which is what makes a setup agent safe to trust with the evaluator.
 * An agent that writes a lazy evaluator finds its own planted cheats escaping,
 * and gets those failures handed back to fix.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Harness } from "./core/harness.js";
import { createGenericAdapter, loadDomainConfig, type DomainConfig } from "./domain/generic-adapter.js";
import { judge } from "./loop/judge.js";
import { floorFrom } from "./loop/calibrate.js";

export interface DoctorReport {
  ok: boolean;
  failures: string[];
  warnings: string[];
  baseline: number | null;
  noiseFloor: number | null;
  caught: Array<{ id: string; caught: boolean; by: string[]; expected: string[] }>;
}

/**
 * Cheat categories every domain must plant at least one of.
 *
 * These are domain-INDEPENDENT ways to fake a result, so requiring them costs
 * an author nothing in generality and closes the one hole in letting an agent
 * write its own tests: an agent could otherwise pair a weak evaluator with weak
 * cheats and pass. It cannot skip a category it was told to cover.
 */
export const REQUIRED_CHEAT_KINDS = [
  "do_nothing",      // change nothing, or produce the baseline's own output
  "peek",            // reach for held-back data, the future, or the evaluator
  "partial_work",    // do a fraction of the work, report the whole
] as const;

export async function runDoctor(
  domainPath: string,
  opts: { projectRoot?: string; log?: (l: string) => void } = {},
): Promise<DoctorReport> {
  const root = opts.projectRoot ?? process.cwd();
  const log = opts.log ?? ((l: string) => console.log(l));
  const failures: string[] = [];
  const warnings: string[] = [];
  const caught: DoctorReport["caught"] = [];

  // -- 1. does the config even load? --------------------------------------
  let cfg: DomainConfig;
  try {
    cfg = loadDomainConfig(domainPath);
  } catch (err) {
    return { ok: false, failures: [`the domain config did not load: ${String(err)}`],
             warnings, baseline: null, noiseFloor: null, caught };
  }
  log(`domain ${cfg.id} · metric ${cfg.metric.name} (${cfg.metric.direction})`);

  // -- 2. do the files it names exist? ------------------------------------
  for (const f of cfg.seedFiles ?? []) {
    if (!existsSync(join(root, f.from))) failures.push(`seed file missing: ${f.from}`);
  }
  const evalScript = cfg.evaluatorCommand[cfg.evaluatorCommand.length - 1];
  if (evalScript && evalScript.includes("/") && !existsSync(join(root, evalScript))) {
    failures.push(`evaluator script missing: ${evalScript}`);
  }
  for (const p of cfg.protectedPaths) {
    if (!existsSync(join(root, p))) warnings.push(`protected path does not exist yet: ${p}`);
  }
  if (failures.length) {
    return { ok: false, failures, warnings, baseline: null, noiseFloor: null, caught };
  }

  // -- 3. required cheat categories ---------------------------------------
  const kinds = new Set((cfg.cheats ?? []).map((c) => String((c as any).kind ?? "")));
  for (const need of REQUIRED_CHEAT_KINDS) {
    if (!kinds.has(need)) {
      failures.push(
        `no cheat fixture of kind "${need}". Every domain must plant one: these are the `
        + "domain-independent ways to fake a result, and a defence that has never been shown "
        + "to fire is indistinguishable from one with nothing to catch.");
    }
  }

  // -- 4. run the real thing in a sandbox ---------------------------------
  const adapter = createGenericAdapter(root, cfg);
  const sandbox = mkdtempSync(join(tmpdir(), "ar-doctor-"));
  const h = new Harness(root, adapter, {
    repoDir: join(sandbox, "repo"), worktreeRoot: join(sandbox, "wt"),
  });

  let baseline: number | null = null;
  let noiseFloor: number | null = null;

  try {
    const base = h.ensureRepo();

    // 4a. the baseline must run and be measurable.
    const wt = h.worktree("doctor-baseline", base);
    const exp = h.run(wt, sandbox, 15 * 60_000);
    if (!exp.ok) {
      failures.push(
        `the baseline candidate did not run: ${exp.failureCode}. `
        + `runCommand is \`${cfg.runCommand.join(" ")}\`; stderr: ${(exp.stderr ?? "").slice(-300)}`);
    } else if (!exp.outputPath) {
      failures.push(
        `the baseline ran but produced no \`${cfg.outputPath}\`. `
        + "Either the candidate writes somewhere else or outputPath is wrong - "
        + "this mismatch fails every cycle, including the baseline.");
    } else {
      const ev = h.evaluate({
        worktree: wt, outputPath: exp.outputPath, stagingDir: sandbox,
        baselinePrimary: 0, baselineSecondary: null, supportDelta: 0, timeoutMs: 15 * 60_000,
      });
      if (!ev.ok) {
        failures.push(`the evaluator failed on an untouched baseline: ${ev.failureCode}`);
      } else if (typeof ev.primary !== "number" || !Number.isFinite(ev.primary)) {
        failures.push("the evaluator returned no numeric `primary` for the baseline");
      } else {
        baseline = ev.primary;
        log(`  baseline ${cfg.metric.name} = ${baseline.toFixed(6)}`);
      }
      if (ev.ok && (ev.checks ?? []).length === 0) {
        failures.push(
          "the evaluator recorded no checks. A metric with no integrity checks cannot "
          + "distinguish a result from a fabrication.");
      }
      const failedOnBaseline = (ev.checks ?? []).filter((c) => !c.passed);
      for (const c of failedOnBaseline) {
        failures.push(`check "${c.id}" FAILS on the untouched baseline: ${c.detail.slice(0, 160)}`);
      }
    }
    h.discard(wt);

    // 4b. noise floor, measured across the domain's own replication axis.
    if (baseline !== null) {
      const samples: number[] = [];
      for (const v of h.reproductionVariants()) {
        const built = h.reproduce(`doctor-${v.label}`, base, "", v.configPatch);
        if (!built.worktree) continue;
        const e = h.run(built.worktree, sandbox, 15 * 60_000);
        if (e.ok && e.outputPath) {
          const r = h.evaluate({
            worktree: built.worktree, outputPath: e.outputPath, stagingDir: sandbox,
            baselinePrimary: 0, baselineSecondary: null, supportDelta: 0, timeoutMs: 15 * 60_000,
          });
          if (r.ok && typeof r.primary === "number" && Number.isFinite(r.primary)) samples.push(r.primary);
        }
        h.discard(built.worktree);
      }
      if (samples.length >= 2) {
        noiseFloor = floorFrom(samples).noiseFloor;
        log(`  noise floor ${noiseFloor.toFixed(6)} (from ${samples.length} variants)`);
        if (!(noiseFloor > 0)) {
          warnings.push(
            "variants produced identical values, so no noise floor could be measured. "
            + "Threshold validation will fall back to the declared value.");
        }
      } else {
        warnings.push(`only ${samples.length} replication variant(s) produced a value`);
      }
    }

    // 4c. THE POINT: does every planted cheat get caught, by its own gate?
    const protectedBefore = h.protectedHash();
    const delta = noiseFloor && noiseFloor > 0 ? noiseFloor : (cfg.metric.noiseFloor || 1);

    for (const cheat of adapter.cheatFixtures()) {
      const cwt = h.worktree(`doctor-cheat-${cheat.id}`, base);
      const files: Record<string, string> = {};
      for (const f of adapter.candidateFiles) {
        try { files[f] = readFileSync(join(cwt, f), "utf8"); } catch { /* absent */ }
      }
      const mutated = cheat.apply(files);
      if (mutated === null) {
        failures.push(
          `cheat "${cheat.id}" could not be applied - its insertAfter anchor matches no line in `
          + `${(cheat as any).file ?? "its target file"}. A fixture that cannot apply reports `
          + "success while testing nothing.");
        caught.push({ id: cheat.id, caught: false, by: [], expected: cheat.expectedChecks ?? [] });
        h.discard(cwt);
        continue;
      }
      const { writeFileSync } = await import("node:fs");
      for (const [name, content] of Object.entries(mutated)) {
        if (content !== files[name]) writeFileSync(join(cwt, name), content, "utf8");
      }

      const cls = h.classify(cwt);
      const cexp = h.run(cwt, sandbox, 15 * 60_000);
      const cev = cexp.ok && cexp.outputPath
        ? h.evaluate({
            worktree: cwt, outputPath: cexp.outputPath, stagingDir: sandbox,
            baselinePrimary: baseline ?? 0, baselineSecondary: null,
            supportDelta: delta, timeoutMs: 15 * 60_000,
          })
        : { ok: false, primary: null, secondary: null, durationMs: 0, raw: null,
            checks: [{ id: "experiment_produced_output", class: "integrity" as const,
                       passed: false, detail: "no output" }] };

      const failed = (cev.checks ?? []).filter((c) => !c.passed);
      const verdict = judge({
        thresholds: { supportDelta: delta, refuteDelta: delta, direction: cfg.metric.direction },
        contractRegisteredAtMs: Date.now() - 60_000, resultObservedAtMs: Date.now(),
        experimentOk: cexp.ok, experimentFailureCode: cexp.failureCode,
        evaluationOk: cev.ok, primaryValue: cev.primary, baselineValue: baseline ?? 0,
        allChecksPassed: cev.ok && failed.length === 0,
        failedChecks: failed.map((c) => c.id),
        failedCheckClasses: failed.map((c) => c.class),
        protectedHashBefore: protectedBefore, protectedHashAfter: h.protectedHash(),
        touchedProtected: cls.touchedProtected,
        undeclaredConfigKeys: cls.undeclaredConfigKeys,
        overridesSeed: cls.escapedReproductionPolicy,
        malformedConfig: cls.malformedConfig,
        laneExpectsChange: true,
      });

      const okVerdict = cheat.acceptableVerdicts.includes(verdict.status);
      const failedIds = failed.map((c) => c.id);
      const wrongGate = (cheat.expectedChecks ?? []).filter((id) => !failedIds.includes(id));
      const isCaught = okVerdict && wrongGate.length === 0;

      caught.push({ id: cheat.id, caught: isCaught, by: failedIds.concat(verdict.reasons),
                    expected: cheat.expectedChecks ?? [] });
      log(`  cheat ${cheat.id.padEnd(22)} ${isCaught ? "caught" : "ESCAPED"} · ${verdict.status}`);

      if (!okVerdict) {
        failures.push(
          `cheat "${cheat.id}" ESCAPED: the harness returned "${verdict.status}", which is not in `
          + `${JSON.stringify(cheat.acceptableVerdicts)}. Target was: ${cheat.targets}. `
          + "The evaluator needs a check that catches this.");
      } else if (wrongGate.length > 0) {
        failures.push(
          `cheat "${cheat.id}" was stopped by ${failedIds.join(", ") || "an unrelated gate"} `
          + `instead of ${wrongGate.join(", ")}. It is not testing the defence it claims to test.`);
      }
      h.discard(cwt);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  return { ok: failures.length === 0, failures, warnings, baseline, noiseFloor, caught };
}
