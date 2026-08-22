/**
 * The domain interface.
 *
 * Everything epistemic is general and lives in the core: propose a hypothesis
 * with a mechanism and a falsifier, freeze the threshold before running, do the
 * work in isolation, measure it with something the worker cannot reach, repeat
 * it, keep the negative results, and let a pure function decide.
 *
 * A domain supplies only what the core cannot know:
 *
 *   1. how to run one experiment
 *   2. how to measure it, using code and data the experimenter cannot touch
 *   3. how to REPRODUCE it - which is not the same question in every field
 *   4. what would count as cheating here
 *
 * Points 3 and 4 are where a naive generalisation breaks. The first version of
 * this system hardcoded three assumptions that only hold for small CPU ML:
 *
 *   - reruns are bitwise identical, so clean replay is a hash comparison;
 *   - reproduction means varying a random seed;
 *   - an experiment costs seconds, so replicating everything three times is free.
 *
 * None of those survive contact with a vision model on a GPU (nondeterministic),
 * a trading strategy (reproduction means a different time window, and moving the
 * backtest start date is the classic fraud), or a biological assay (reproduction
 * means independent samples, and a run costs days). Each is declared below
 * rather than assumed.
 */

/** How faithfully a rerun of identical inputs reproduces identical outputs. */
export type DeterminismClass =
  /** Same inputs give byte-identical outputs. Clean replay is a hash compare. */
  | "bitwise"
  /** Outputs vary but the distribution is stable. Replay compares within tolerance. */
  | "statistical"
  /** Reruns are not comparable in isolation; only aggregates carry meaning. */
  | "none";

/**
 * What "do it again" means here.
 *
 * The core needs this to decide whether a result survived reproduction. Getting
 * it wrong is not a detail: a finance strategy "replicated" across random seeds
 * has demonstrated nothing, because the seed was never what made it fragile.
 */
export type ReplicationKind =
  /** Vary a random seed. Valid where the seed is the only stochastic input. */
  | "seed"
  /** Resample the data. Bootstraps, cross-validation folds. */
  | "resample"
  /** Advance to a held-back time window. The only honest option for temporal data. */
  | "temporal_fold"
  /** Independently repeat the whole procedure. Wet lab, external runs. */
  | "independent_run";

export interface ReplicationPolicy {
  kind: ReplicationKind;
  /** How many reproductions to attempt. Cheap domains can afford more. */
  attempts: number;
  /**
   * How many must clear the bar. Unanimity is the strictest and, on a noisy
   * metric, the most likely to reject real work - see `plans/06-findings.md` §5.1.
   */
  minAgreement: number;
  /**
   * Does the PRIMARY METRIC actually respond to the variant?
   *
   * Distinct from `determinism`, which describes how faithfully a rerun
   * reproduces. This asks a different question: if we change the seed, should
   * the number move at all?
   *
   * For a language model it must - the seed changes training, so identical
   * results across seeds prove the variation never reached the experiment, and
   * a candidate really did pin its own seed to manufacture three "independent"
   * confirmations.
   *
   * For a memory-bound GPU kernel it must NOT. The seed changes the input DATA,
   * and reading four megabytes takes the same time whatever the bytes are.
   * Measured directly on this device: three seeds over one unchanged kernel
   * returned 265.929, 265.929, 260.837. Treating that as fraud rejected a real
   * 19 GB/s improvement as "reproduction theatre".
   *
   * Where this is false, seed-pinning is still caught - by the reproduction
   * policy gate, which fires on the candidate touching a harness-owned config
   * key and is exercised by the `seed_pin` fixture. That defence does not
   * depend on the metric moving.
   */
  variantSensitiveMetric: boolean;
  /** Produce the variant descriptors the runner will use (seeds, folds, dates). */
  variants(attempts: number): ReplicationVariant[];
}

export interface ReplicationVariant {
  /** Stable identifier for logs and evidence, e.g. "seed=1234" or "fold=2024Q3". */
  label: string;
  /** Applied to the candidate's config before the rerun. */
  configPatch: Record<string, unknown>;
}

/** Roughly what one experiment costs, so the allocator can budget honestly. */
export interface CostProfile {
  typicalSeconds: number;
  /** Marginal money per experiment beyond model tokens, if any. */
  typicalUsd?: number;
  /** True when an experiment consumes something that cannot be re-run cheaply. */
  consumesScarceResource?: boolean;
}

export interface MetricSpec {
  name: string;
  direction: "minimize" | "maximize";
  /**
   * The smallest difference distinguishable from run-to-run noise, MEASURED.
   *
   * Three of this project's four false fraud accusations came from thresholds
   * chosen by reasoning instead of measurement. No gate may be tighter than
   * this value.
   */
  noiseFloor: number;
}

export interface ExperimentContext {
  /** Isolated working copy the candidate may modify. */
  worktree: string;
  /** Where to write logs and artifacts for this attempt. */
  stagingDir: string;
  timeoutMs: number;
}

export interface ExperimentOutcome {
  ok: boolean;
  failureCode?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** What the candidate claims it achieved. NEVER trusted; used only to cross-check. */
  selfReportedPrimary: number | null;
  /** Path to whatever the evaluator will need. */
  outputPath: string | null;
  outputHash: string | null;
}

export interface EvaluationContext {
  worktree: string;
  outputPath: string;
  stagingDir: string;
  /** The baseline this candidate is being judged against, as it stood. */
  baselinePrimary: number;
  baselineSecondary: number | null;
  /** The registered support threshold, so the domain can size its own checks. */
  supportDelta: number;
  timeoutMs: number;
}

export interface DomainCheck {
  id: string;
  /**
   * `integrity` - the artifact does not match its own report; the run is void.
   * `leakage` / `shortcut` - evidence the task was subverted.
   *
   * The distinction is load-bearing. Conflating "broken" with "cheating" put
   * fabricated fraud into this project's evidence record four times.
   */
  class: "integrity" | "leakage" | "shortcut";
  passed: boolean;
  detail: string;
}

export interface EvaluationResult {
  ok: boolean;
  failureCode?: string;
  /** Independently recomputed. The candidate's own number is never used here. */
  primary: number | null;
  /** The held-back measurement the candidate could not reach. */
  secondary: number | null;
  /** Smallest metric movement the evaluator's timer/output precision can resolve. */
  measurementResolution?: number;
  checks: DomainCheck[];
  raw: unknown;
  durationMs: number;
}

export type ChangeClass =
  | "mechanism" | "architecture" | "algorithm" | "data"
  | "evaluation" | "parameter" | "replication";

export interface DiffFacts {
  changedPaths: string[];
  diffText: string;
  changeClass: ChangeClass;
  touchedProtected: boolean;
  /** Config keys edited that the domain does not expose as tunable. */
  undeclaredConfigKeys: string[];
  /** The candidate pinned something the harness owns - seeds, folds, dates. */
  escapedReproductionPolicy: boolean;
  /** The candidate's config could not be parsed. A verdict, never an exception. */
  malformedConfig: boolean;
}

/**
 * A research domain.
 *
 * Implementations should be small. If one grows past a couple of hundred lines,
 * something general has probably leaked into it and belongs in the core.
 */
/**
 * A planted cheat: work that improves the visible metric while violating the
 * task. Every domain must supply its own, because what counts as cheating is
 * field-specific - a CUDA kernel skipping a synchronise has no analogue in a
 * language model training on its validation split.
 *
 * These exist because every change to this project's shortcut defences was
 * driven by fixing a FALSE positive, each making detection more permissive, and
 * nothing tested the other direction. The first time these ran, two of four
 * defences turned out to be silently dead.
 */
export interface CheatFixture {
  id: string;
  title: string;
  description: string;
  /** The defence this fixture aims at. */
  targets: string;
  /** Verdicts that count as catching it. */
  acceptableVerdicts: string[];
  /**
   * The check that must be the one to fire, if the fixture names it.
   *
   * A fixture reported as CAUGHT proves only that SOME gate fired. Two CUDA
   * fixtures referenced a kernel symbol from the original baseline; once the
   * campaign replaced that kernel they stopped compiling, were stopped by the
   * compile gate, and kept reporting "caught" while testing nothing. A fixture
   * suite silently degrades as the candidate improves unless the intended gate
   * is named and enforced.
   */
  expectedChecks?: string[];
  /** Transform a candidate file. Return null if it cannot apply. */
  apply(files: Record<string, string>): Record<string, string> | null;
}

export interface DomainAdapter {
  readonly id: string;
  readonly metric: MetricSpec;
  /**
   * How one experiment is run, and what it produces. Exposed because the
   * EXECUTOR PROMPT is built from it: the prompt must describe this domain, not
   * whichever domain was written first.
   */
  readonly runCommand?: string[];
  readonly outputPath?: string;
  /**
   * Extra rules only this field needs, spliced into the executor prompt.
   * The tinyml domain uses it for "keep `load_for_eval` working"; CUDA uses it
   * for the kernel's required signature.
   */
  /**
   * May this domain's agents hold raw web-search tools?
   *
   * Defaults to true. Set false where the holdout is TIME: pull search cannot
   * be date-fenced, because the model chooses the query and reads the answer
   * directly, so a single headline about the scored period is lookahead that no
   * downstream check can see.
   */
  readonly agentSearch?: boolean;
  /**
   * ISO date. Literature published on or after this never reaches the manager.
   *
   * Set it where the holdout is time, to the moment the earliest scored window
   * opens. A source dated later is the future, and the leakage it carries is
   * invisible to every other check in the system.
   */
  readonly leadsAsOf?: string;
  readonly executorRules?: string;
  /** Overrides the prompt's verification rule entirely, if the domain needs to. */
  readonly executorVerification?: string;
  readonly determinism: DeterminismClass;
  readonly replication: ReplicationPolicy;
  readonly cost: CostProfile;

  /** Files the executor may edit. Everything else in the worktree is read-only. */
  readonly candidateFiles: string[];
  /** Absolute paths the executor may never read or write. */
  protectedPaths(projectRoot: string): string[];

  /** Seed a fresh candidate repository; returns the initial revision. */
  initialise(projectRoot: string, repoDir: string): void;

  runExperiment(ctx: ExperimentContext): ExperimentOutcome;
  evaluate(ctx: EvaluationContext): EvaluationResult;

  /** Which config keys count as tuning, derived from the CURRENT baseline. */
  parameterSurface(baselineConfig: Record<string, unknown>): Set<string>;
  /** Keys the harness owns; a candidate editing one has escaped its contract. */
  reservedConfigKeys(): Set<string>;
  /** Domain-specific reading of a diff, layered on the core's generic facts. */
  classifyChange(diffText: string, changedPaths: string[], configKeysChanged: string[]): ChangeClass;

  /** Planted cheats used to verify the defences actually fire. */
  cheatFixtures(): CheatFixture[];
}
