/**
 * Objective admission checks for a delegated task.
 *
 * These checks never interpret the science. They cannot tell a good experiment
 * from a bad one, and they must not try: scientific content stays unrestricted
 * Markdown. What they do enforce is the structural difference between research
 * and hill climbing, using only facts the runtime can verify from its own
 * records — whether the task is anchored to recorded evidence, and whether it
 * is a near-copy of a task already run without saying what changed.
 *
 * A rejected delegation is never silently dropped. The reason is written back
 * as runtime feedback that the orchestrator reads on its next turn, so the same
 * mistake is not repeated blind.
 */

export interface PriorTask {
  taskId: string;
  briefMarkdown: string;
}

export interface DelegationCheckInput {
  markdown: string;
  /** Identifiers that already exist in this direction and may be cited. */
  knownIdentifiers: string[];
  /** Previously delegated tasks in this direction, newest first. */
  priorTasks: PriorTask[];
}

export interface DelegationVerdict {
  admitted: boolean;
  /** Runtime feedback explaining the refusal, in the orchestrator's own terms. */
  feedbackMarkdown?: string;
}

const IDENTIFIER = /\b(?:COMP|OUT|SRC|TASK|SYN)-[0-9a-z-]{4,}\b/gi;

export function citedIdentifiers(markdown: string): string[] {
  return Array.from(new Set((markdown.match(IDENTIFIER) ?? []).map((item) => item.toUpperCase())));
}

function contentTokens(markdown: string): Set<string> {
  return new Set(markdown.toLowerCase().replace(IDENTIFIER, " ").split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3));
}

/** Jaccard overlap of content words; identifiers and short words are ignored. */
export function briefSimilarity(left: string, right: string): number {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

export const REPETITION_THRESHOLD = 0.75;

export function checkDelegation(input: DelegationCheckInput): DelegationVerdict {
  const cited = citedIdentifiers(input.markdown);
  const known = new Set(input.knownIdentifiers.map((item) => item.toUpperCase()));
  const citedKnown = cited.filter((item) => known.has(item));

  // Anchoring: once this direction holds any evidence at all, a new task must
  // name which recorded finding, source, or component it follows from. A task
  // that cites nothing is either detached from the accumulated understanding or
  // is chasing the last number, and neither belongs in the queue.
  if (known.size > 0 && citedKnown.length === 0) {
    return {
      admitted: false,
      feedbackMarkdown: [
        "Delegation refused: the brief cites no recorded evidence.",
        "",
        "This direction already holds recorded outcomes, sources, or components, so a new task must state which"
        + " of them it follows from. Cite at least one existing COMP-, OUT-, SRC-, or SYN- identifier in the brief"
        + " and say what it leaves unresolved.",
        "",
        `Citable identifiers include: ${input.knownIdentifiers.slice(0, 40).join(", ")}`,
        cited.length > 0 ? `\nIdentifiers you cited that do not exist: ${cited.filter((item) => !known.has(item)).join(", ")}` : "",
      ].join("\n"),
    };
  }

  // Repetition: a brief that is a near-copy of one already run is the shape
  // hill climbing takes here — same study, tweaked knob, kept if the number
  // improves. Deliberate replication is legitimate, so the refusal is lifted as
  // soon as the brief names the earlier task and therefore has to say what
  // differs.
  for (const prior of input.priorTasks) {
    const similarity = briefSimilarity(input.markdown, prior.briefMarkdown);
    if (similarity < REPETITION_THRESHOLD) continue;
    if (cited.includes(prior.taskId.toUpperCase())) break;
    return {
      admitted: false,
      feedbackMarkdown: [
        `Delegation refused: this brief is ${Math.round(similarity * 100)}% identical to ${prior.taskId}.`,
        "",
        "Re-running a study with an adjusted setting is only research when it tests a named mechanism hypothesis."
        + " If that is what this is, cite " + prior.taskId + " in the brief and state which explanation the change"
        + " discriminates and what result would change the current understanding. If instead the previous result is"
        + " already interpreted, move to the question it opened — reproduce, explain, generalise, integrate, or"
        + " abandon the mechanism — rather than re-issuing the same study.",
      ].join("\n"),
    };
  }

  return { admitted: true };
}

/**
 * Similarity above which a revision that brings no new evidence is refused.
 *
 * Lower than the threshold for task briefs, because the failure looks different:
 * a repeated study is a near-copy, while a rewritten synthesis keeps the same
 * argument and re-words it. Two live directions produced successive syntheses
 * sharing 43-59% of their content words, each superseding the last, at the cost
 * of a full-length generation every turn.
 */
export const SYNTHESIS_REPETITION_THRESHOLD = 0.4;

export interface SynthesisCheckInput {
  markdown: string;
  /** The synthesis this one would supersede, if any. */
  prior: { synthesisId: string; bodyMarkdown: string } | null;
}

/**
 * A revision has to earn its place: either it cites evidence the account it
 * replaces did not, or it says something materially different about the same
 * evidence. Restating the standing account in new words is neither, and it is
 * what an orchestrator does when most of its context is its own prose.
 */
export function checkSynthesis(input: SynthesisCheckInput): DelegationVerdict {
  if (!input.prior) return { admitted: true };
  const similarity = briefSimilarity(input.markdown, input.prior.bodyMarkdown);
  if (similarity < SYNTHESIS_REPETITION_THRESHOLD) return { admitted: true };

  const cited = new Set(citedIdentifiers(input.markdown).filter((item) => item.startsWith("OUT-")));
  const priorCited = new Set(citedIdentifiers(input.prior.bodyMarkdown).filter((item) => item.startsWith("OUT-")));
  const fresh = [...cited].filter((item) => !priorCited.has(item));
  if (fresh.length > 0) return { admitted: true };

  return {
    admitted: false,
    feedbackMarkdown: [
      `Synthesis refused: it is ${Math.round(similarity * 100)}% identical to ${input.prior.synthesisId}`
      + " and cites no outcome that one did not already cite.",
      "",
      "A revision earns its place by adding evidence or by changing the account. Restating the standing"
      + " understanding in new words costs a full turn and leaves the record no better than before.",
      "",
      "If a finding has landed since, cite its OUT- identifier and say what it changed. If the account itself"
      + " should change, say plainly what you now believe that you did not, and why. If neither is true, the"
      + " understanding already stands as recorded — spend the turn on the question it leaves open instead:"
      + " delegate an experiment, request literature, relate two components, or pause.",
    ].join("\n"),
  };
}
