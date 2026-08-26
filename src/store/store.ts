/**
 * Canonical state store. Single writer, SQLite, WAL.
 *
 * Two things in here are load-bearing and everything else is bookkeeping:
 *
 *  1. `appendEvent` maintains a hash chain over the whole event log, so a
 *     truncated or tampered tail is detectable. Nothing else in the system is
 *     allowed to write `events`.
 *  2. `transact` is the only way to mutate state. It wraps BEGIN IMMEDIATE and
 *     performs no I/O beyond SQLite — no spawns, no network, no callbacks.
 */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = 3;
const ZERO_HASH = "0".repeat(64);

function campaignMemoryMigrationV2(): string {
  return `
    CREATE TABLE IF NOT EXISTS watcher_subscriptions (
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
    CREATE TABLE IF NOT EXISTS watcher_cursors (
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
    CREATE TABLE IF NOT EXISTS campaign_memory_links (
      campaign_id    TEXT NOT NULL REFERENCES campaigns(campaign_id),
      memory_kind    TEXT NOT NULL CHECK (memory_kind IN ('source','mechanism','idea','code_inventory')),
      memory_id      TEXT NOT NULL,
      relevance      REAL NOT NULL DEFAULT 0 CHECK (relevance BETWEEN 0 AND 1),
      first_seen_at  TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL,
      PRIMARY KEY (campaign_id, memory_kind, memory_id)
    );
    CREATE TABLE IF NOT EXISTS idea_cards (
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
    CREATE TABLE IF NOT EXISTS memory_retrievals (
      retrieval_id    TEXT PRIMARY KEY,
      campaign_id     TEXT NOT NULL REFERENCES campaigns(campaign_id),
      attempt_id      TEXT REFERENCES attempts(attempt_id),
      role            TEXT NOT NULL CHECK (role IN ('architect','manager','executor','watcher','human')),
      query_text      TEXT NOT NULL,
      filters_json    TEXT NOT NULL,
      result_ids_json TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attention_steers (
      steer_id         TEXT PRIMARY KEY,
      campaign_id      TEXT NOT NULL REFERENCES campaigns(campaign_id),
      scope             TEXT NOT NULL CHECK (scope IN ('micro','macro','watcher','all')),
      text              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      consumed_at       TEXT,
      expires_program_revision INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ideas_signal
      ON idea_cards(campaign_id, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_links
      ON campaign_memory_links(campaign_id, relevance DESC, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retrieval_attempt
      ON memory_retrievals(attempt_id, created_at);
  `;
}

function campaignEnrichmentMigrationV3(): string {
  return `
    CREATE TABLE IF NOT EXISTS campaign_source_enrichments (
      campaign_id      TEXT NOT NULL REFERENCES campaigns(campaign_id),
      source_version_id TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','waiting_external')),
      model            TEXT,
      prompt_hash      TEXT,
      last_error       TEXT,
      attempted_at     TEXT NOT NULL,
      completed_at     TEXT,
      PRIMARY KEY (campaign_id, source_version_id)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_enrichment_status
      ON campaign_source_enrichments(campaign_id, status, attempted_at);
  `;
}

export type ActorKind =
  | "supervisor" | "manager" | "executor" | "compute" | "evaluator" | "human" | "system";

export type IntervalCategory =
  | "model_reasoning" | "tool_execution" | "compute" | "evaluation" | "queue"
  | "blocked" | "sleep" | "supervisor" | "human" | "unknown";

/**
 * The research lanes, defined once.
 *
 * The type and the runtime list are derived from this array, and `schema.sql`
 * has its CHECK constraints substituted from it at creation time, so there is
 * no second place to forget. Adding `moonshot` to the schema, the allocator and
 * the prompt but not to the proposal validator rejected every moonshot proposal
 * and stopped a fresh overnight campaign after four aborts.
 */
export const LANES = ["control", "exploit", "mechanism", "falsify", "moonshot"] as const;

export type Lane = (typeof LANES)[number];

/**
 * Read a campaign's stored config with the pre-rename keys accepted.
 *
 * The baseline fields were once called `baselineBpc` / `baselineHoldoutBpc` -
 * bits-per-char, a unit that only ever made sense for the first domain. They
 * are now `baselinePrimary` / `baselineSecondary`, but campaigns written before
 * the rename still hold the old keys, and a running campaign silently reading
 * `undefined` for its own baseline would compare every result against nothing.
 */
export function normaliseCampaignConfig(raw: string): Record<string, unknown> {
  const cfg = JSON.parse(raw) as Record<string, unknown>;
  if (cfg.baselinePrimary === undefined && cfg.baselineBpc !== undefined) {
    cfg.baselinePrimary = cfg.baselineBpc;
  }
  if (cfg.baselineSecondary === undefined && cfg.baselineHoldoutBpc !== undefined) {
    cfg.baselineSecondary = cfg.baselineHoldoutBpc;
  }
  return cfg;
}

/**
 * The most recently created campaign, for tools invoked without an explicit id.
 *
 * Falls back to a literal only when the database has no campaigns at all, which
 * is the one case where guessing cannot mislead anyone.
 */
export function latestCampaignId(dbPath = join(process.cwd(), ".autoresearch", "state.sqlite")): string {
  try {
    if (!existsSync(dbPath)) return "campaign-001";
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT campaign_id FROM campaigns ORDER BY created_at DESC LIMIT 1")
      .get() as { campaign_id: string } | undefined;
    db.close();
    return row?.campaign_id ?? "campaign-001";
  } catch {
    return "campaign-001";
  }
}

/** The lane list as a SQL literal, for substitution into `schema.sql`. */
export function laneSqlList(): string {
  return LANES.map((l) => `'${l}'`).join(",");
}

export interface AppendEventInput {
  campaignId: string | null;
  aggregateKind: string;
  aggregateId: string;
  aggregateRevision: number;
  eventType: string;
  actorKind: ActorKind;
  attemptId?: string | null;
  idempotencyKey: string;
  payload: unknown;
  occurredAt?: string;
}

export interface AppendedEvent {
  seq: number;
  eventId: string;
  chainHash: string;
  duplicate: boolean;
}

/** Deterministic JSON: sorted keys, no insignificant whitespace, finite numbers only. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new Error(`non-finite number in canonical JSON: ${v}`);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(path: string): Store {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("trusted_schema = OFF");
    const store = new Store(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get();
    if (!existing) {
      // The schema's lane constraints are substituted from LANES rather than
      // written out again, so the database cannot disagree with the code.
      const sql = readFileSync(join(HERE, "schema.sql"), "utf8")
        .replace(/__LANES__/g, laneSqlList());
      if (sql.includes("__LANES__")) throw new Error("lane substitution failed");
      this.db.exec(sql);
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS schema_meta (
           version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`,
      );
      this.db.prepare("INSERT INTO schema_meta (version, applied_at, checksum) VALUES (?, ?, ?)")
        .run(SCHEMA_VERSION, nowIso(), sha256(sql));
      return;
    }

    // v1 returned as soon as it saw the event table, so older databases need a
    // real ordered migration path. Each step is idempotent and transactional;
    // the existing event rows and their hashes are never rewritten.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_meta (
         version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`,
    );
    const latest = this.db.prepare("SELECT MAX(version) AS version FROM schema_meta")
      .get() as { version: number | null };
    let version = latest.version ?? 1;
    if (latest.version === null) {
      this.db.prepare("INSERT INTO schema_meta (version, applied_at, checksum) VALUES (1, ?, ?)")
        .run(nowIso(), "legacy-v1");
    }
    if (version < 2) {
      const migration = campaignMemoryMigrationV2();
      const apply = this.db.transaction(() => {
        this.db.exec(migration);
        this.db.prepare("INSERT INTO schema_meta (version, applied_at, checksum) VALUES (2, ?, ?)")
          .run(nowIso(), sha256(migration));
      });
      apply.immediate();
      version = 2;
    }
    if (version < 3) {
      const migration = campaignEnrichmentMigrationV3();
      const apply = this.db.transaction(() => {
        this.db.exec(migration);
        this.db.prepare("INSERT INTO schema_meta (version, applied_at, checksum) VALUES (3, ?, ?)")
          .run(nowIso(), sha256(migration));
      });
      apply.immediate();
      version = 3;
    }
    if (version > SCHEMA_VERSION) {
      throw new Error(`database schema v${version} is newer than this binary (v${SCHEMA_VERSION})`);
    }
  }

  /** The only mutation entry point. No I/O other than SQLite inside `fn`. */
  transact<T>(fn: (store: Store) => T): T {
    const run = this.db.transaction((f: (s: Store) => T) => f(this));
    return run.immediate(fn);
  }

  // -- events ---------------------------------------------------------------

  /**
   * Append one event, extending the hash chain. Idempotent: replaying the same
   * idempotency key returns the stored event instead of writing a second one.
   */
  appendEvent(input: AppendEventInput): AppendedEvent {
    const prior = this.db
      .prepare("SELECT seq, event_id, chain_hash FROM events WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as
      | { seq: number; event_id: string; chain_hash: string }
      | undefined;
    if (prior) {
      return { seq: prior.seq, eventId: prior.event_id, chainHash: prior.chain_hash, duplicate: true };
    }

    const tail = this.db
      .prepare("SELECT chain_hash FROM events ORDER BY seq DESC LIMIT 1")
      .get() as { chain_hash: string } | undefined;
    const prevChainHash = tail?.chain_hash ?? null;

    const eventId = randomUUID();
    const occurredAt = input.occurredAt ?? nowIso();
    const recordedAt = nowIso();
    const payloadJson = canonicalJson(input.payload);
    const payloadHash = sha256(payloadJson);

    const framed = canonicalJson({
      eventId,
      occurredAt,
      campaignId: input.campaignId,
      aggregateKind: input.aggregateKind,
      aggregateId: input.aggregateId,
      aggregateRevision: input.aggregateRevision,
      eventType: input.eventType,
      actorKind: input.actorKind,
      attemptId: input.attemptId ?? null,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      schemaVersion: SCHEMA_VERSION,
    });
    const chainHash = sha256(`${prevChainHash ?? ZERO_HASH}${framed}`);

    const info = this.db
      .prepare(
        `INSERT INTO events (event_id, occurred_at, recorded_at, campaign_id, aggregate_kind,
           aggregate_id, aggregate_revision, event_type, actor_kind, attempt_id,
           idempotency_key, payload_json, payload_hash, prev_chain_hash, chain_hash, schema_version)
         VALUES (@eventId, @occurredAt, @recordedAt, @campaignId, @aggregateKind,
           @aggregateId, @aggregateRevision, @eventType, @actorKind, @attemptId,
           @idempotencyKey, @payloadJson, @payloadHash, @prevChainHash, @chainHash, @schemaVersion)`,
      )
      .run({
        eventId,
        occurredAt,
        recordedAt,
        campaignId: input.campaignId,
        aggregateKind: input.aggregateKind,
        aggregateId: input.aggregateId,
        aggregateRevision: input.aggregateRevision,
        eventType: input.eventType,
        actorKind: input.actorKind,
        attemptId: input.attemptId ?? null,
        idempotencyKey: input.idempotencyKey,
        payloadJson,
        payloadHash,
        prevChainHash,
        chainHash,
        schemaVersion: SCHEMA_VERSION,
      });

    return { seq: Number(info.lastInsertRowid), eventId, chainHash, duplicate: false };
  }

  /** Recompute the chain from genesis. Returns the first seq that fails, if any. */
  verifyEventChain(): { ok: true } | { ok: false; brokenAtSeq: number; reason: string } {
    const rows = this.db
      .prepare(
        `SELECT seq, event_id, occurred_at, campaign_id, aggregate_kind, aggregate_id,
                aggregate_revision, event_type, actor_kind, attempt_id, idempotency_key,
                payload_json, payload_hash, prev_chain_hash, chain_hash, schema_version
         FROM events ORDER BY seq ASC`,
      )
      .all() as Record<string, any>[];

    let prev: string | null = null;
    for (const r of rows) {
      if ((r.prev_chain_hash ?? null) !== prev) {
        return { ok: false, brokenAtSeq: r.seq, reason: "prev_chain_hash does not match predecessor" };
      }
      if (sha256(r.payload_json) !== r.payload_hash) {
        return { ok: false, brokenAtSeq: r.seq, reason: "payload_hash does not match payload" };
      }
      const framed = canonicalJson({
        eventId: r.event_id,
        occurredAt: r.occurred_at,
        campaignId: r.campaign_id,
        aggregateKind: r.aggregate_kind,
        aggregateId: r.aggregate_id,
        aggregateRevision: r.aggregate_revision,
        eventType: r.event_type,
        actorKind: r.actor_kind,
        attemptId: r.attempt_id ?? null,
        idempotencyKey: r.idempotency_key,
        payloadHash: r.payload_hash,
        schemaVersion: r.schema_version,
      });
      const expect = sha256(`${prev ?? ZERO_HASH}${framed}`);
      if (expect !== r.chain_hash) {
        return { ok: false, brokenAtSeq: r.seq, reason: "chain_hash does not match framed event" };
      }
      prev = r.chain_hash;
    }
    return { ok: true };
  }

  close(): void {
    this.db.close();
  }
}
