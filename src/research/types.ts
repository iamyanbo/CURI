export type DirectionStatus = "active" | "paused" | "completed";
export type SourceState = "discovered" | "retrieved" | "relevant" | "rejected" | "unreadable" | "needs_review";
export type TaskMode = "exploration" | "claim";
export type TaskState = "queued" | "running" | "awaiting_orchestrator" | "concluded" | "blocked" | "cancelled";
export type OutcomeVerdict = "supported" | "refuted" | "bounded" | "inconclusive" | "blocked";
export type RunRole = "watcher" | "orchestrator" | "executor" | "verifier" | "system";
export type RunState = "queued" | "active" | "waiting_external" | "succeeded" | "failed" | "cancelled";

export interface ResearchDirectionInput {
  id: string;
  title: string;
  briefMarkdown: string;
  constraintsMarkdown: string;
  domainPath: string;
}

export interface LeanDirection {
  direction_id: string;
  title: string;
  brief_md: string;
  constraints_md: string;
  domain_path: string;
  status: DirectionStatus;
  created_at: string;
  updated_at: string;
}

export interface LeanSource {
  source_id: string;
  direction_id: string;
  provider: string;
  canonical_url: string;
  title: string;
  published_at: string | null;
  raw_path: string | null;
  normalized_path: string | null;
  content_hash: string | null;
  state: SourceState;
  card_md: string | null;
  failure_md: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeanTask {
  task_id: string;
  direction_id: string;
  parent_task_id: string | null;
  component_id: string | null;
  program_id: string | null;
  mode: TaskMode;
  task_kind: string;
  brief_md: string;
  state: TaskState;
  workspace_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactProgram {
  program_id: string;
  direction_id: string;
  title: string;
  thesis_md: string;
  status: "active" | "paused" | "completed" | "abandoned";
  base_revision: string;
  current_revision: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchContext {
  direction: LeanDirection;
  components: Array<Record<string, unknown>>;
  componentRelations: Array<Record<string, unknown>>;
  sources: LeanSource[];
  tasks: LeanTask[];
  programs: ArtifactProgram[];
  programCheckpoints: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  syntheses: Array<Record<string, unknown>>;
  synthesisOutcomes: Array<Record<string, unknown>>;
  synthesisSources: Array<Record<string, unknown>>;
  synthesisComponents: Array<Record<string, unknown>>;
  synthesisReviews: Array<Record<string, unknown>>;
  watcherRequests: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}
