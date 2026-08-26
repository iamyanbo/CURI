/** User-level, cross-project research memory. Campaign evidence stays local. */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MEMORY_SCHEMA_VERSION = 1;

export interface SourceObservation {
  provider: string;
  canonicalUrl: string;
  title: string;
  abstract: string;
  publishedAt: string | null;
  retrievedAt: string;
  sourceClass: "preprint" | "repository" | "discussion" | "release" | "article" | "feed";
  metadata?: Record<string, unknown>;
  rawTextHash?: string | null;
  rawTextPath?: string | null;
}

export interface MechanismMemory {
  mechanismId?: string;
  canonicalName: string;
  description: string;
  operation: string;
  bottleneck: string;
  intervention: string;
  prerequisites: string[];
  constraints: string[];
  claimedEffects: string[];
  aliases: string[];
  originDomains: string[];
  confidence: number;
  inferenceModel: string;
  promptHash: string;
  sourceVersionIds: string[];
}

export interface MemorySearchResult {
  id: string;
  kind: "source" | "mechanism";
  title: string;
  snippet: string;
  publishedAt: string | null;
  score: number;
  metadata: Record<string, unknown>;
}

export interface StoredSourceVersion {
  sourceVersionId: string;
  provider: string;
  canonicalUrl: string;
  title: string;
  abstract: string;
  publishedAt: string | null;
  retrievedAt: string;
  sourceClass: string;
  metadata: Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultMemoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AR_MEMORY_DB ?? join(homedir(), ".autoresearch", "memory.sqlite");
}

export class GlobalMemoryStore {
  readonly db: Database.Database;
  readonly path: string;

  private constructor(path: string, db: Database.Database) {
    this.path = path;
    this.db = db;
  }

  static open(path = defaultMemoryPath()): GlobalMemoryStore {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 10000");
    db.pragma("trusted_schema = OFF");
    const store = new GlobalMemoryStore(path, db);
    store.migrate();
    return store;
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_schema_meta (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL
      );
    `);
    const prior = this.db.prepare("SELECT MAX(version) AS version FROM memory_schema_meta")
      .get() as { version: number | null };
    if (prior.version !== null && prior.version > MEMORY_SCHEMA_VERSION) {
      throw new Error(`global memory schema v${prior.version} is newer than v${MEMORY_SCHEMA_VERSION}`);
    }
    const migrate = this.db.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_versions (
        source_version_id TEXT PRIMARY KEY,
        provider          TEXT NOT NULL,
        canonical_url     TEXT NOT NULL,
        title             TEXT NOT NULL,
        abstract          TEXT NOT NULL,
        published_at      TEXT,
        first_seen_at     TEXT NOT NULL,
        retrieved_at      TEXT NOT NULL,
        content_hash      TEXT NOT NULL,
        source_class      TEXT NOT NULL,
        metadata_json     TEXT NOT NULL,
        raw_text_hash     TEXT,
        raw_text_path     TEXT,
        supersedes_id     TEXT REFERENCES source_versions(source_version_id),
        UNIQUE(canonical_url, content_hash)
      );
      CREATE TABLE IF NOT EXISTS mechanisms (
        mechanism_id       TEXT PRIMARY KEY,
        canonical_name     TEXT NOT NULL,
        description        TEXT NOT NULL,
        operation          TEXT NOT NULL,
        bottleneck         TEXT NOT NULL,
        intervention       TEXT NOT NULL,
        prerequisites_json TEXT NOT NULL,
        constraints_json   TEXT NOT NULL,
        effects_json       TEXT NOT NULL,
        aliases_json       TEXT NOT NULL,
        domains_json       TEXT NOT NULL,
        confidence         REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        inference_model    TEXT NOT NULL,
        prompt_hash        TEXT NOT NULL,
        content_hash       TEXT NOT NULL UNIQUE,
        created_at         TEXT NOT NULL,
        superseded_by      TEXT REFERENCES mechanisms(mechanism_id)
      );
      CREATE TABLE IF NOT EXISTS mechanism_sources (
        mechanism_id     TEXT NOT NULL REFERENCES mechanisms(mechanism_id),
        source_version_id TEXT NOT NULL REFERENCES source_versions(source_version_id),
        PRIMARY KEY (mechanism_id, source_version_id)
      );
      CREATE TABLE IF NOT EXISTS source_enrichments (
        source_version_id TEXT PRIMARY KEY REFERENCES source_versions(source_version_id),
        status            TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','waiting_external')),
        model             TEXT,
        prompt_hash       TEXT,
        last_error        TEXT,
        attempted_at      TEXT NOT NULL,
        completed_at      TEXT
      );
      CREATE TABLE IF NOT EXISTS mechanism_relations (
        from_mechanism_id TEXT NOT NULL REFERENCES mechanisms(mechanism_id),
        to_mechanism_id   TEXT NOT NULL REFERENCES mechanisms(mechanism_id),
        relation          TEXT NOT NULL CHECK (relation IN ('requires','enables','contradicts','analogous_to','implemented_by')),
        confidence        REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        provenance_json   TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        PRIMARY KEY (from_mechanism_id, to_mechanism_id, relation)
      );
      CREATE TABLE IF NOT EXISTS code_mechanisms (
        inventory_id    TEXT PRIMARY KEY,
        project_key     TEXT NOT NULL,
        revision        TEXT NOT NULL,
        mechanism_id    TEXT NOT NULL REFERENCES mechanisms(mechanism_id),
        status          TEXT NOT NULL CHECK (status IN ('present','partial','absent','unknown')),
        detail          TEXT NOT NULL,
        observed_at     TEXT NOT NULL,
        UNIQUE(project_key, revision, mechanism_id)
      );
      CREATE TABLE IF NOT EXISTS memory_consolidations (
        consolidation_id TEXT PRIMARY KEY,
        model            TEXT NOT NULL,
        prompt_hash      TEXT NOT NULL,
        source_ids_json  TEXT NOT NULL,
        mechanism_ids_json TEXT NOT NULL,
        summary          TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
        created_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_documents (
        rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id  TEXT NOT NULL UNIQUE,
        kind         TEXT NOT NULL CHECK (kind IN ('source','mechanism')),
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        published_at TEXT,
        metadata_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_documents_fts USING fts5(
        document_id UNINDEXED, title, body, content='memory_documents', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS memory_documents_ai AFTER INSERT ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(rowid, document_id, title, body)
        VALUES (new.rowid, new.document_id, new.title, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_documents_ad AFTER DELETE ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(memory_documents_fts, rowid, document_id, title, body)
        VALUES ('delete', old.rowid, old.document_id, old.title, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_documents_au AFTER UPDATE ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(memory_documents_fts, rowid, document_id, title, body)
        VALUES ('delete', old.rowid, old.document_id, old.title, old.body);
        INSERT INTO memory_documents_fts(rowid, document_id, title, body)
        VALUES (new.rowid, new.document_id, new.title, new.body);
      END;
      CREATE INDEX IF NOT EXISTS idx_source_url ON source_versions(canonical_url, retrieved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_source_published ON source_versions(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mechanism_name ON mechanisms(canonical_name);
    `);
    if (prior.version === null) {
      this.db.prepare("INSERT INTO memory_schema_meta(version, applied_at, checksum) VALUES (?,?,?)")
        .run(MEMORY_SCHEMA_VERSION, new Date().toISOString(), sha256("global-memory-v1"));
    }
    });
    migrate.immediate();
  }

  recordSource(input: SourceObservation): { sourceVersionId: string; inserted: boolean } {
    const contentHash = sha256(JSON.stringify({
      title: input.title, abstract: input.abstract, publishedAt: input.publishedAt,
      rawTextHash: input.rawTextHash ?? null,
    }));
    const existing = this.db.prepare(
      "SELECT source_version_id FROM source_versions WHERE canonical_url=? AND content_hash=?",
    ).get(input.canonicalUrl, contentHash) as { source_version_id: string } | undefined;
    if (existing) return { sourceVersionId: existing.source_version_id, inserted: false };
    const prior = this.db.prepare(
      "SELECT source_version_id, first_seen_at FROM source_versions WHERE canonical_url=? ORDER BY retrieved_at DESC LIMIT 1",
    ).get(input.canonicalUrl) as { source_version_id: string; first_seen_at: string } | undefined;
    // Include the canonical URL so identical metadata mirrored at two URLs does
    // not collide, while repeated observations of one URL remain deterministic.
    const id = `SV-${sha256(`${input.canonicalUrl}\n${contentHash}`).slice(0, 20)}`;
    let inserted = false;
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT OR IGNORE INTO source_versions
           (source_version_id, provider, canonical_url, title, abstract, published_at,
            first_seen_at, retrieved_at, content_hash, source_class, metadata_json,
            raw_text_hash, raw_text_path, supersedes_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, input.provider, input.canonicalUrl, input.title, input.abstract, input.publishedAt,
        prior?.first_seen_at ?? input.retrievedAt, input.retrievedAt, contentHash, input.sourceClass,
        JSON.stringify(input.metadata ?? {}), input.rawTextHash ?? null, input.rawTextPath ?? null,
        prior?.source_version_id ?? null,
      );
      inserted = result.changes > 0;
      if (inserted) {
        this.upsertDocument(id, "source", input.title, input.abstract, input.publishedAt, {
          provider: input.provider, url: input.canonicalUrl, sourceClass: input.sourceClass,
        });
      }
    });
    tx.immediate();
    const resolved = inserted ? id : (this.db.prepare(
      "SELECT source_version_id FROM source_versions WHERE canonical_url=? AND content_hash=?",
    ).get(input.canonicalUrl, contentHash) as { source_version_id: string }).source_version_id;
    return { sourceVersionId: resolved, inserted };
  }

  recordMechanism(input: MechanismMemory): { mechanismId: string; inserted: boolean } {
    const normalized = {
      canonicalName: input.canonicalName.trim().toLowerCase(), description: input.description,
      operation: input.operation, bottleneck: input.bottleneck, intervention: input.intervention,
      prerequisites: input.prerequisites, constraints: input.constraints,
      claimedEffects: input.claimedEffects, aliases: input.aliases, originDomains: input.originDomains,
    };
    const contentHash = sha256(JSON.stringify(normalized));
    const existing = this.db.prepare("SELECT mechanism_id FROM mechanisms WHERE content_hash=?")
      .get(contentHash) as { mechanism_id: string } | undefined;
    if (existing) return { mechanismId: existing.mechanism_id, inserted: false };
    const id = `M-${contentHash.slice(0, 20)}`;
    let inserted = false;
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT OR IGNORE INTO mechanisms
           (mechanism_id, canonical_name, description, operation, bottleneck, intervention,
            prerequisites_json, constraints_json, effects_json, aliases_json, domains_json,
            confidence, inference_model, prompt_hash, content_hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, input.canonicalName, input.description, input.operation, input.bottleneck, input.intervention,
        JSON.stringify(input.prerequisites), JSON.stringify(input.constraints),
        JSON.stringify(input.claimedEffects), JSON.stringify(input.aliases), JSON.stringify(input.originDomains),
        Math.max(0, Math.min(1, input.confidence)), input.inferenceModel, input.promptHash,
        contentHash, new Date().toISOString(),
      );
      inserted = result.changes > 0;
      const resolved = (this.db.prepare("SELECT mechanism_id FROM mechanisms WHERE content_hash=?")
        .get(contentHash) as { mechanism_id: string }).mechanism_id;
      const link = this.db.prepare(
        "INSERT OR IGNORE INTO mechanism_sources(mechanism_id, source_version_id) VALUES (?,?)",
      );
      for (const sourceId of input.sourceVersionIds) link.run(resolved, sourceId);
      this.upsertDocument(
        resolved, "mechanism", input.canonicalName,
        [input.description, input.operation, input.bottleneck, input.intervention,
         ...input.aliases, ...input.originDomains].join("\n"), null,
        { confidence: input.confidence, sourceVersionIds: input.sourceVersionIds },
      );
    });
    tx.immediate();
    const resolved = (this.db.prepare("SELECT mechanism_id FROM mechanisms WHERE content_hash=?")
      .get(contentHash) as { mechanism_id: string }).mechanism_id;
    return { mechanismId: resolved, inserted };
  }

  recordRelation(input: {
    fromMechanismId: string; toMechanismId: string;
    relation: "requires" | "enables" | "contradicts" | "analogous_to" | "implemented_by";
    confidence: number; provenance: Record<string, unknown>;
  }): void {
    if (input.fromMechanismId === input.toMechanismId) return;
    this.db.prepare(
      `INSERT INTO mechanism_relations
         (from_mechanism_id, to_mechanism_id, relation, confidence, provenance_json, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(from_mechanism_id, to_mechanism_id, relation) DO UPDATE SET
         confidence=MAX(mechanism_relations.confidence, excluded.confidence),
         provenance_json=excluded.provenance_json`,
    ).run(
      input.fromMechanismId, input.toMechanismId, input.relation,
      Math.max(0, Math.min(1, input.confidence)), JSON.stringify(input.provenance),
      new Date().toISOString(),
    );
  }

  recordCodeStatus(input: {
    projectKey: string; revision: string; mechanismId: string;
    status: "present" | "partial" | "absent" | "unknown"; detail: string;
  }): void {
    const id = `CI-${sha256(`${input.projectKey}\n${input.revision}\n${input.mechanismId}`).slice(0, 20)}`;
    this.db.prepare(
      `INSERT INTO code_mechanisms
         (inventory_id, project_key, revision, mechanism_id, status, detail, observed_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(project_key, revision, mechanism_id) DO UPDATE SET
         status=excluded.status, detail=excluded.detail, observed_at=excluded.observed_at`,
    ).run(id, input.projectKey, input.revision, input.mechanismId, input.status,
      input.detail, new Date().toISOString());
  }

  recordConsolidation(input: {
    model: string; promptHash: string; sourceIds: string[]; mechanismIds: string[];
    summary: string; status?: "succeeded" | "failed";
  }): string {
    const id = `CONS-${randomUUID().slice(0, 16)}`;
    this.db.prepare(
      `INSERT INTO memory_consolidations
         (consolidation_id, model, prompt_hash, source_ids_json, mechanism_ids_json,
          summary, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, input.model, input.promptHash, JSON.stringify(input.sourceIds),
      JSON.stringify(input.mechanismIds), input.summary, input.status ?? "succeeded",
      new Date().toISOString());
    return id;
  }

  sourceVersions(ids: string[]): StoredSourceVersion[] {
    if (ids.length === 0) return [];
    const get = this.db.prepare(
      `SELECT source_version_id, provider, canonical_url, title, abstract,
              published_at, retrieved_at, source_class, metadata_json
       FROM source_versions WHERE source_version_id=?`,
    );
    return ids.flatMap((id) => {
      const row = get.get(id) as Record<string, any> | undefined;
      return row ? [{
        sourceVersionId: row.source_version_id, provider: row.provider,
        canonicalUrl: row.canonical_url, title: row.title, abstract: row.abstract,
        publishedAt: row.published_at, retrievedAt: row.retrieved_at,
        sourceClass: row.source_class, metadata: JSON.parse(row.metadata_json ?? "{}"),
      }] : [];
    });
  }

  sourcesNeedingEnrichment(ids: string[], limit = 12): StoredSourceVersion[] {
    if (ids.length === 0) return [];
    const done = this.db.prepare(
      "SELECT 1 FROM source_enrichments WHERE source_version_id=? AND status='succeeded' LIMIT 1",
    );
    return this.sourceVersions([...new Set(ids)])
      .filter((source) => !done.get(source.sourceVersionId))
      .slice(0, Math.max(1, limit));
  }

  markEnrichment(
    sourceIds: string[], status: "pending" | "succeeded" | "failed" | "waiting_external",
    details: { model?: string | null; promptHash?: string | null; error?: string | null } = {},
  ): void {
    const at = new Date().toISOString();
    const write = this.db.prepare(
      `INSERT INTO source_enrichments
         (source_version_id, status, model, prompt_hash, last_error, attempted_at, completed_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(source_version_id) DO UPDATE SET status=excluded.status,
         model=excluded.model, prompt_hash=excluded.prompt_hash, last_error=excluded.last_error,
         attempted_at=excluded.attempted_at, completed_at=excluded.completed_at`,
    );
    const tx = this.db.transaction(() => {
      for (const id of sourceIds) write.run(
        id, status, details.model ?? null, details.promptHash ?? null,
        details.error?.slice(0, 1000) ?? null, at, status === "succeeded" ? at : null,
      );
    });
    tx.immediate();
  }

  attachRawText(sourceVersionId: string, text: string): { hash: string; path: string } {
    const contentHash = sha256(text);
    const blobDir = join(dirname(this.path), "memory", "blobs", contentHash.slice(0, 2));
    mkdirSync(blobDir, { recursive: true });
    const path = join(blobDir, `${contentHash}.txt`);
    if (!existsSync(path)) writeFileSync(path, text, "utf8");
    this.db.prepare(
      "UPDATE source_versions SET raw_text_hash=?, raw_text_path=? WHERE source_version_id=?",
    ).run(contentHash, path, sourceVersionId);
    return { hash: contentHash, path };
  }

  private upsertDocument(
    id: string, kind: "source" | "mechanism", title: string, body: string,
    publishedAt: string | null, metadata: Record<string, unknown>,
  ): void {
    this.db.prepare(
      `INSERT INTO memory_documents(document_id, kind, title, body, published_at, metadata_json)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(document_id) DO UPDATE SET title=excluded.title, body=excluded.body,
         published_at=excluded.published_at, metadata_json=excluded.metadata_json`,
    ).run(id, kind, title, body, publishedAt, JSON.stringify(metadata));
  }

  search(query: string, options: { limit?: number; offset?: number; asOf?: string | null } = {}): MemorySearchResult[] {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);
    const terms = query.trim().split(/\s+/).filter(Boolean)
      .map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
    if (!terms) return [];
    const rows = this.db.prepare(
      `SELECT d.document_id, d.kind, d.title,
              snippet(memory_documents_fts, 2, '', '', ' … ', 24) AS snippet,
              d.published_at, d.metadata_json, bm25(memory_documents_fts) AS rank
       FROM memory_documents_fts
       JOIN memory_documents d ON d.rowid = memory_documents_fts.rowid
       WHERE memory_documents_fts MATCH ?
         AND (? IS NULL OR (d.published_at IS NOT NULL AND d.published_at < ?))
       ORDER BY rank, COALESCE(d.published_at, '') DESC LIMIT ? OFFSET ?`,
    ).all(terms, options.asOf ?? null, options.asOf ?? null, limit, offset) as Array<Record<string, any>>;
    return rows.map((row) => ({
      id: row.document_id, kind: row.kind, title: row.title, snippet: row.snippet,
      publishedAt: row.published_at, score: 1 / (1 + Math.abs(Number(row.rank ?? 0))),
      metadata: JSON.parse(row.metadata_json ?? "{}"),
    }));
  }

  rebuildFts(): void {
    this.db.exec("INSERT INTO memory_documents_fts(memory_documents_fts) VALUES ('rebuild')");
  }
}
