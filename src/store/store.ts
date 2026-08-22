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
export const SCHEMA_VERSION = 1;
const ZERO_HASH = "0".repeat(64);

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
    if (existing) return;
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
    this.db
      .prepare("INSERT INTO schema_meta (version, applied_at, checksum) VALUES (?, ?, ?)")
      .run(SCHEMA_VERSION, nowIso(), sha256(sql));
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
