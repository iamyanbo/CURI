PRAGMA foreign_keys = ON;

CREATE TABLE research_schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE directions (
  direction_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief_md TEXT NOT NULL,
  constraints_md TEXT NOT NULL,
  domain_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE components (
  component_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  title TEXT NOT NULL,
  description_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE component_relations (
  relation_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  from_component_id TEXT NOT NULL REFERENCES components(component_id),
  to_component_id TEXT NOT NULL REFERENCES components(component_id),
  relationship_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  provider TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  raw_path TEXT,
  normalized_path TEXT,
  content_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('discovered','retrieved','relevant','rejected','unreadable','needs_review')),
  card_md TEXT,
  failure_md TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(direction_id,canonical_url)
);

CREATE TABLE watcher_requests (
  request_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  question_md TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE watcher_config (
  direction_id TEXT PRIMARY KEY REFERENCES directions(direction_id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  interval_seconds INTEGER NOT NULL DEFAULT 3600,
  topics_md TEXT NOT NULL,
  feeds_md TEXT NOT NULL DEFAULT '',
  max_read INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT NOT NULL
);

CREATE TABLE watcher_cursors (
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  provider TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  next_retry_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(direction_id,provider,query_hash)
);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  parent_task_id TEXT REFERENCES tasks(task_id),
  component_id TEXT REFERENCES components(component_id),
  mode TEXT NOT NULL CHECK(mode IN ('exploration','claim')),
  task_kind TEXT NOT NULL DEFAULT 'research',
  brief_md TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','awaiting_orchestrator','concluded','blocked','cancelled')),
  workspace_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_live_task_per_direction ON tasks(direction_id)
WHERE state IN ('queued','running');

CREATE TABLE task_sources (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  PRIMARY KEY(task_id,source_id)
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  task_id TEXT REFERENCES tasks(task_id),
  role TEXT NOT NULL CHECK(role IN ('watcher','orchestrator','executor','verifier','system')),
  state TEXT NOT NULL CHECK(state IN ('queued','active','waiting_external','succeeded','failed','cancelled')),
  input_md TEXT NOT NULL,
  output_md TEXT NOT NULL DEFAULT '',
  failure TEXT,
  model TEXT,
  provider TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  attempt_dir TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  kind TEXT NOT NULL CHECK(kind IN ('check','verification')),
  executable TEXT NOT NULL,
  args_json TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outcomes (
  outcome_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  run_id TEXT REFERENCES runs(run_id),
  verdict TEXT NOT NULL CHECK(verdict IN ('supported','refuted','bounded','inconclusive','blocked')),
  report_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  note_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  run_id TEXT REFERENCES runs(run_id),
  role TEXT NOT NULL,
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE component_syntheses (
  synthesis_id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES directions(direction_id),
  component_id TEXT REFERENCES components(component_id),
  run_id TEXT REFERENCES runs(run_id),
  supersedes_synthesis_id TEXT REFERENCES component_syntheses(synthesis_id),
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE synthesis_outcomes (
  synthesis_id TEXT NOT NULL REFERENCES component_syntheses(synthesis_id),
  outcome_id TEXT NOT NULL REFERENCES outcomes(outcome_id),
  PRIMARY KEY(synthesis_id,outcome_id)
);

CREATE TABLE synthesis_components (
  synthesis_id TEXT NOT NULL REFERENCES component_syntheses(synthesis_id),
  component_id TEXT NOT NULL REFERENCES components(component_id),
  PRIMARY KEY(synthesis_id,component_id)
);

CREATE INDEX synthesis_components_component ON synthesis_components(component_id);

CREATE TABLE synthesis_sources (
  synthesis_id TEXT NOT NULL REFERENCES component_syntheses(synthesis_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  PRIMARY KEY(synthesis_id,source_id)
);

CREATE TABLE synthesis_reviews (
  review_id TEXT PRIMARY KEY,
  synthesis_id TEXT NOT NULL REFERENCES component_syntheses(synthesis_id),
  verdict TEXT NOT NULL CHECK(verdict IN ('accepted','needs_evidence','rejected')),
  note_md TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  direction_id TEXT,
  task_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_md TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX sources_queue ON sources(direction_id,state,created_at);
CREATE INDEX tasks_direction ON tasks(direction_id,state,created_at);
CREATE INDEX runs_direction ON runs(direction_id,state,started_at);
CREATE INDEX events_direction ON events(direction_id,seq);
CREATE INDEX syntheses_direction ON component_syntheses(direction_id,component_id,created_at);
CREATE INDEX synthesis_reviews_revision ON synthesis_reviews(synthesis_id,created_at);

CREATE TRIGGER immutable_event_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT,'events are append-only'); END;
CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT,'events are append-only'); END;
CREATE TRIGGER immutable_task_brief BEFORE UPDATE ON tasks
WHEN NEW.brief_md<>OLD.brief_md OR NEW.mode<>OLD.mode BEGIN
  SELECT RAISE(ABORT,'task briefs are append-only; create a follow-up task'); END;
CREATE TRIGGER immutable_outcome_update BEFORE UPDATE ON outcomes BEGIN
  SELECT RAISE(ABORT,'outcomes are append-only'); END;
CREATE TRIGGER immutable_outcome_delete BEFORE DELETE ON outcomes BEGIN
  SELECT RAISE(ABORT,'outcomes are append-only'); END;
CREATE TRIGGER immutable_artifact_update BEFORE UPDATE ON artifacts BEGIN
  SELECT RAISE(ABORT,'artifacts are append-only'); END;
CREATE TRIGGER immutable_artifact_delete BEFORE DELETE ON artifacts BEGIN
  SELECT RAISE(ABORT,'artifacts are append-only'); END;
CREATE TRIGGER immutable_synthesis_update BEFORE UPDATE ON component_syntheses BEGIN
  SELECT RAISE(ABORT,'syntheses are append-only'); END;
CREATE TRIGGER immutable_synthesis_delete BEFORE DELETE ON component_syntheses BEGIN
  SELECT RAISE(ABORT,'syntheses are append-only'); END;
CREATE TRIGGER immutable_synthesis_review_update BEFORE UPDATE ON synthesis_reviews BEGIN
  SELECT RAISE(ABORT,'synthesis reviews are append-only'); END;
CREATE TRIGGER immutable_synthesis_review_delete BEFORE DELETE ON synthesis_reviews BEGIN
  SELECT RAISE(ABORT,'synthesis reviews are append-only'); END;
