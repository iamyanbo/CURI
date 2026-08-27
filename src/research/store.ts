import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { briefSimilarity } from "./delegation.js";

import type {
  LeanDirection, LeanSource, LeanTask, OutcomeVerdict, ResearchContext,
  ResearchDirectionInput, RunRole, RunState, SourceState, TaskMode,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESEARCH_SCHEMA_VERSION = 9;

const V7_MIGRATION = `
ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'research';
UPDATE tasks SET task_kind=mode;
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
CREATE INDEX syntheses_direction ON component_syntheses(direction_id,component_id,created_at);
CREATE INDEX synthesis_reviews_revision ON synthesis_reviews(synthesis_id,created_at);
CREATE TRIGGER immutable_synthesis_update BEFORE UPDATE ON component_syntheses BEGIN
  SELECT RAISE(ABORT,'syntheses are append-only'); END;
CREATE TRIGGER immutable_synthesis_delete BEFORE DELETE ON component_syntheses BEGIN
  SELECT RAISE(ABORT,'syntheses are append-only'); END;
CREATE TRIGGER immutable_synthesis_review_update BEFORE UPDATE ON synthesis_reviews BEGIN
  SELECT RAISE(ABORT,'synthesis reviews are append-only'); END;
CREATE TRIGGER immutable_synthesis_review_delete BEFORE DELETE ON synthesis_reviews BEGIN
  SELECT RAISE(ABORT,'synthesis reviews are append-only'); END;
`;

const V8_MIGRATION = `
CREATE TABLE synthesis_components (
  synthesis_id TEXT NOT NULL REFERENCES component_syntheses(synthesis_id),
  component_id TEXT NOT NULL REFERENCES components(component_id),
  PRIMARY KEY(synthesis_id,component_id)
);
CREATE INDEX synthesis_components_component ON synthesis_components(component_id);
ALTER TABLE watcher_config ADD COLUMN max_read INTEGER NOT NULL DEFAULT 3;
`;

/**
 * A relationship between two components is a fact about the pair, not an event.
 * Without a uniqueness constraint the orchestrator re-recorded the same
 * relationship on every turn that still considered it true: one live direction
 * reached 44 rows describing 8 pairs, and the dashboard drew all 44, which is
 * why its graph became an unreadable tangle. The newest description of a pair
 * wins, because understanding of a relationship is meant to evolve.
 */
const V9_MIGRATION = `
DELETE FROM component_relations WHERE relation_id NOT IN (
  SELECT relation_id FROM (
    SELECT relation_id, ROW_NUMBER() OVER (
      PARTITION BY direction_id, from_component_id, to_component_id
      ORDER BY created_at DESC, relation_id DESC) rank
    FROM component_relations)
  WHERE rank = 1);
CREATE UNIQUE INDEX IF NOT EXISTS component_relations_pair
  ON component_relations(direction_id, from_component_id, to_component_id);
`;

/**
 * Daemons other than this process holding the database's directory open.
 *
 * A schema migration rewrites a database that running processes have already
 * opened with the previous version's code, and those processes fail the moment
 * they next open the store — a version bump applied under a live dashboard took
 * it to HTTP 500 with no warning. Migrating is therefore refused while anything
 * else is running. The current process is excluded: a daemon that has just
 * started is the one applying the migration, and it is running the new code.
 */
function otherLiveDaemons(databasePath: string): string[] {
  const dir = dirname(databasePath);
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return []; }
  const live: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    try {
      const pid = Number(readFileSync(join(dir, entry), "utf8").trim());
      if (!Number.isFinite(pid) || pid === process.pid) continue;
      process.kill(pid, 0);
      live.push(`${entry.replace(/[.]pid$/, "")} (pid ${pid})`);
    } catch { /* a stale pid file is not a live process */ }
  }
  return live;
}

export function researchNow(): string { return new Date().toISOString(); }
export function researchHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function researchId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const line = markdown.split(/\r?\n/).map((item) => item.trim())
    .find((item) => item.length > 0)?.replace(/^#+\s*/, "").trim();
  return (line || fallback).slice(0, 160);
}

export class ResearchStore {
  readonly db: Database.Database;

  private constructor(db: Database.Database) { this.db = db; }

  static open(path: string): ResearchStore {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_schema_meta'",
    ).get();
    if (!exists) {
      const sql = readFileSync(join(HERE, "schema.sql"), "utf8");
      db.exec(sql);
      db.prepare("INSERT INTO research_schema_meta(version,applied_at,checksum) VALUES (?,?,?)")
        .run(RESEARCH_SCHEMA_VERSION, researchNow(), researchHash(sql));
    }
    const version = Number((db.prepare("SELECT MAX(version) version FROM research_schema_meta").get() as { version: number }).version);
    // Migrations apply in sequence so a database several versions behind is
    // brought forward rather than rejected.
    let current = version;
    if (current !== RESEARCH_SCHEMA_VERSION) {
      const live = otherLiveDaemons(path);
      if (live.length > 0) {
        db.close();
        throw new Error(
          `refusing to migrate the research database from v${current} to v${RESEARCH_SCHEMA_VERSION} `
          + `while research is running: ${live.join(", ")}. Those processes are running the previous `
          + "version's code and would fail against a migrated database. Stop them first.");
      }
    }
    for (const step of [{ from: 6, to: 7, sql: V7_MIGRATION }, { from: 7, to: 8, sql: V8_MIGRATION },
      { from: 8, to: 9, sql: V9_MIGRATION }]) {
      if (current !== step.from) continue;
      db.pragma("wal_checkpoint(TRUNCATE)");
      const backup = `${path}.v${step.from}.bak`;
      if (!existsSync(backup)) copyFileSync(path, backup);
      db.transaction(() => {
        db.exec(step.sql);
        db.prepare("INSERT INTO research_schema_meta(version,applied_at,checksum) VALUES (?,?,?)")
          .run(step.to, researchNow(), researchHash(step.sql));
      })();
      current = step.to;
    }
    if (current !== RESEARCH_SCHEMA_VERSION) {
      db.close();
      throw new Error(`research database v${current} is not compatible with lean runtime v${RESEARCH_SCHEMA_VERSION}; archive it first`);
    }
    const store = new ResearchStore(db);
    store.backfillSynthesisComponents();
    return store;
  }

  close(): void { this.db.close(); }

  /**
   * Links syntheses recorded before component linking existed. Their component
   * references are already in the Markdown; this only makes them queryable.
   */
  backfillSynthesisComponents(): void {
    const pending = this.db.prepare(
      `SELECT synthesis_id,direction_id,body_md FROM component_syntheses
       WHERE synthesis_id NOT IN (SELECT synthesis_id FROM synthesis_components)`,
    ).all() as Array<{ synthesis_id: string; direction_id: string; body_md: string }>;
    if (pending.length === 0) return;
    const components = this.db.prepare("SELECT component_id,direction_id FROM components").all() as
      Array<{ component_id: string; direction_id: string }>;
    const link = this.db.prepare("INSERT OR IGNORE INTO synthesis_components(synthesis_id,component_id) VALUES (?,?)");
    this.db.transaction(() => {
      for (const synthesis of pending) {
        for (const component of components) {
          if (component.direction_id !== synthesis.direction_id) continue;
          if (synthesis.body_md.includes(component.component_id)) link.run(synthesis.synthesis_id, component.component_id);
        }
      }
    })();
  }

  transact<T>(fn: (store: ResearchStore) => T): T {
    return this.db.transaction(() => fn(this))();
  }

  createDirection(input: ResearchDirectionInput): LeanDirection {
    if (!input.id.trim() || !input.briefMarkdown.trim()) throw new Error("direction id and Markdown brief are required");
    const now = researchNow();
    this.db.prepare(
      `INSERT INTO directions(direction_id,title,brief_md,constraints_md,domain_path,status,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',?,?)`,
    ).run(input.id, input.title, input.briefMarkdown, input.constraintsMarkdown, input.domainPath, now, now);
    this.db.prepare(
      `INSERT INTO watcher_config(direction_id,enabled,interval_seconds,topics_md,feeds_md,updated_at)
       VALUES (?,1,3600,?,'',?)`,
    ).run(input.id, input.title, now);
    this.appendEvent(input.id, null, "direction.created", "human", input.briefMarkdown);
    return this.direction(input.id)!;
  }

  direction(id: string): LeanDirection | null {
    return (this.db.prepare("SELECT * FROM directions WHERE direction_id=?").get(id) as LeanDirection | undefined) ?? null;
  }

  latestDirectionId(): string | null {
    return (this.db.prepare("SELECT direction_id FROM directions ORDER BY updated_at DESC LIMIT 1")
      .get() as { direction_id: string } | undefined)?.direction_id ?? null;
  }

  appendEvent(directionId: string | null, taskId: string | null, eventType: string, actor: string, payloadMarkdown: string): string {
    const id = researchId("EV");
    this.db.prepare(
      "INSERT INTO events(event_id,direction_id,task_id,event_type,actor,payload_md,occurred_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, directionId, taskId, eventType, actor, payloadMarkdown, researchNow());
    return id;
  }

  beginRun(input: { directionId: string; taskId?: string | null; role: RunRole; inputMarkdown: string; attemptDir?: string }): string {
    const id = researchId("RUN");
    this.db.prepare(
      `INSERT INTO runs(run_id,direction_id,task_id,role,state,input_md,attempt_dir,started_at)
       VALUES (?,?,?,?,'active',?,?,?)`,
    ).run(id, input.directionId, input.taskId ?? null, input.role, input.inputMarkdown, input.attemptDir ?? null, researchNow());
    this.appendEvent(input.directionId, input.taskId ?? null, `${input.role}.started`, input.role, id);
    return id;
  }

  finishRun(input: {
    runId: string; state: RunState; outputMarkdown?: string; failure?: string | null;
    model?: string | null; provider?: string | null; inputTokens?: number; outputTokens?: number; costUsd?: number;
  }): void {
    const row = this.db.prepare("SELECT direction_id,task_id,role FROM runs WHERE run_id=?").get(input.runId) as
      { direction_id: string; task_id: string | null; role: string } | undefined;
    if (!row) throw new Error(`unknown run ${input.runId}`);
    this.db.prepare(
      `UPDATE runs SET state=?,output_md=?,failure=?,model=?,provider=?,input_tokens=?,output_tokens=?,cost_usd=?,completed_at=?
       WHERE run_id=?`,
    ).run(input.state, input.outputMarkdown ?? "", input.failure ?? null, input.model ?? null, input.provider ?? null,
      input.inputTokens ?? 0, input.outputTokens ?? 0, input.costUsd ?? 0, researchNow(), input.runId);
    this.appendEvent(row.direction_id, row.task_id, `${row.role}.${input.state}`, row.role,
      input.failure ?? input.outputMarkdown ?? "");
  }

  saveNote(directionId: string, runId: string | null, role: string, markdown: string): string {
    const id = researchId("NOTE");
    this.db.prepare("INSERT INTO notes(note_id,direction_id,run_id,role,body_md,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, directionId, runId, role, markdown, researchNow());
    return id;
  }

  addSource(input: { directionId: string; provider: string; url: string; title: string; publishedAt?: string | null }): string | null {
    const existing = this.db.prepare("SELECT source_id FROM sources WHERE direction_id=? AND canonical_url=?")
      .get(input.directionId, input.url) as { source_id: string } | undefined;
    if (existing) return null;
    const id = `SRC-${researchHash(`${input.directionId}\n${input.url}`).slice(0, 16)}`;
    const now = researchNow();
    this.db.prepare(
      `INSERT INTO sources(source_id,direction_id,provider,canonical_url,title,published_at,state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'discovered',?,?)`,
    ).run(id, input.directionId, input.provider, input.url, input.title, input.publishedAt ?? null, now, now);
    this.appendEvent(input.directionId, null, "source.discovered", "watcher", `${input.title}\n${input.url}`);
    return id;
  }

  markSourceRetrieved(input: { sourceId: string; rawPath: string; normalizedPath: string; contentHash: string }): void {
    this.db.prepare(
      "UPDATE sources SET state='retrieved',raw_path=?,normalized_path=?,content_hash=?,failure_md=NULL,updated_at=? WHERE source_id=?",
    ).run(input.rawPath, input.normalizedPath, input.contentHash, researchNow(), input.sourceId);
  }

  reviewSource(sourceId: string, state: Extract<SourceState, "relevant" | "rejected" | "unreadable" | "needs_review">,
    markdown: string): void {
    const row = this.db.prepare("SELECT direction_id FROM sources WHERE source_id=?").get(sourceId) as
      { direction_id: string } | undefined;
    if (!row) throw new Error(`unknown source ${sourceId}`);
    const card = state === "relevant" || state === "needs_review" ? markdown : null;
    const failure = state === "rejected" || state === "unreadable" ? markdown : null;
    this.db.prepare("UPDATE sources SET state=?,card_md=?,failure_md=?,updated_at=? WHERE source_id=?")
      .run(state, card, failure, researchNow(), sourceId);
    this.appendEvent(row.direction_id, null, `source.${state}`, "watcher", markdown);
  }

  createComponent(directionId: string, markdown: string): string | null {
    // A thread that already exists does not need opening again. Without this a
    // near-copy of an existing component could be created every turn, and since
    // component.created counts as progress it would keep the loop awake while
    // adding nothing to the map. The threshold is high: only a near-duplicate is
    // refused, because opening a genuinely new thread is exactly what this
    // action is for.
    const existing = this.db.prepare("SELECT title, description_md FROM components WHERE direction_id=?")
      .all(directionId) as Array<{ title: string; description_md: string }>;
    // Too little text to judge: a two-word description matches every other
    // two-word description, which would refuse the second component a direction
    // ever opens.
    const wordCount = (markdown.match(/[a-z][a-z0-9-]{3,}/gi) ?? []).length;
    if (wordCount >= 12) {
      for (const item of existing) {
        if (briefSimilarity(markdown, `${item.title}
${item.description_md ?? ""}`) >= 0.75) return null;
      }
    }
    const id = researchId("COMP");
    const now = researchNow();
    this.db.prepare(
      "INSERT INTO components(component_id,direction_id,title,description_md,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)",
    ).run(id, directionId, titleFromMarkdown(markdown, "Research component"), markdown, now, now);
    this.appendEvent(directionId, null, "component.created", "orchestrator", markdown);
    return id;
  }

  /**
   * Records a directed relationship between two existing components. The schema
   * has always carried these, but no agent action could create one, so the
   * component view could only ever be a flat list of threads.
   */
  relateComponents(directionId: string, markdown: string): string | null {
    const mentioned = [...new Set(markdown.match(/COMP-[0-9a-f-]{6,}/gi) ?? [])];
    const known = mentioned.filter((id) => this.db.prepare(
      "SELECT 1 FROM components WHERE component_id=? AND direction_id=?").get(id, directionId));
    if (known.length < 2) return null;
    const [from, to] = known;
    // Re-recording a relationship updates its description rather than adding a
    // second edge: the pair is the identity, and the latest account of it is the
    // one worth showing.
    const existing = this.db.prepare(
      `SELECT relation_id, relationship_md FROM component_relations
       WHERE direction_id=? AND from_component_id=? AND to_component_id=?`,
    ).get(directionId, from, to) as { relation_id: string; relationship_md: string } | undefined;
    // Re-stating a relationship that already says the same thing is not a
    // change. It used to update the row and append an event anyway, and because
    // the event counts as progress it reset the idle backoff — so an
    // orchestrator with nothing new to say could restate the same relationships
    // every minute indefinitely, each time at the price of a full turn.
    // The threshold matches the one for syntheses rather than the one for task
    // briefs: re-describing a relationship keeps the claim and changes the
    // wording, so a near-copy check tuned for duplicated studies never fires.
    if (existing && briefSimilarity(markdown, String(existing.relationship_md ?? "")) >= 0.5) return null;
    const id = existing?.relation_id ?? researchId("REL");
    this.db.prepare(
      `INSERT INTO component_relations(relation_id,direction_id,from_component_id,to_component_id,relationship_md,created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(direction_id,from_component_id,to_component_id)
       DO UPDATE SET relationship_md=excluded.relationship_md, created_at=excluded.created_at`,
    ).run(id, directionId, from, to, markdown, researchNow());
    this.appendEvent(directionId, null, "component.related", "orchestrator", markdown);
    return id;
  }

  requestWatch(directionId: string, markdown: string): string {
    const id = researchId("WATCH");
    this.db.prepare("INSERT INTO watcher_requests(request_id,direction_id,question_md,state,created_at) VALUES (?,?,?,'queued',?)")
      .run(id, directionId, markdown, researchNow());
    this.appendEvent(directionId, null, "watcher.requested", "orchestrator", markdown);
    return id;
  }

  delegateTask(input: { directionId: string; mode: TaskMode; markdown: string; parentTaskId?: string | null }): string {
    if (!input.markdown.trim()) throw new Error("experiment Markdown is empty");
    const mentionedComponent = input.markdown.match(/\bCOMP-[0-9a-f-]{8,}\b/i)?.[0] ?? null;
    const component = mentionedComponent && this.db.prepare(
      "SELECT 1 FROM components WHERE component_id=? AND direction_id=?",
    ).get(mentionedComponent, input.directionId) ? mentionedComponent : null;
    const id = researchId("TASK");
    const now = researchNow();
    this.transact((store) => {
      store.db.prepare(
        `INSERT INTO tasks(task_id,direction_id,parent_task_id,component_id,mode,task_kind,brief_md,state,created_at,updated_at)
         VALUES (?,?,?,?,?,'research',?,'queued',?,?)`,
      ).run(id, input.directionId, input.parentTaskId ?? null, component, input.mode, input.markdown, now, now);
      const known = store.db.prepare("SELECT source_id FROM sources WHERE direction_id=?").all(input.directionId) as
        Array<{ source_id: string }>;
      for (const { source_id } of known) if (input.markdown.includes(source_id)) {
        store.db.prepare("INSERT OR IGNORE INTO task_sources(task_id,source_id) VALUES (?,?)").run(id, source_id);
      }
      store.appendEvent(input.directionId, id, "task.delegated", "orchestrator", input.markdown);
    });
    return id;
  }

  recordOutcome(input: { directionId: string; taskId: string; runId?: string | null; verdict: OutcomeVerdict; markdown: string }): string {
    const id = researchId("OUT");
    this.transact((store) => {
      const task = store.db.prepare("SELECT state FROM tasks WHERE task_id=? AND direction_id=?")
        .get(input.taskId, input.directionId) as { state: string } | undefined;
      if (!task) throw new Error(`unknown task ${input.taskId}`);
      store.db.prepare(
        "INSERT INTO outcomes(outcome_id,direction_id,task_id,run_id,verdict,report_md,created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(id, input.directionId, input.taskId, input.runId ?? null, input.verdict, input.markdown, researchNow());
      store.db.prepare("UPDATE tasks SET state=?,updated_at=? WHERE task_id=?")
        .run(input.verdict === "blocked" ? "blocked" : "concluded", researchNow(), input.taskId);
      store.appendEvent(input.directionId, input.taskId, `outcome.${input.verdict}`, "orchestrator", input.markdown);
    });
    return id;
  }

  recordSynthesis(input: { directionId: string; runId?: string | null; markdown: string }): string {
    if (!input.markdown.trim()) throw new Error("synthesis Markdown is empty");
    const components = this.db.prepare("SELECT component_id FROM components WHERE direction_id=?")
      .all(input.directionId) as Array<{ component_id: string }>;
    const outcomes = this.db.prepare("SELECT outcome_id,task_id FROM outcomes WHERE direction_id=?")
      .all(input.directionId) as Array<{ outcome_id: string; task_id: string }>;
    const sources = this.db.prepare("SELECT source_id FROM sources WHERE direction_id=?")
      .all(input.directionId) as Array<{ source_id: string }>;
    const citedOutcomes = outcomes.filter((item) => input.markdown.includes(item.outcome_id));
    const citedSources = sources.filter((item) => input.markdown.includes(item.source_id));
    const explicitComponents = components.filter((item) => input.markdown.includes(item.component_id));
    const inferredComponents = citedOutcomes.flatMap((item) => {
      const row = this.db.prepare("SELECT component_id FROM tasks WHERE task_id=?").get(item.task_id) as
        { component_id: string | null } | undefined;
      return row?.component_id ? [row.component_id] : [];
    });
    if (input.runId) {
      const sameTurn = this.db.prepare(
        `SELECT t.component_id FROM outcomes o JOIN tasks t ON t.task_id=o.task_id
         WHERE o.direction_id=? AND o.run_id=? AND t.component_id IS NOT NULL ORDER BY o.created_at DESC LIMIT 1`,
      ).get(input.directionId, input.runId) as { component_id: string } | undefined;
      if (sameTurn) inferredComponents.push(sameTurn.component_id);
    }
    const candidates = [...new Set([...explicitComponents.map((item) => item.component_id), ...inferredComponents])];
    // A synthesis that spans several components is the normal shape of an
    // accumulating understanding, not an error. The scalar column keeps its old
    // meaning — a single owning component, or none — while every cited component
    // is linked, so cross-component work appears under each thread it informs
    // instead of vanishing to direction level.
    const componentId = candidates.length === 1 ? candidates[0]! : null;
    const prior = this.db.prepare(
      `SELECT synthesis_id FROM component_syntheses WHERE direction_id=? AND component_id IS ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(input.directionId, componentId) as { synthesis_id: string } | undefined;
    const id = researchId("SYN");
    this.transact((store) => {
      store.db.prepare(
        `INSERT INTO component_syntheses(synthesis_id,direction_id,component_id,run_id,supersedes_synthesis_id,body_md,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(id, input.directionId, componentId, input.runId ?? null, prior?.synthesis_id ?? null,
        input.markdown, researchNow());
      for (const outcome of citedOutcomes) store.db.prepare(
        "INSERT INTO synthesis_outcomes(synthesis_id,outcome_id) VALUES (?,?)",
      ).run(id, outcome.outcome_id);
      for (const source of citedSources) store.db.prepare(
        "INSERT INTO synthesis_sources(synthesis_id,source_id) VALUES (?,?)",
      ).run(id, source.source_id);
      for (const component of candidates) store.db.prepare(
        "INSERT OR IGNORE INTO synthesis_components(synthesis_id,component_id) VALUES (?,?)",
      ).run(id, component);
      store.appendEvent(input.directionId, null, "synthesis.recorded", "orchestrator", `${id}\n${input.markdown}`);
    });
    return id;
  }

  reviewSynthesis(input: { synthesisId: string; verdict: "accepted" | "needs_evidence" | "rejected"; noteMarkdown: string }): string {
    const synthesis = this.db.prepare("SELECT direction_id FROM component_syntheses WHERE synthesis_id=?")
      .get(input.synthesisId) as { direction_id: string } | undefined;
    if (!synthesis) throw new Error(`unknown synthesis ${input.synthesisId}`);
    const id = researchId("REV");
    const note = input.noteMarkdown.trim() || `${input.verdict} by human review`;
    this.transact((store) => {
      store.db.prepare(
        "INSERT INTO synthesis_reviews(review_id,synthesis_id,verdict,note_md,actor,created_at) VALUES (?,?,?,?, 'human',?)",
      ).run(id, input.synthesisId, input.verdict, note, researchNow());
      store.appendEvent(synthesis.direction_id, null, `synthesis.${input.verdict}`, "human",
        `${input.synthesisId}\n${note}`);
    });
    return id;
  }

  context(directionId: string): ResearchContext {
    const direction = this.direction(directionId);
    if (!direction) throw new Error(`unknown direction ${directionId}`);
    const all = <T>(sql: string, ...args: unknown[]) => this.db.prepare(sql).all(...args) as T[];
    return {
      direction,
      components: all("SELECT * FROM components WHERE direction_id=? ORDER BY created_at", directionId),
      componentRelations: all("SELECT * FROM component_relations WHERE direction_id=? ORDER BY created_at", directionId),
      sources: all<LeanSource>("SELECT * FROM sources WHERE direction_id=? ORDER BY updated_at DESC", directionId),
      tasks: all<LeanTask>("SELECT * FROM tasks WHERE direction_id=? ORDER BY created_at DESC", directionId),
      outcomes: all("SELECT * FROM outcomes WHERE direction_id=? ORDER BY created_at DESC", directionId),
      runs: all("SELECT * FROM runs WHERE direction_id=? ORDER BY started_at DESC LIMIT 200", directionId),
      commands: all("SELECT * FROM commands WHERE direction_id=? ORDER BY created_at DESC LIMIT 200", directionId),
      artifacts: all("SELECT * FROM artifacts WHERE direction_id=? ORDER BY created_at DESC LIMIT 200", directionId),
      notes: all("SELECT * FROM notes WHERE direction_id=? ORDER BY created_at DESC LIMIT 100", directionId),
      syntheses: all("SELECT * FROM component_syntheses WHERE direction_id=? ORDER BY created_at DESC", directionId),
      synthesisOutcomes: all(
        `SELECT so.* FROM synthesis_outcomes so JOIN component_syntheses s ON s.synthesis_id=so.synthesis_id
         WHERE s.direction_id=?`, directionId),
      synthesisSources: all(
        `SELECT ss.* FROM synthesis_sources ss JOIN component_syntheses s ON s.synthesis_id=ss.synthesis_id
         WHERE s.direction_id=?`, directionId),
      synthesisComponents: all(
        `SELECT sc.* FROM synthesis_components sc JOIN component_syntheses s ON s.synthesis_id=sc.synthesis_id
         WHERE s.direction_id=?`, directionId),
      synthesisReviews: all(
        `SELECT sr.* FROM synthesis_reviews sr JOIN component_syntheses s ON s.synthesis_id=sr.synthesis_id
         WHERE s.direction_id=? ORDER BY sr.created_at DESC`, directionId),
      watcherRequests: all("SELECT * FROM watcher_requests WHERE direction_id=? ORDER BY created_at DESC", directionId),
      events: all("SELECT * FROM events WHERE direction_id=? ORDER BY seq DESC LIMIT 500", directionId),
    };
  }
}
