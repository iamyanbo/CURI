/**
 * The judge.
 *
 * A pure function from (registered contract, observed facts) to a claim status.
 * No model call, no I/O, no clock. Given identical inputs it returns identical
 * output, which is what makes invariant 2 — "the actor cannot be the final
 * judge" — mechanical rather than aspirational.
 *
 * The order of the gates matters. Integrity failures are checked before the
 * metric, so a candidate can never buy its way past a failed check with a good
 * number. There is deliberately no path that averages away a failed hard gate.
 */

export type ClaimStatus =
  | "tested" | "provisionally_supported" | "replicated" | "externally_validated"
  | "refuted" | "inconclusive" | "implementation_invalid" | "shortcut_suspected";

export interface RegisteredThresholds {
  /** Improvement over baseline required to count as support (metric units). */
  supportDelta: number;
  /** Regression beyond this counts as refutation rather than noise. */
  refuteDelta: number;
  /** Metric direction. */
  direction: "minimize" | "maximize";
}

export interface JudgeInput {
  thresholds: RegisteredThresholds;
  contractRegisteredAtMs: number;
  /** When the first result for this contract became observable. */
  resultObservedAtMs: number;

  experimentOk: boolean;
  experimentFailureCode?: string | undefined;

  evaluationOk: boolean;
  primaryValue: number | null;
  baselineValue: number | null;

  allChecksPassed: boolean;
  failedChecks: string[];
  /** Class of each failed check, parallel to `failedChecks`. */
  failedCheckClasses?: string[];

  /** Protected tree hash before and after the whole attempt. */
  protectedHashBefore: string;
  protectedHashAfter: string;
  /**
   * True when the post-attempt protected hash matches an operator change that
   * was recorded and authorised. The result is still void - it was measured
   * while the evaluator moved underneath it - but it is not evidence of evasion.
   */
  protectedChangeAuthorised?: boolean;

  /** Did the diff reach for protected paths? */
  touchedProtected: boolean;
  /** Config keys edited that were not in the declared parameter surface. */
  undeclaredConfigKeys: string[];
  /** The candidate's config could not be parsed at all. */
  malformedConfig?: boolean;
  /** The candidate hardcodes a seed, escaping the contract's seed policy. */
  overridesSeed?: boolean;

  /**
   * Whether this lane's experiment is supposed to move the metric.
   *
   * A control cycle (a sanity check, a reload test, a negative control) is
   * SUPPOSED to leave the model untouched, and an unchanged metric is the
   * control passing. Any other lane producing a bitwise-identical result means
   * the intervention never took effect, which is a broken experiment rather
   * than a small one.
   */
  laneExpectsChange: boolean;
}

export interface JudgeVerdict {
  status: ClaimStatus;
  /** Machine-readable reason codes, most significant first. */
  reasons: string[];
  /** One line suitable for a trace or the claim card. */
  explanation: string;
  delta: number | null;
  /** True when a hard integrity gate failed, regardless of the metric. */
  integrityFailed: boolean;
}

export function judge(input: JudgeInput): JudgeVerdict {
  const reasons: string[] = [];

  // --- Gate 0: pre-registration ordering ----------------------------------
  // A contract registered after its own result is not a pre-registration.
  if (input.contractRegisteredAtMs > input.resultObservedAtMs) {
    return verdict("implementation_invalid", ["CONTRACT_REGISTERED_AFTER_RESULT"], null, true,
      "contract was registered after the result was observable, so its rule is not pre-registered");
  }

  // --- Gate 1: evaluator integrity ----------------------------------------
  //
  // The candidate's OWN behaviour is judged first and unconditionally. A diff
  // that reaches for protected paths is evasion regardless of what the operator
  // was doing at the time - otherwise an operator edit would launder a genuine
  // attack that happened to land in the same cycle.
  if (input.touchedProtected) {
    return verdict("shortcut_suspected", ["DIFF_REACHED_PROTECTED_PATH"], null, true,
      "the candidate's diff reached into protected evaluation material");
  }

  if (input.protectedHashBefore !== input.protectedHashAfter) {
    // An operator editing the evaluator mid-campaign must invalidate the
    // in-flight cycle - `plans/01` §6.1 requires exactly that - but it is a
    // repair, not an attack. Observed live: an operator recalibrated the
    // leakage floor while a cycle ran and an innocent candidate was accused.
    if (input.protectedChangeAuthorised) {
      return verdict("implementation_invalid", ["EVALUATOR_CHANGED_BY_OPERATOR"], null, false,
        "the protected evaluator was changed by a recorded operator action while this cycle was in flight, so the measurement is void - the candidate did nothing wrong");
    }
    return verdict("shortcut_suspected", ["PROTECTED_TREE_MUTATED"], null, true,
      "protected evaluation material changed during the attempt and no operator change was recorded");
  }

  // --- Gate 2: did the experiment even run? -------------------------------
  if (!input.experimentOk) {
    return verdict("implementation_invalid",
      [input.experimentFailureCode ?? "EXPERIMENT_FAILED"], null, false,
      `the experiment did not produce a usable artifact (${input.experimentFailureCode ?? "unknown"})`);
  }
  if (!input.evaluationOk) {
    return verdict("implementation_invalid", ["EVALUATION_DID_NOT_COMPLETE"], null, false,
      "the protected evaluator did not complete");
  }

  // --- Gate 3: evaluator checks -------------------------------------------
  // Checked before the metric on purpose: a passing number is provisional until
  // the audit clears. The CLASS of the failure decides the status, because
  // "this candidate cheated" and "this candidate is broken" are different
  // findings and conflating them corrupts the evidence record.
  if (!input.allChecksPassed) {
    const classes = input.failedCheckClasses ?? [];
    const evasive = classes.some((c) => c === "shortcut" || c === "leakage");
    const reasons = input.failedChecks.map(toReason);
    if (evasive) {
      return verdict("shortcut_suspected", reasons, null, true,
        `failed evaluator check(s) indicating evasion: ${input.failedChecks.join(", ")}`);
    }
    return verdict("implementation_invalid", reasons, null, false,
      `failed integrity check(s): ${input.failedChecks.join(", ")} — the artifact does not match the candidate's own report, so the intervention was not actually measured`);
  }

  // --- Gate 3b: seed policy -----------------------------------------------
  // A hardcoded seed escapes the registered seed policy and silently voids
  // replication, which varies seeds through config.json. The result may be
  // perfectly good science, but it cannot be independently confirmed, so it
  // must not be promotable.
  if (input.overridesSeed) {
    return verdict("implementation_invalid", ["SEED_POLICY_VIOLATED"], null, false,
      "the candidate sets the seed in code, escaping the registered seed policy and making replication meaningless");
  }

  // --- Gate 3c: the candidate's config must be readable --------------------
  if (input.malformedConfig) {
    return verdict("implementation_invalid", ["CONFIG_UNPARSEABLE"], null, false,
      "the candidate's configuration file could not be parsed, so nothing about the run can be trusted");
  }

  // --- Gate 4: undeclared config surface ----------------------------------
  if (input.undeclaredConfigKeys.length > 0) {
    return verdict("implementation_invalid",
      ["UNDECLARED_CONFIG_KEYS", ...input.undeclaredConfigKeys], null, false,
      `edited config keys outside the declared surface: ${input.undeclaredConfigKeys.join(", ")}`);
  }

  // --- Gate 5: the metric -------------------------------------------------
  if (input.primaryValue === null || !Number.isFinite(input.primaryValue)) {
    return verdict("implementation_invalid", ["PRIMARY_METRIC_MISSING"], null, false,
      "no finite primary metric was produced; a missing metric is a failure, not a zero");
  }
  if (input.baselineValue === null || !Number.isFinite(input.baselineValue)) {
    return verdict("inconclusive", ["NO_BASELINE"], null, false,
      "no baseline was available to compare against");
  }

  // Positive delta always means "better", whichever way the metric points.
  const delta = input.thresholds.direction === "minimize"
    ? input.baselineValue - input.primaryValue
    : input.primaryValue - input.baselineValue;

  // An exactly-unchanged metric is not a small effect; it means the model is
  // bitwise identical to the baseline. What that implies depends on the lane.
  const unchanged = Math.abs(delta) < 1e-9;
  if (unchanged) {
    if (!input.laneExpectsChange) {
      return verdict("tested", ["CONTROL_CONFIRMED"], delta, false,
        "the control left the metric exactly unchanged, which is the expected outcome; the measurement path is behaving");
    }
    // A null result, not a broken candidate.
    //
    // `implementation_invalid` says the experiment could not be run. That is
    // not what happened here: the candidate built, ran, and measured cleanly -
    // the change simply moved nothing. "Evict-first cache hints do not help
    // this kernel" is a finding, and filing it as invalid threw it away as a
    // failed experiment. Six of this campaign's rejections were null results
    // mislabelled this way, and because invalids feed the consecutive-failure
    // stop condition, a run of honest null results could halt a healthy
    // campaign as though the harness were broken.
    //
    // The reason code stays `INTERVENTION_HAD_NO_EFFECT`, so the stronger
    // statement - the metric did not move AT ALL, rather than moving less than
    // the threshold - is still recoverable from the evidence.
    return verdict("inconclusive", ["INTERVENTION_HAD_NO_EFFECT"], delta, false,
      "the candidate measured identically to the baseline, so the change had no effect on this "
      + "benchmark. That is a null result and is retained as one: the implementation was valid, "
      + "it ran, and the intervention did not move the metric. Note this device's timer is "
      + "quantised, so an identical reading can also mean the effect was below the instrument's "
      + "resolution rather than exactly zero.");
  }

  if (delta >= input.thresholds.supportDelta) {
    return verdict("provisionally_supported", ["MET_SUPPORT_THRESHOLD"], delta, false,
      `improved by ${delta.toFixed(6)} against a registered threshold of ${input.thresholds.supportDelta}`);
  }
  if (delta <= -input.thresholds.refuteDelta) {
    return verdict("refuted", ["MET_REFUTATION_THRESHOLD"], delta, false,
      `regressed by ${(-delta).toFixed(6)}, beyond the registered refutation threshold of ${input.thresholds.refuteDelta}`);
  }
  return verdict("inconclusive", ["WITHIN_NOISE_BAND"], delta, false,
    `change of ${delta.toFixed(6)} did not reach the registered support or refutation threshold`);
}

function toReason(checkId: string): string {
  return `CHECK_FAILED_${checkId.toUpperCase()}`;
}

function verdict(
  status: ClaimStatus,
  reasons: string[],
  delta: number | null,
  integrityFailed: boolean,
  explanation: string,
): JudgeVerdict {
  return { status, reasons, delta, integrityFailed, explanation };
}
