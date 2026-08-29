import { readTraceSteps, traceBreakdown, traceSegments } from "./trace.js";
import { chunkTraceSteps, machineIdentifiers, publishableTrace } from "./trace-publish.js";
import { ResearchStore } from "./store.js";

/**
 * Builds the public research record: what a read-only mirror may show.
 *
 * Two rules govern what appears here. Only research belongs in it — findings,
 * their provenance, and enough run metadata to draw the timeline — and nothing
 * that describes the machine it ran on. Agent prompts embed the preflight sheet,
 * worktree paths and interpreter locations, all of which carry the operator's
 * username and filesystem layout, so prompts, traces and workspace contents are
 * left out entirely rather than trimmed.
 *
 * Trace steps are published, because the reasoning and the code an agent wrote
 * are the research. They go through `trace-publish`, which redacts and then
 * verifies against identifiers read from the running environment, withholding
 * any step that still matches. Tool output is withheld unless explicitly asked
 * for: it is unbounded machine output rather than research.
 *
 * The record is split by entity because Firestore caps a document at 1 MB and a
 * single direction already exceeds that once sources and runs are included.
 */

const HOME_PATH = /(?:[A-Za-z]:\\+Users\\+[^\\\s"']+|\/(?:home|Users)\/[^/\s"']+)/g;
const WINDOWS_PATH = /[A-Za-z]:\\+[^\s"']*/g;

/** Removes machine-identifying paths from text that is otherwise research. */
export function redact(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(HOME_PATH, "<workspace>")
    .replace(WINDOWS_PATH, "<path>");
}

export interface PublishedRecord {
  direction: Record<string, unknown>;
  components: Array<Record<string, unknown>>;
  componentRelations: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  syntheses: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  traceSteps: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  spend: Record<string, number>;
  publishedAt: string;
}

export function buildPublishedRecord(store: ResearchStore, directionId: string,
  projectRoot = process.cwd(), options: { includeToolOutput?: boolean; includeTrace?: boolean } = {}): PublishedRecord {
  const context = store.context(directionId);
  const identifiers = machineIdentifiers();
  const traceChunks: Array<Record<string, unknown>> = [];
  const reviewFor = (synthesisId: unknown) =>
    context.synthesisReviews.find((item) => item.synthesis_id === synthesisId) ?? null;

  return {
    direction: {
      direction_id: context.direction.direction_id,
      title: context.direction.title,
      brief_md: context.direction.brief_md,
      constraints_md: context.direction.constraints_md,
      status: context.direction.status,
      created_at: context.direction.created_at,
      updated_at: context.direction.updated_at,
    },
    components: context.components.map((item) => ({
      component_id: item.component_id, title: item.title,
      description_md: redact(String(item.description_md ?? "")), created_at: item.created_at,
    })),
    componentRelations: context.componentRelations.map((item) => ({
      from_component_id: item.from_component_id, to_component_id: item.to_component_id,
      relationship_md: redact(String(item.relationship_md ?? "")),
    })),
    // Briefs are research design and belong in the record; the worktree path
    // they were executed in does not.
    tasks: context.tasks.map((item) => ({
      task_id: item.task_id, component_id: item.component_id, state: item.state,
      task_kind: item.task_kind, brief_md: redact(item.brief_md), created_at: item.created_at,
    })),
    outcomes: context.outcomes.map((item) => ({
      outcome_id: item.outcome_id, task_id: item.task_id, verdict: item.verdict,
      report_md: redact(String(item.report_md ?? "")), created_at: item.created_at,
    })),
    syntheses: context.syntheses.map((item) => ({
      synthesis_id: item.synthesis_id, component_id: item.component_id,
      supersedes_synthesis_id: item.supersedes_synthesis_id,
      body_md: redact(String(item.body_md ?? "")), created_at: item.created_at,
      componentIds: context.synthesisComponents.filter((link) => link.synthesis_id === item.synthesis_id)
        .map((link) => String(link.component_id)),
      outcomeIds: context.synthesisOutcomes.filter((link) => link.synthesis_id === item.synthesis_id)
        .map((link) => String(link.outcome_id)),
      sourceIds: context.synthesisSources.filter((link) => link.synthesis_id === item.synthesis_id)
        .map((link) => String(link.source_id)),
      review: reviewFor(item.synthesis_id),
    })),
    sources: context.sources.map((item) => ({
      source_id: item.source_id, title: item.title, canonical_url: item.canonical_url,
      provider: item.provider, state: item.state, card_md: item.card_md,
    })),
    // Run shape without the prompt: enough to show what ran, how long, and how
    // it ended, with no trace text and no attempt directories.
    runs: context.runs.map((item) => {
      const start = Date.parse(String(item.started_at));
      const end = item.completed_at ? Date.parse(String(item.completed_at)) : start;
      const durationMs = Math.max(0, end - start);
      // The timing shape is published; the trace text is not. A segment carries
      // a tool name, an interval and an error flag — no arguments, no output and
      // no path — so the timeline can be shown without publishing what ran where.
      const steps = readTraceSteps(projectRoot, item.attempt_dir);
      // Trace publishing can be turned off wholesale, for an operator who
      // would rather publish only the timeline.
      const published = options.includeTrace === false ? []
        : publishableTrace(steps, { identifiers, includeToolOutput: options.includeToolOutput });
      traceChunks.push(...chunkTraceSteps(String(item.run_id), published));
      const segments = traceSegments(steps, durationMs)
        // `seq` ties a segment to the trace step it came from. It was dropped here
        // when only timing was published and there was no trace to point at; with
        // traces published, dropping it meant clicking a bar in the roll selected
        // nothing and the trace never scrolled to the step.
        .map(({ kind, label, startMs, endMs, isError, seq }) => ({ kind, label, startMs, endMs, isError, seq }));
      return {
        run_id: item.run_id, task_id: item.task_id, role: item.role, state: item.state,
        // A provider failure carries a stack trace from this machine, so it is
        // redacted like any other text. Publishing it raw blocked every sync:
        // the boundary check refused the whole record, correctly, and kept
        // refusing it because nothing upstream ever fixed the field.
        failure: item.failure === null || item.failure === undefined ? null : redact(String(item.failure)),
        model: item.model, provider: item.provider,
        input_tokens: item.input_tokens, output_tokens: item.output_tokens, cost_usd: item.cost_usd,
        started_at: item.started_at, completed_at: item.completed_at,
        trace_steps: published.length,
        trace_withheld: published.filter((step) => step.withheld).length,
        segments, breakdown: traceBreakdown(segments as never, durationMs),
      };
    }),
    traceSteps: traceChunks,
    // The independent verification is the evidence, so the command and its exit
    // code are published; its output may quote local paths, so it is redacted.
    commands: context.commands.map((item) => ({
      task_id: item.task_id, kind: item.kind, executable: item.executable,
      args: JSON.parse(String(item.args_json)).map((arg: string) => redact(arg)),
      exit_code: item.exit_code, created_at: item.created_at,
    })),
    spend: context.runs.reduce((totals: Record<string, number>, run) => ({
      inputTokens: (totals.inputTokens ?? 0) + Number(run.input_tokens ?? 0),
      outputTokens: (totals.outputTokens ?? 0) + Number(run.output_tokens ?? 0),
      costUsd: (totals.costUsd ?? 0) + Number(run.cost_usd ?? 0),
    }), {}),
    publishedAt: new Date().toISOString(),
  };
}
