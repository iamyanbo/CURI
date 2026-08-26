-- Adversarial Autoresearch v0 local schema.
-- 14 tables. Reduced from 03's 25 for the single-user local case.

CREATE TABLE campaigns (
  campaign_id   TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  objective     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('draft','ready','running','paused','stopped','completed','failed')),
  base_revision TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  config_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  stop_reason   TEXT
);

CREATE TABLE principles (
  principles_id TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(campaign_id),
  revision      INTEGER NOT NULL CHECK (revision > 0),
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(campaign_id, revision)
);

CREATE TABLE hypotheses (
  hypothesis_id   TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(campaign_id),
  principles_id   TEXT NOT NULL REFERENCES principles(principles_id),
  lane            TEXT NOT NULL CHECK (lane IN (__LANES__)),
  title           TEXT NOT NULL,
  mechanism       TEXT NOT NULL,
  motivation      TEXT NOT NULL,
  falsifier       TEXT NOT NULL,
  change_class    TEXT NOT NULL CHECK (change_class IN
                    ('mechanism','architecture','algorithm','data','evaluation','parameter','replication')),
  status          TEXT NOT NULL CHECK (status IN
                    ('proposed','tested','provisionally_supported','replicated','externally_validated',
                     'refuted','inconclusive','implementation_invalid','shortcut_suspected','abandoned')),
  belief_advisory REAL CHECK (belief_advisory IS NULL OR (belief_advisory BETWEEN 0.0 AND 1.0)),
  belief_derived  REAL CHECK (belief_derived  IS NULL OR (belief_derived  BETWEEN 0.0 AND 1.0)),
  -- Multi-step ideas: a moonshot may spend `steps_allowed` cycles developing,
  -- and an intermediate regression does not refute it. `step_index` is which
  -- step this row is; `parent_step_id` chains them.
  steps_allowed   INTEGER NOT NULL DEFAULT 1 CHECK (steps_allowed BETWEEN 1 AND 5),
  step_index      INTEGER NOT NULL DEFAULT 1 CHECK (step_index >= 1),
  parent_step_id  TEXT REFERENCES hypotheses(hypothesis_id),
  revision        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE contracts (
  contract_id          TEXT PRIMARY KEY,
  hypothesis_id        TEXT NOT NULL REFERENCES hypotheses(hypothesis_id),
  revision             INTEGER NOT NULL CHECK (revision > 0),
  status               TEXT NOT NULL CHECK (status IN ('registered','superseded','cancelled')),
  primary_metric       TEXT NOT NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('minimize','maximize','target')),
  baseline_hash        TEXT NOT NULL,
  dataset_hash         TEXT NOT NULL,
  split_hash           TEXT NOT NULL,
  evaluator_hash       TEXT NOT NULL,
  seed_policy_json     TEXT NOT NULL,
  threshold_json       TEXT NOT NULL,
  budget_json          TEXT NOT NULL,
  refutation_json      TEXT NOT NULL,
  shortcut_checks_json TEXT NOT NULL,
  contract_hash        TEXT NOT NULL UNIQUE,
  registered_at        TEXT NOT NULL,
  UNIQUE(hypothesis_id, revision)
);

CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(campaign_id),
  hypothesis_id   TEXT REFERENCES hypotheses(hypothesis_id),
  contract_id     TEXT REFERENCES contracts(contract_id),
  kind            TEXT NOT NULL CHECK (kind IN
                    ('manager','executor','compute','evaluation','replay','report')),
  state           TEXT NOT NULL CHECK (state IN
                    ('queued','active','succeeded','failed','cancelled','exhausted')),
  max_attempts    INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  terminal_at     TEXT
);

CREATE TABLE attempts (
  attempt_id       TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(run_id),
  attempt_no       INTEGER NOT NULL CHECK (attempt_no > 0),
  state            TEXT NOT NULL CHECK (state IN
                     ('planned','starting','running','sealed','succeeded','failed',
                      'cancelled','lost','quarantined')),
  pid              INTEGER,
  process_start_id TEXT,
  spawn_nonce      TEXT NOT NULL UNIQUE,
  input_hash       TEXT NOT NULL,
  model_spec_json  TEXT,
  exit_code        INTEGER,
  failure_code     TEXT,
  started_at       TEXT,
  completed_at     TEXT,
  UNIQUE(run_id, attempt_no)
);

CREATE TABLE artifacts (
  artifact_id   TEXT PRIMARY KEY,
  artifact_hash TEXT NOT NULL,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(campaign_id),
  attempt_id    TEXT NOT NULL REFERENCES attempts(attempt_id),
  kind          TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  byte_length   INTEGER NOT NULL CHECK (byte_length >= 0),
  manifest_json TEXT NOT NULL,
  sealed_at     TEXT NOT NULL,
  UNIQUE(attempt_id, kind, artifact_hash)
);

CREATE TABLE evaluations (
  evaluation_id    TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES campaigns(campaign_id),
  attempt_id       TEXT NOT NULL REFERENCES attempts(attempt_id),
  contract_id      TEXT NOT NULL REFERENCES contracts(contract_id),
  candidate_hash   TEXT NOT NULL,
  evaluator_hash   TEXT NOT NULL,
  environment_hash TEXT NOT NULL,
  result_json      TEXT NOT NULL,
  result_hash      TEXT NOT NULL,
  primary_value    REAL,
  baseline_value   REAL,
  passed_primary   INTEGER NOT NULL CHECK (passed_primary  IN (0,1)),
  passed_replay    INTEGER NOT NULL CHECK (passed_replay   IN (0,1)),
  passed_leakage   INTEGER NOT NULL CHECK (passed_leakage  IN (0,1)),
  passed_shortcut  INTEGER NOT NULL CHECK (passed_shortcut IN (0,1)),
  accepted_at      TEXT NOT NULL,
  UNIQUE(attempt_id, result_hash)
);

CREATE TABLE sources (
  source_id       TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(campaign_id),
  provider        TEXT NOT NULL,
  canonical_url   TEXT NOT NULL,
  title           TEXT,
  retrieved_at    TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  raw_artifact_id TEXT REFERENCES artifacts(artifact_id),
  source_class    TEXT NOT NULL,
  reliability     TEXT NOT NULL CHECK (reliability IN ('primary','secondary','lead')),
  metadata_json   TEXT NOT NULL,
  UNIQUE(campaign_id, canonical_url, content_hash)
);

CREATE TABLE evidence (
  evidence_id   TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(campaign_id),
  hypothesis_id TEXT REFERENCES hypotheses(hypothesis_id),
  attempt_id    TEXT REFERENCES attempts(attempt_id),
  evaluation_id TEXT REFERENCES evaluations(evaluation_id),
  source_id     TEXT REFERENCES sources(source_id),
  artifact_id   TEXT REFERENCES artifacts(artifact_id),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('metric','counterexample','replication','provenance','leakage',
                   'shortcut','negative_result','observation')),
  polarity      TEXT NOT NULL CHECK (polarity IN ('supports','weakens','refutes','neutral')),
  statement     TEXT NOT NULL,
  strength_rule TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('proposed','verified','rejected','superseded')),
  created_at    TEXT NOT NULL
);

CREATE TABLE budgets (
  campaign_id    TEXT NOT NULL REFERENCES campaigns(campaign_id),
  lane           TEXT NOT NULL CHECK (lane IN (__LANES__)),
  category       TEXT NOT NULL CHECK (category IN
                   ('runs','model_tokens','model_cost_usd','compute_seconds','wall_seconds')),
  allocated      REAL NOT NULL CHECK (allocated >= 0),
  consumed       REAL NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  reserved_floor REAL NOT NULL DEFAULT 0 CHECK (reserved_floor >= 0),
  PRIMARY KEY (campaign_id, lane, category)
);

CREATE TABLE human_interventions (
  intervention_id  TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES campaigns(campaign_id),
  kind             TEXT NOT NULL CHECK (kind IN
                     ('start','pause','resume','stop','scope_change','budget_change',
                      'config_change','manual_fix','hint','approval','restart')),
  changed_frontier INTEGER NOT NULL DEFAULT 0 CHECK (changed_frontier IN (0,1)),
  detail           TEXT NOT NULL,
  occurred_at      TEXT NOT NULL
);

CREATE TABLE events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT NOT NULL UNIQUE,
  occurred_at        TEXT NOT NULL,
  recorded_at        TEXT NOT NULL,
  campaign_id        TEXT REFERENCES campaigns(campaign_id),
  aggregate_kind     TEXT NOT NULL,
  aggregate_id       TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
  event_type         TEXT NOT NULL,
  actor_kind         TEXT NOT NULL CHECK (actor_kind IN
                       ('supervisor','manager','executor','compute','evaluator','human','system')),
  attempt_id         TEXT REFERENCES attempts(attempt_id),
  idempotency_key    TEXT NOT NULL UNIQUE,
  payload_json       TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  prev_chain_hash    TEXT,
  chain_hash         TEXT NOT NULL UNIQUE,
  schema_version     INTEGER NOT NULL
);

-- Continuous watcher configuration and campaign-local links into the
-- user-level global memory database. Global IDs intentionally have no foreign
-- key here because they belong to a separate portable SQLite store.
CREATE TABLE watcher_subscriptions (
  campaign_id        TEXT PRIMARY KEY REFERENCES campaigns(campaign_id),
  enabled            INTEGER NOT NULL CHECK (enabled IN (0,1)),
  interval_seconds   INTEGER NOT NULL CHECK (interval_seconds >= 30),
  topics_json        TEXT NOT NULL,
  feeds_json         TEXT NOT NULL,
  query_strategy_json TEXT NOT NULL,
  next_sweep_at      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE TABLE watcher_cursors (
  campaign_id      TEXT NOT NULL REFERENCES campaigns(campaign_id),
  provider         TEXT NOT NULL,
  query_hash       TEXT NOT NULL,
  query_text       TEXT NOT NULL,
  cursor_json      TEXT NOT NULL,
  watermark_at     TEXT,
  etag             TEXT,
  last_success_at  TEXT,
  last_error       TEXT,
  next_retry_at    TEXT,
  PRIMARY KEY (campaign_id, provider, query_hash)
);
CREATE TABLE campaign_memory_links (
  campaign_id    TEXT NOT NULL REFERENCES campaigns(campaign_id),
  memory_kind    TEXT NOT NULL CHECK (memory_kind IN ('source','mechanism','idea','code_inventory')),
  memory_id      TEXT NOT NULL,
  relevance      REAL NOT NULL DEFAULT 0 CHECK (relevance BETWEEN 0 AND 1),
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  PRIMARY KEY (campaign_id, memory_kind, memory_id)
);
CREATE TABLE idea_cards (
  idea_id               TEXT PRIMARY KEY,
  campaign_id           TEXT NOT NULL REFERENCES campaigns(campaign_id),
  mechanism_id          TEXT,
  action                TEXT NOT NULL CHECK (action IN ('adopt','adapt','combine','verify','investigate')),
  title                 TEXT NOT NULL,
  target_domain         TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  scores_json           TEXT NOT NULL,
  code_status           TEXT NOT NULL CHECK (code_status IN ('absent','present','partial','unknown')),
  assumptions_json      TEXT NOT NULL,
  experiment_json       TEXT NOT NULL,
  macro_implications    TEXT NOT NULL,
  source_ids_json       TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('new','reviewed','accepted','rejected','scheduled','tested')),
  signal_reason         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  reviewed_at           TEXT
);
CREATE TABLE memory_retrievals (
  retrieval_id    TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(campaign_id),
  attempt_id      TEXT REFERENCES attempts(attempt_id),
  role            TEXT NOT NULL CHECK (role IN ('architect','manager','executor','watcher','human')),
  query_text      TEXT NOT NULL,
  filters_json    TEXT NOT NULL,
  result_ids_json TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE TABLE attention_steers (
  steer_id         TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES campaigns(campaign_id),
  scope             TEXT NOT NULL CHECK (scope IN ('micro','macro','watcher','all')),
  text              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  consumed_at       TEXT,
  expires_program_revision INTEGER
);
CREATE TABLE campaign_source_enrichments (
  campaign_id       TEXT NOT NULL REFERENCES campaigns(campaign_id),
  source_version_id TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','waiting_external')),
  model             TEXT,
  prompt_hash       TEXT,
  last_error        TEXT,
  attempted_at      TEXT NOT NULL,
  completed_at      TEXT,
  PRIMARY KEY (campaign_id, source_version_id)
);
CREATE INDEX idx_campaign_enrichment_status
  ON campaign_source_enrichments(campaign_id, status, attempted_at);

CREATE TABLE intervals (
  interval_id   TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(campaign_id),
  attempt_id    TEXT REFERENCES attempts(attempt_id),
  resource_id   TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN
                  ('model_reasoning','tool_execution','compute','evaluation','queue',
                   'blocked','sleep','supervisor','human','unknown')),
  started_ms    INTEGER NOT NULL,
  ended_ms      INTEGER,
  metadata_json TEXT NOT NULL,
  CHECK (ended_ms IS NULL OR ended_ms >= started_ms)
);

CREATE INDEX idx_runs_sched      ON runs(campaign_id, state, created_at);
CREATE INDEX idx_attempts_state  ON attempts(state, started_at);
CREATE INDEX idx_intervals_res   ON intervals(campaign_id, resource_id, started_ms);
CREATE INDEX idx_evidence_hyp    ON evidence(hypothesis_id, status, kind);
CREATE INDEX idx_events_seq      ON events(campaign_id, seq);
CREATE INDEX idx_hyp_lane        ON hypotheses(campaign_id, lane, status);
CREATE INDEX idx_ideas_signal     ON idea_cards(campaign_id, state, created_at);
CREATE INDEX idx_memory_links     ON campaign_memory_links(campaign_id, relevance DESC, last_seen_at DESC);
CREATE INDEX idx_retrieval_attempt ON memory_retrievals(attempt_id, created_at);
