import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { diffAgainstHead, git, sha256File } from "../core/workspace.js";
import { runProcess, runWorker } from "../worker/genkit-worker.js";
import type { MarkdownAction, WorkerResult } from "../worker/types.js";
import { immediateStopFile } from "./control.js";
import { checkDelegation } from "./delegation.js";
import { preflightFacts, renderPreflightMarkdown } from "./preflight.js";
import { ResearchStore, researchHash, researchId, researchNow } from "./store.js";
import type { LeanTask, OutcomeVerdict } from "./types.js";

/**
 * How many executor attempts one task gets before the runtime stops retrying
 * and hands the failure back as evidence. Attempts share a worktree, so a later
 * attempt continues the earlier one instead of restarting discovery.
 */
export const MAX_EXECUTOR_ATTEMPTS = Number(process.env.AR_MAX_EXECUTOR_ATTEMPTS ?? 3);

const ORCHESTRATOR_ACTIONS = [
  ["delegate_task", "Delegate one research task in Markdown. The task may be a reproduction, mechanism test, analysis, implementation, comparison, integration, or another method suited to the question."],
  ["record_supported", "Conclude the returned task as supported using a scoped Markdown interpretation of its evidence."],
  ["record_refuted", "Conclude the returned task as refuted using a scoped Markdown interpretation of its evidence."],
  ["record_bounded", "Conclude that the result supports only a bounded scope described in Markdown."],
  ["record_inconclusive", "Conclude that the evidence is scientifically inconclusive and explain why in Markdown."],
  ["record_blocked", "Conclude that the task is blocked and record the concrete blocker evidence in Markdown."],
  ["record_synthesis", "Record a tentative current-understanding revision in free-form Markdown. Cite exact COMP, OUT, and SRC identifiers for scope and provenance."],
  ["create_component", "Create an optional organizational component. First Markdown line is its title; the rest explains it."],
  ["relate_components", "Record how two existing components relate. Cite both COMP identifiers; the first is the source of the relationship and the second its target. Explain the relationship in Markdown."],
  ["request_watch", "Ask the independent watcher to investigate a research question or adjacent mechanism, in Markdown."],
  ["pause_research", "Pause the direction with a Markdown explanation when further autonomous work is not justified."],
] as const;

function compact(value: string | null | undefined, max = 8_000): string {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated; inspect on demand]`;
}

function orchestratorContext(store: ResearchStore, directionId: string, projectRoot: string): string {
  const context = store.context(directionId);
  const awaiting = context.tasks.find((task) => task.state === "awaiting_orchestrator") ?? null;
  const awaitingRun = awaiting
    ? context.runs.find((run) => run.task_id === awaiting.task_id && run.role === "executor") as Record<string, unknown> | undefined
    : undefined;
  const sourceCards = context.sources.filter((source) => source.state === "relevant").slice(0, 20)
    .map((source) => `### ${source.source_id} — ${source.title}\n${source.canonical_url}\n${compact(source.card_md, 4_000)}`)
    .join("\n\n");
  const components = context.components.map((component) =>
    `- ${component.component_id}: ${component.title}\n  ${compact(String(component.description_md ?? ""), 600)}`).join("\n");
  const synthesisStatus = (synthesisId: unknown) => {
    const acceptedReplacement = context.syntheses.find((item) => item.supersedes_synthesis_id === synthesisId
      && context.synthesisReviews.find((review) => review.synthesis_id === item.synthesis_id)?.verdict === "accepted");
    if (acceptedReplacement) return `superseded by ${acceptedReplacement.synthesis_id}`;
    const review = context.synthesisReviews.find((item) => item.synthesis_id === synthesisId) as
      Record<string, unknown> | undefined;
    return String(review?.verdict ?? "tentative");
  };
  const syntheses = context.syntheses.slice(0, 20).map((synthesis) => {
    const outcomeIds = context.synthesisOutcomes.filter((item) => item.synthesis_id === synthesis.synthesis_id)
      .map((item) => item.outcome_id).join(", ");
    const sourceIds = context.synthesisSources.filter((item) => item.synthesis_id === synthesis.synthesis_id)
      .map((item) => item.source_id).join(", ");
    // The reviewer's reasoning is the point of the review: a bare verdict tells
    // the orchestrator that something is wrong without saying what.
    const review = context.synthesisReviews.find((item) => item.synthesis_id === synthesis.synthesis_id) as
      Record<string, unknown> | undefined;
    const reviewNote = review?.note_md
      ? `\nHuman review (${String(review.verdict)}): ${compact(String(review.note_md), 1_500)}`
      : "";
    return `### ${synthesis.synthesis_id} [${synthesisStatus(synthesis.synthesis_id)}] scope=${synthesis.component_id ?? "direction"}\n`
      + `${compact(String(synthesis.body_md), 3_000)}\nProvenance: ${outcomeIds || "no outcomes cited"}; `
      + `${sourceIds || "no sources cited"}${reviewNote}`;
  }).join("\n\n");
  const digested = new Set(context.synthesisOutcomes.map((item) => String(item.outcome_id)));
  const undigested = context.outcomes.filter((item) => !digested.has(String(item.outcome_id))).slice(0, 20)
    .map((item) => `- ${item.outcome_id} [${item.verdict}] ${compact(String(item.report_md), 500)}`).join("\n");
  const history = context.tasks.slice(0, 25).map((task) => {
    const outcome = context.outcomes.find((item) => item.task_id === task.task_id) as Record<string, unknown> | undefined;
    return `- ${task.task_id} [${task.task_kind ?? task.mode}/${task.state}] ${compact(task.brief_md.split(/\r?\n/)[0], 180)}`
      + (outcome ? ` → ${outcome.verdict}: ${compact(String(outcome.report_md), 500)}` : "");
  }).join("\n");
  const returned = awaiting ? [
    `## Returned executor task: ${awaiting.task_id}`,
    awaiting.brief_md,
    "### Executor report",
    compact(String(awaitingRun?.output_md ?? "No prose report; inspect recorded commands and artifacts."), 12_000),
    "### Recorded checks and independent verification",
    context.commands.filter((item) => item.task_id === awaiting.task_id).map((item) =>
      `${item.kind}: ${item.executable} ${JSON.parse(String(item.args_json)).join(" ")}\nexit=${String(item.exit_code)}\n${compact(String(item.stdout), 3_000)}\n${compact(String(item.stderr), 1_500)}`).join("\n\n") || "No run_check invocations were recorded.",
    "### Artifacts",
    context.artifacts.filter((item) => item.task_id === awaiting.task_id)
      .map((item) => `- ${item.path} sha256=${item.content_hash}`).join("\n") || "No changed-file artifacts.",
  ].join("\n\n") : "## Returned executor task\nNone.";
  // Runtime feedback used to be written to notes that nothing ever read back,
  // so a refused delegation looked to the orchestrator like a delegation that
  // simply never happened. Recent runtime notes are now part of its context.
  const feedback = context.notes.filter((note) => String(note.role) === "runtime").slice(0, 5)
    .map((note) => `- ${compact(String(note.body_md), 2_000)}`).join("\n");
  return [
    `# Direction: ${context.direction.title}`,
    context.direction.brief_md,
    `## Human constraints\n${context.direction.constraints_md || "None supplied."}`,
    renderPreflightMarkdown(preflightFacts(projectRoot)),
    `## Runtime feedback on your recent turns\n${feedback || "None. No delegation was refused and no task exhausted its attempts."}`,
    `## Components\n${components || "No components. Components are optional."}`,
    `## Current understanding revisions\n${syntheses || "No synthesis has been recorded. Findings remain tentative until synthesized and reviewed by the human."}`,
    `## Undigested findings\n${undigested || "No uncited outcomes."}`,
    returned,
    `## Relevant watcher cards\n${sourceCards || "No admitted sources yet. You may request watcher questions or begin clearly labeled exploration."}`,
    `## Task history\n${history || "No prior tasks."}`,
  ].join("\n\n");
}

/**
 * A transport or provider failure kills the turn before the model can write its
 * report, which used to leave an empty run row and hand the orchestrator the
 * string "No prose report". The work that happened before the failure is still
 * recorded in the trace, commands, and worktree, so the runtime writes the
 * report the model could not, clearly attributed to the runtime.
 */
function runtimeFailureReport(result: WorkerResult): string {
  const evidence = result.trace.filter((step) => step.kind === "tool_call")
    .slice(-12).map((step) => `- ${step.toolName ?? "tool"}: ${compact(step.content, 300)}`).join("\n");
  return [
    "_Runtime-authored report: the executor turn ended before the model produced prose._",
    `- failure: ${result.failure ?? "unknown"}`,
    `- tool calls completed: ${result.toolCalls}`,
    `- duration: ${Math.round(result.durationMs / 1000)}s`,
    result.stderrTail ? `- provider detail: ${compact(result.stderrTail, 1_000)}` : "",
    evidence ? `\n### Last recorded tool calls\n${evidence}` : "\nNo tool calls were recorded.",
    "\nAny files the attempt produced are preserved in the task worktree and captured as artifacts.",
  ].filter(Boolean).join("\n");
}

function finishWorkerRun(store: ResearchStore, runId: string, result: WorkerResult): void {
  const stopped = result.failure === "STOP_REQUESTED";
  store.finishRun({
    runId, state: stopped ? "cancelled" : result.ok ? "succeeded" : "failed",
    outputMarkdown: result.ok || result.finalText.trim() ? result.finalText : runtimeFailureReport(result),
    failure: result.failure ?? null,
    model: result.model, provider: result.provider,
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.usage.costUsd,
  });
}

function currentAwaitingTask(store: ResearchStore, directionId: string): LeanTask | null {
  return (store.db.prepare(
    "SELECT * FROM tasks WHERE direction_id=? AND state='awaiting_orchestrator' ORDER BY updated_at LIMIT 1",
  ).get(directionId) as LeanTask | undefined) ?? null;
}

/** Every identifier a brief may legitimately cite as its anchor in the record. */
function directionIdentifiers(store: ResearchStore, directionId: string): string[] {
  const column = (sql: string) => (store.db.prepare(sql).all(directionId) as Array<Record<string, string>>)
    .map((row) => String(Object.values(row)[0]));
  return [
    ...column("SELECT component_id FROM components WHERE direction_id=? ORDER BY created_at"),
    ...column("SELECT outcome_id FROM outcomes WHERE direction_id=? ORDER BY created_at DESC"),
    ...column("SELECT source_id FROM sources WHERE direction_id=? AND state='relevant' ORDER BY updated_at DESC"),
    ...column("SELECT synthesis_id FROM component_syntheses WHERE direction_id=? ORDER BY created_at DESC"),
  ];
}

export function applyOrchestratorActions(store: ResearchStore, directionId: string, runId: string,
  actions: MarkdownAction[]): { taskId: string | null; paused: boolean } {
  let taskId: string | null = null;
  let paused = false;
  const watcherRequestedThisTurn = actions.some((action) => action.name === "request_watch");
  const admittedSources = Number((store.db.prepare(
    "SELECT COUNT(*) count FROM sources WHERE direction_id=? AND state='relevant'",
  ).get(directionId) as { count: number }).count);
  for (const action of actions) {
    const markdown = action.markdown || "(No additional Markdown supplied.)";
    if (action.name === "create_component") {
      store.createComponent(directionId, markdown);
      continue;
    }
    if (action.name === "relate_components") {
      if (!store.relateComponents(directionId, markdown)) {
        store.saveNote(directionId, runId, "runtime",
          `Relationship ignored: name two existing COMP identifiers, source first.

${markdown}`);
      }
      continue;
    }
    if (action.name === "request_watch") {
      store.requestWatch(directionId, markdown);
      continue;
    }
    if (action.name === "record_synthesis") {
      store.recordSynthesis({ directionId, runId, markdown });
      continue;
    }
    if (action.name === "pause_research") {
      store.db.prepare("UPDATE directions SET status='paused',updated_at=? WHERE direction_id=?")
        .run(researchNow(), directionId);
      store.appendEvent(directionId, null, "direction.paused", "orchestrator", markdown);
      paused = true;
      continue;
    }
    const verdicts: Record<string, OutcomeVerdict> = {
      record_supported: "supported", record_refuted: "refuted", record_bounded: "bounded",
      record_inconclusive: "inconclusive", record_blocked: "blocked",
    };
    if (verdicts[action.name]) {
      const awaiting = currentAwaitingTask(store, directionId);
      if (!awaiting) {
        store.saveNote(directionId, runId, "orchestrator", `Ignored ${action.name}: no returned task.\n\n${markdown}`);
      } else {
        store.recordOutcome({ directionId, taskId: awaiting.task_id, runId, verdict: verdicts[action.name]!, markdown });
      }
      continue;
    }
    if (action.name === "delegate_task") {
      if (currentAwaitingTask(store, directionId)) {
        store.saveNote(directionId, runId, "runtime",
          `Delegation deferred because the returned task must be interpreted first.\n\n${markdown}`);
        continue;
      }
      if (watcherRequestedThisTurn && admittedSources === 0) {
        store.saveNote(directionId, runId, "runtime",
          "Delegation deferred until the requested watcher evidence is admitted. The executor does not perform literature retrieval or research design.\n\n"
          + markdown);
        continue;
      }
      const verdict = checkDelegation({
        markdown,
        knownIdentifiers: directionIdentifiers(store, directionId),
        priorTasks: (store.db.prepare(
          "SELECT task_id, brief_md FROM tasks WHERE direction_id=? ORDER BY created_at DESC LIMIT 20",
        ).all(directionId) as Array<{ task_id: string; brief_md: string }>)
          .map((row) => ({ taskId: row.task_id, briefMarkdown: row.brief_md })),
      });
      if (!verdict.admitted) {
        store.saveNote(directionId, runId, "runtime",
          `${verdict.feedbackMarkdown}\n\n### Refused brief\n${markdown}`);
        store.appendEvent(directionId, null, "task.delegation_refused", "runtime", verdict.feedbackMarkdown ?? "");
        continue;
      }
      taskId = store.delegateTask({ directionId, mode: "exploration", markdown });
    }
  }
  return { taskId, paused };
}

export async function runOrchestratorTurn(input: {
  store: ResearchStore; projectRoot: string; directionId: string; model?: string;
}): Promise<{ runId: string; taskId: string | null; paused: boolean; result: WorkerResult }> {
  const prompt = orchestratorContext(input.store, input.directionId, input.projectRoot);
  const attemptDir = join(input.projectRoot, ".autoresearch", "attempts", "orchestrator", input.directionId, researchId("attempt"));
  const runId = input.store.beginRun({ directionId: input.directionId, role: "orchestrator", inputMarkdown: prompt, attemptDir });
  const systemPrompt = readFileSync(join(input.projectRoot, "prompts", "researcher.md"), "utf8");
  const actionDefs = ORCHESTRATOR_ACTIONS.map(([name, description]) => ({ name, description }));
  const result = await runWorker({
    role: "researcher", prompt, systemPrompt, cwd: input.projectRoot, attemptDir,
    tools: ["read", "ls", "find", "grep", ...actionDefs.map((item) => item.name)],
    markdownActions: actionDefs, allowEmptyResponse: true, model: input.model, timeoutMs: 0,
    maxOutputTokens: 65_536, cancelFile: immediateStopFile(input.projectRoot),
    campaignId: input.directionId, cycleId: "orchestrator", attemptId: runId,
  });
  finishWorkerRun(input.store, runId, result);
  if (!result.ok) return { runId, taskId: null, paused: false, result };
  const actions = result.actions ?? [];
  if (actions.length === 0) input.store.saveNote(input.directionId, runId, "orchestrator", result.finalText || "No action selected.");
  const applied = applyOrchestratorActions(input.store, input.directionId, runId, actions);
  return { runId, ...applied, result };
}

function ensureInside(root: string, path: string): string {
  const base = resolve(root); const full = resolve(path); const rel = relative(base, full);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path escapes workspace: ${path}`);
  return full;
}

function createTaskWorkspace(projectRoot: string, taskId: string): string {
  const root = join(projectRoot, ".autoresearch", "worktrees");
  mkdirSync(root, { recursive: true });
  const workspace = join(root, taskId.replace(/[^a-z0-9_-]/gi, "_"));
  git(["worktree", "add", "-q", "--detach", workspace, "HEAD"], projectRoot);
  const patch = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: projectRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
  if (patch.trim()) {
    const patchPath = join(workspace, ".lean-runtime-base.patch");
    writeFileSync(patchPath, patch, "utf8");
    execFileSync("git", ["apply", "--whitespace=nowarn", ".lean-runtime-base.patch"], { cwd: workspace, windowsHide: true });
    execFileSync("git", ["rm", "--cached", "--ignore-unmatch", ".lean-runtime-base.patch"], { cwd: workspace, windowsHide: true });
    try { execFileSync("git", ["clean", "-f", "--", ".lean-runtime-base.patch"], { cwd: workspace, windowsHide: true }); } catch { /* best effort */ }
  }
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: projectRoot, encoding: "utf8", windowsHide: true,
  }).split("\0").filter(Boolean).filter((path) => !path.startsWith(".autoresearch") && !path.startsWith("node_modules/"));
  for (const path of untracked) {
    const source = ensureInside(projectRoot, join(projectRoot, path));
    const target = ensureInside(workspace, join(workspace, path));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  git(["config", "user.email", "research@local"], workspace);
  git(["config", "user.name", "lean-research-runtime"], workspace);
  git(["add", "-A"], workspace);
  git(["commit", "-q", "--allow-empty", "-m", `task base ${taskId}`], workspace);
  return workspace;
}

function saveCommand(store: ResearchStore, input: {
  directionId: string; taskId: string; runId: string; kind: "check" | "verification";
  executable: string; args: string[]; result: { exitCode: number | null; stdout: string; stderr: string }; durationMs: number;
}): void {
  store.db.prepare(
    `INSERT INTO commands(command_id,direction_id,task_id,run_id,kind,executable,args_json,exit_code,stdout,stderr,duration_ms,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(researchId("CMD"), input.directionId, input.taskId, input.runId, input.kind, input.executable,
    JSON.stringify(input.args), input.result.exitCode, input.result.stdout, input.result.stderr, input.durationMs, researchNow());
}

function captureArtifacts(store: ResearchStore, projectRoot: string, directionId: string, taskId: string,
  runId: string, workspace: string): void {
  const diff = diffAgainstHead(workspace);
  const artifactRoot = join(projectRoot, ".autoresearch", "artifacts", taskId);
  mkdirSync(artifactRoot, { recursive: true });
  const diffPath = join(artifactRoot, `${runId}.patch`);
  writeFileSync(diffPath, diff.diffText, "utf8");
  store.db.prepare(
    `INSERT INTO artifacts(artifact_id,direction_id,task_id,run_id,path,content_hash,byte_length,kind,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(researchId("ART"), directionId, taskId, runId, relative(projectRoot, diffPath).replace(/\\/g, "/"),
    sha256File(diffPath), statSync(diffPath).size, "diff", researchNow());
  for (const path of diff.changedPaths) {
    const full = ensureInside(workspace, join(workspace, path));
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    store.db.prepare(
      `INSERT INTO artifacts(artifact_id,direction_id,task_id,run_id,path,content_hash,byte_length,kind,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(researchId("ART"), directionId, taskId, runId, path.replace(/\\/g, "/"), sha256File(full), statSync(full).size,
      "changed_file", researchNow());
  }
}

export interface PriorExecutorRun {
  run_id: string;
  state: string;
  failure: string | null;
  output_md: string | null;
  started_at: string;
}

/** Every executor run this task has had, in order, whatever became of it. */
function priorExecutorRuns(store: ResearchStore, taskId: string): PriorExecutorRun[] {
  return store.db.prepare(
    "SELECT run_id,state,failure,output_md,started_at FROM runs WHERE task_id=? AND role='executor' ORDER BY started_at",
  ).all(taskId) as PriorExecutorRun[];
}

/**
 * The subset that counts against the attempt budget. An operator stop, or a
 * process lost to a restart or a kill, says nothing about whether the task can
 * be executed and must not retire it.
 *
 * This is deliberately narrower than the set used to build the resume context:
 * an interrupted attempt still left its files in the worktree, so the next
 * attempt must be told about it even though it was not charged for it.
 */
export function budgetedAttempts(runs: PriorExecutorRun[]): PriorExecutorRun[] {
  return runs.filter((run) => run.state !== "cancelled" && run.failure !== "PROCESS_LOST_ON_RESTART");
}

/**
 * What a resumed attempt needs to continue rather than restart. Retrying used
 * to discard the worktree and re-run the task brief verbatim, so every attempt
 * repeated the same environment discovery and lost the implementation the
 * previous attempt had already written.
 */
export function resumeContext(workspace: string, priors: PriorExecutorRun[], attempt: number): string {
  if (priors.length === 0) return "";
  const changed = (() => {
    try { return diffAgainstHead(workspace).changedPaths; } catch { return [] as string[]; }
  })();
  const history = priors.map((prior, index) => {
    const interrupted = prior.state === "cancelled" || prior.failure === "PROCESS_LOST_ON_RESTART";
    return `#### Earlier run ${index + 1} — ${prior.state}${prior.failure ? ` (${prior.failure})` : ""}`
      + (interrupted ? " — interrupted by the operator or the runtime, not by the work itself" : "")
      + `\n${compact(String(prior.output_md ?? "No report was recorded."), 4_000)}`;
  }).join("\n\n");
  return [
    `## Resumed attempt ${attempt} of ${MAX_EXECUTOR_ATTEMPTS}`,
    "This is the same worktree the earlier attempts used. Their files are still here."
    + " Continue from that state: re-read what exists before writing anything, keep work that is correct,"
    + " and do not repeat environment discovery that already succeeded."
    + " Earlier attempts ended for the reasons below; a provider or transport failure says nothing about"
    + " whether the work itself was on track.",
    `### Files already changed in this worktree\n${changed.map((path) => `- ${path}`).join("\n") || "- none"}`,
    `### Earlier attempts\n${history}`,
    attempt >= MAX_EXECUTOR_ATTEMPTS
      ? "### Final attempt\nThis is the last attempt the runtime will schedule for this task."
        + " Land and report whatever evidence is defensible, then return: partial evidence with an honest"
        + " statement of what is not covered is worth more to the orchestrator than another unreported attempt."
      : "",
  ].filter(Boolean).join("\n\n");
}

/** Hand an unrecoverable task back to the orchestrator as evidence, not silence. */
function returnExhaustedTask(input: {
  store: ResearchStore; projectRoot: string; directionId: string; task: LeanTask; priors: PriorExecutorRun[];
}): void {
  const summary = [
    `Task ${input.task.task_id} exhausted its ${MAX_EXECUTOR_ATTEMPTS} executor attempts and was returned unfinished.`,
    "",
    ...input.priors.map((prior, index) =>
      `- attempt ${index + 1}: ${prior.state}${prior.failure ? ` (${prior.failure})` : ""}`),
    "",
    "Partial work is captured as artifacts and recorded commands. Interpret it with an outcome action."
    + " If the attempts failed on transport or provider errors rather than on the science, the question is"
    + " still open; if they failed because the brief could not be executed as written, re-scope it.",
  ].join("\n");
  try {
    captureArtifacts(input.store, input.projectRoot, input.directionId, input.task.task_id,
      input.priors[input.priors.length - 1]!.run_id, String(input.task.workspace_path));
  } catch { /* artifacts are best effort when the worktree is unusable */ }
  input.store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator',updated_at=? WHERE task_id=?")
    .run(researchNow(), input.task.task_id);
  input.store.saveNote(input.directionId, null, "runtime", summary);
  input.store.appendEvent(input.directionId, input.task.task_id, "task.attempts_exhausted", "runtime", summary);
}

export async function runNextExecutorTask(input: {
  store: ResearchStore; projectRoot: string; directionId: string; model?: string;
}): Promise<{ taskId: string; runId: string; result: WorkerResult } | null> {
  const task = input.store.db.prepare(
    "SELECT * FROM tasks WHERE direction_id=? AND state='queued' ORDER BY created_at LIMIT 1",
  ).get(input.directionId) as LeanTask | undefined;
  if (!task) return null;
  const priors = priorExecutorRuns(input.store, task.task_id);
  const charged = budgetedAttempts(priors);
  if (charged.length >= MAX_EXECUTOR_ATTEMPTS) {
    returnExhaustedTask({ store: input.store, projectRoot: input.projectRoot,
      directionId: input.directionId, task, priors: charged });
    return null;
  }
  const attempt = charged.length + 1;
  // A retry inherits the previous attempt's worktree. The work an interrupted
  // attempt completed is real evidence; recreating the worktree threw it away
  // and forced the next attempt to rediscover the same environment.
  const inherited = task.workspace_path && existsSync(task.workspace_path)
    && existsSync(join(task.workspace_path, ".git")) ? task.workspace_path : null;
  let workspace: string;
  try { workspace = inherited ?? createTaskWorkspace(input.projectRoot, `${task.task_id}-${researchId("ws")}`); }
  catch (error) {
    input.store.db.prepare("UPDATE tasks SET state='blocked',updated_at=? WHERE task_id=?")
      .run(researchNow(), task.task_id);
    input.store.appendEvent(input.directionId, task.task_id, "task.workspace_failed", "system", String(error));
    throw error;
  }
  input.store.db.prepare("UPDATE tasks SET state='running',workspace_path=?,updated_at=? WHERE task_id=?")
    .run(workspace, researchNow(), task.task_id);
  const prompt = [
    task.brief_md,
    renderPreflightMarkdown(preflightFacts(input.projectRoot)),
    resumeContext(workspace, priors, attempt),
  ].filter(Boolean).join("\n\n");
  const attemptDir = join(input.projectRoot, ".autoresearch", "attempts", "executor", input.directionId, task.task_id, researchId("attempt"));
  const runId = input.store.beginRun({ directionId: input.directionId, taskId: task.task_id, role: "executor",
    inputMarkdown: prompt, attemptDir });
  const systemPrompt = readFileSync(join(input.projectRoot, "prompts", "implementation-executor.md"), "utf8");
  const result = await runWorker({
    role: "executor", prompt, systemPrompt, cwd: workspace, attemptDir,
    tools: ["read", "write", "edit", "ls", "find", "grep", "run", "run_check"],
    allowEmptyResponse: true, model: input.model, timeoutMs: 0, maxOutputTokens: 65_536,
    cancelFile: immediateStopFile(input.projectRoot), campaignId: input.directionId,
    cycleId: task.task_id, attemptId: runId,
  });
  finishWorkerRun(input.store, runId, result);
  if (!result.ok) {
    // Record what the interrupted attempt produced before requeuing it. The
    // worktree is kept, so the next attempt resumes from these same files.
    for (const check of result.checks ?? []) {
      saveCommand(input.store, { directionId: input.directionId, taskId: task.task_id, runId, kind: "check",
        executable: check.executable, args: check.args, result: check.result, durationMs: 0 });
    }
    try { captureArtifacts(input.store, input.projectRoot, input.directionId, task.task_id, runId, workspace); }
    catch { /* a partially written worktree must not mask the provider failure */ }
    input.store.db.prepare("UPDATE tasks SET state=?,updated_at=? WHERE task_id=?")
      .run(result.failure === "STOP_REQUESTED" ? "cancelled" : "queued", researchNow(), task.task_id);
    input.store.appendEvent(input.directionId, task.task_id, "task.attempt_failed", "system",
      `Attempt ${attempt} of ${MAX_EXECUTOR_ATTEMPTS} failed: ${result.failure ?? "unknown"}. Worktree preserved at ${workspace}.`);
    return { taskId: task.task_id, runId, result };
  }
  for (const check of result.checks ?? []) {
    saveCommand(input.store, { directionId: input.directionId, taskId: task.task_id, runId, kind: "check",
      executable: check.executable, args: check.args, result: check.result, durationMs: 0 });
    const started = Date.now();
    const verified = await runProcess(workspace, check.executable, check.args, undefined, true,
      immediateStopFile(input.projectRoot));
    saveCommand(input.store, { directionId: input.directionId, taskId: task.task_id, runId, kind: "verification",
      executable: check.executable, args: check.args, result: verified, durationMs: Date.now() - started });
  }
  if (existsSync(immediateStopFile(input.projectRoot))) {
    input.store.db.prepare("UPDATE tasks SET state='cancelled',updated_at=? WHERE task_id=?")
      .run(researchNow(), task.task_id);
    input.store.appendEvent(input.directionId, task.task_id, "task.cancelled", "system", "STOP requested during verification");
    return { taskId: task.task_id, runId, result };
  }
  captureArtifacts(input.store, input.projectRoot, input.directionId, task.task_id, runId, workspace);
  input.store.db.prepare("UPDATE tasks SET state='awaiting_orchestrator',updated_at=? WHERE task_id=?")
    .run(researchNow(), task.task_id);
  input.store.appendEvent(input.directionId, task.task_id, "task.returned", "executor", result.finalText || "Executor returned without prose; inspect trace and artifacts.");
  return { taskId: task.task_id, runId, result };
}

export function antiHillClimbInvariantSource(): string {
  return [
    "No global research score or incumbent exists.",
    "No task is selected by metric ordering or automatic baseline advancement.",
    "Every claim chooses the evaluation method that answers its own question.",
    "Benchmarks are scoped evidence; negative and bounded results complete successfully.",
    "A delegated task must cite the recorded evidence it follows from once any evidence exists.",
    "A near-duplicate of an already-run task is refused unless it names the earlier task and the mechanism hypothesis that separates them.",
    "Study size is justified by the evidence the question requires, never by a fixed budget or a rule to start small.",
  ].join("\n");
}
