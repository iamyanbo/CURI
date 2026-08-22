/**
 * Judge tests.
 *
 * These encode the gate ORDER, not just the outcomes. The order is the point:
 * a candidate must never be able to buy its way past a failed integrity check
 * with a good number, so every integrity gate is asserted against an input that
 * also carries a winning metric.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { judge, type JudgeInput } from "../src/loop/judge.js";

const T0 = 1_700_000_000_000;

/** An honest, clearly-winning candidate. Each test spoils exactly one thing. */
function goodRun(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    thresholds: { supportDelta: 0.02, refuteDelta: 0.02, direction: "minimize" },
    contractRegisteredAtMs: T0,
    resultObservedAtMs: T0 + 60_000,
    experimentOk: true,
    experimentFailureCode: undefined,
    evaluationOk: true,
    primaryValue: 2.5,      // baseline 2.9 -> delta +0.4, far past the support bar
    baselineValue: 2.9,
    allChecksPassed: true,
    failedChecks: [],
    failedCheckClasses: [],
    protectedHashBefore: "hash-A",
    protectedHashAfter: "hash-A",
    touchedProtected: false,
    undeclaredConfigKeys: [],
    overridesSeed: false,
    laneExpectsChange: true,
    ...overrides,
  };
}

describe("judge: purity", () => {
  it("returns identical output for identical input", () => {
    const input = goodRun();
    const a = judge(input);
    const b = judge(structuredClone(input));
    assert.deepEqual(a, b);
  });

  it("does not mutate its input", () => {
    const input = goodRun();
    const snapshot = structuredClone(input);
    judge(input);
    assert.deepEqual(input, snapshot);
  });
});

describe("judge: the happy path still works", () => {
  it("supports a clean candidate that beats the registered threshold", () => {
    const v = judge(goodRun());
    assert.equal(v.status, "provisionally_supported");
    assert.equal(v.integrityFailed, false);
    assert.ok(v.delta !== null && v.delta > 0.02);
  });

  it("refutes a clear regression", () => {
    const v = judge(goodRun({ primaryValue: 3.2 }));
    assert.equal(v.status, "refuted");
  });

  it("calls a small change inconclusive rather than a win", () => {
    const v = judge(goodRun({ primaryValue: 2.895 }));
    assert.equal(v.status, "inconclusive");
    assert.deepEqual(v.reasons, ["WITHIN_NOISE_BAND"]);
  });

  it("handles a maximised metric symmetrically", () => {
    const v = judge(goodRun({
      thresholds: { supportDelta: 0.02, refuteDelta: 0.02, direction: "maximize" },
      primaryValue: 3.2, baselineValue: 2.9,
    }));
    assert.equal(v.status, "provisionally_supported");
  });
});

describe("judge: integrity gates beat a winning metric", () => {
  it("rejects a mutated protected tree", () => {
    const v = judge(goodRun({ protectedHashAfter: "hash-B" }));
    assert.equal(v.status, "shortcut_suspected");
    assert.ok(v.reasons.includes("PROTECTED_TREE_MUTATED"));
    assert.equal(v.integrityFailed, true);
  });

  it("rejects a diff that reaches into protected paths", () => {
    const v = judge(goodRun({ touchedProtected: true }));
    assert.equal(v.status, "shortcut_suspected");
    assert.ok(v.reasons.includes("DIFF_REACHED_PROTECTED_PATH"));
  });

  it("rejects a failed leakage check even with a great number", () => {
    const v = judge(goodRun({
      allChecksPassed: false,
      failedChecks: ["val_holdout_consistency"],
      failedCheckClasses: ["leakage"],
    }));
    assert.equal(v.status, "shortcut_suspected");
    assert.ok(v.reasons.includes("CHECK_FAILED_VAL_HOLDOUT_CONSISTENCY"));
  });

  it("rejects a contract registered after its own result", () => {
    const v = judge(goodRun({
      contractRegisteredAtMs: T0 + 120_000,
      resultObservedAtMs: T0 + 60_000,
    }));
    assert.equal(v.status, "implementation_invalid");
    assert.deepEqual(v.reasons, ["CONTRACT_REGISTERED_AFTER_RESULT"]);
  });

  it("rejects edits to config keys outside the declared surface", () => {
    const v = judge(goodRun({ undeclaredConfigKeys: ["eval_tokens"] }));
    assert.equal(v.status, "implementation_invalid");
    assert.ok(v.reasons.includes("UNDECLARED_CONFIG_KEYS"));
  });

  it("treats a missing metric as failure, never as zero", () => {
    const v = judge(goodRun({ primaryValue: null }));
    assert.equal(v.status, "implementation_invalid");
    assert.deepEqual(v.reasons, ["PRIMARY_METRIC_MISSING"]);
  });

  it("treats a non-finite metric as failure", () => {
    const v = judge(goodRun({ primaryValue: Number.NaN }));
    assert.equal(v.status, "implementation_invalid");
  });

  it("reports a broken experiment as invalid, not refuted", () => {
    const v = judge(goodRun({ experimentOk: false, experimentFailureCode: "PROCESS_EXIT_1" }));
    assert.equal(v.status, "implementation_invalid");
    assert.ok(v.reasons.includes("PROCESS_EXIT_1"));
  });
});

describe("judge: gate precedence", () => {
  it("reports tampering ahead of a failed run when both are true", () => {
    const v = judge(goodRun({ protectedHashAfter: "hash-B", experimentOk: false }));
    assert.equal(v.status, "shortcut_suspected", "integrity outranks execution failure");
  });

  it("reports a failed check ahead of the metric when both are decidable", () => {
    const v = judge(goodRun({
      allChecksPassed: false,
      failedChecks: ["val_holdout_consistency"],
      failedCheckClasses: ["leakage"],
      primaryValue: 0.9,   // spectacular, and irrelevant
    }));
    assert.equal(v.status, "shortcut_suspected");
    assert.equal(v.delta, null, "a failed integrity gate must not publish a delta");
  });
});

describe("judge: an unchanged metric means different things per lane", () => {
  // From calibration: three cycles returned a metric bitwise-identical to the
  // baseline. Two were control experiments behaving correctly; one was an
  // exploit cycle whose intervention never took effect. Reporting both as
  // "inconclusive" implied a small effect where there had been no experiment.
  // Updated deliberately. This previously asserted `implementation_invalid`,
  // and auditing a real campaign showed that label was wrong: six candidates
  // built, ran and measured cleanly, and were filed as broken because the
  // metric did not move. A change that has no effect is a NULL RESULT and is
  // worth keeping - and because invalids feed the consecutive-failure stop
  // condition, mislabelling them could halt a healthy campaign.
  //
  // The distinguishing information is preserved in the reason code: the metric
  // did not move at all, which is a stronger statement than moving less than
  // the threshold.
  it("records an exactly unchanged result outside control as a retained null result", () => {
    const v = judge(goodRun({ primaryValue: 2.9, baselineValue: 2.9, laneExpectsChange: true }));
    assert.equal(v.status, "inconclusive", "a valid experiment that moved nothing is not broken");
    assert.deepEqual(v.reasons, ["INTERVENTION_HAD_NO_EFFECT"],
      "the reason must still distinguish 'no effect' from 'below threshold'");
    assert.ok(/null result/.test(v.explanation));
  });

  it("treats an exactly unchanged result in a control lane as the control passing", () => {
    const v = judge(goodRun({ primaryValue: 2.9, baselineValue: 2.9, laneExpectsChange: false }));
    assert.equal(v.status, "tested");
    assert.deepEqual(v.reasons, ["CONTROL_CONFIRMED"]);
  });

  it("still calls a genuinely small change inconclusive", () => {
    const v = judge(goodRun({ primaryValue: 2.8995, baselineValue: 2.9, laneExpectsChange: true }));
    assert.equal(v.status, "inconclusive");
  });
});

describe("judge: seed policy", () => {
  // A candidate that hardcoded cfg["seed"]=12345 made three replication seeds
  // return the identical value — the same run three times, scored as three
  // independent confirmations, and promoted. Replication that cannot detect
  // its own failure is replication theatre.
  it("rejects a candidate that hardcodes the seed, however good the number", () => {
    const v = judge(goodRun({ overridesSeed: true, primaryValue: 1.0 }));
    assert.equal(v.status, "implementation_invalid");
    assert.deepEqual(v.reasons, ["SEED_POLICY_VIOLATED"]);
    assert.equal(v.delta, null, "an unreplicable result must not publish a delta");
  });

  it("leaves an honest candidate alone", () => {
    assert.equal(judge(goodRun({ overridesSeed: false })).status, "provisionally_supported");
  });
});

describe("judge: a broken candidate is not an accusation", () => {
  // Regression guard for a real false positive. An EMA candidate evaluated the
  // averaged weights, then restored and SAVED the un-averaged ones. The
  // evaluator saw a self-report mismatch, which the judge originally called
  // `shortcut_suspected`. That is a candidate bug, not evasion, and mislabelling
  // it would put a fabricated cheating accusation into the evidence record.
  it("calls an integrity-class failure implementation_invalid, not a shortcut", () => {
    const v = judge(goodRun({
      allChecksPassed: false,
      failedChecks: ["self_report_agreement"],
      failedCheckClasses: ["integrity"],
    }));
    assert.equal(v.status, "implementation_invalid");
    assert.equal(v.integrityFailed, false, "a bug must not be recorded as evasion");
    assert.ok(/artifact does not match/.test(v.explanation));
  });

  it("still reports evasion when any failed check is shortcut- or leakage-class", () => {
    const v = judge(goodRun({
      allChecksPassed: false,
      failedChecks: ["self_report_agreement", "canary_touched"],
      failedCheckClasses: ["integrity", "shortcut"],
    }));
    assert.equal(v.status, "shortcut_suspected");
    assert.equal(v.integrityFailed, true);
  });

  it("keeps protected-tree tampering as evasion regardless of check classes", () => {
    const v = judge(goodRun({
      protectedHashAfter: "hash-B",
      allChecksPassed: false,
      failedChecks: ["self_report_agreement"],
      failedCheckClasses: ["integrity"],
    }));
    assert.equal(v.status, "shortcut_suspected");
  });
});

describe("judge: operator evaluator changes", () => {
  // Live incident: an operator recalibrated the leakage floor while a cycle was
  // running. The protected-tree hash moved, and an innocent candidate whose diff
  // never referenced protected material was reported for evasion.
  it("voids a cycle when the operator changed the evaluator, without accusing", () => {
    const v = judge(goodRun({
      protectedHashAfter: "hash-B",
      protectedChangeAuthorised: true,
    }));
    assert.equal(v.status, "implementation_invalid");
    assert.deepEqual(v.reasons, ["EVALUATOR_CHANGED_BY_OPERATOR"]);
    assert.equal(v.integrityFailed, false, "an operator repair is not evasion");
    assert.ok(/candidate did nothing wrong/.test(v.explanation));
  });

  it("still reports an unexplained protected-tree change as evasion", () => {
    const v = judge(goodRun({ protectedHashAfter: "hash-B" }));
    assert.equal(v.status, "shortcut_suspected");
    assert.ok(v.reasons.includes("PROTECTED_TREE_MUTATED"));
    assert.equal(v.integrityFailed, true);
  });

  it("does NOT let an operator change launder a candidate that reached for protected paths", () => {
    // This test previously asserted the bug: the authorised-change branch
    // returned before `touchedProtected` was examined, so a genuine attack
    // landing in the same cycle as an operator edit would be excused.
    const v = judge(goodRun({
      protectedHashAfter: "hash-B",
      protectedChangeAuthorised: true,
      touchedProtected: true,
    }));
    assert.equal(v.status, "shortcut_suspected");
    assert.deepEqual(v.reasons, ["DIFF_REACHED_PROTECTED_PATH"]);
    assert.equal(v.integrityFailed, true);
  });
});
