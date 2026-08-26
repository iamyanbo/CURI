/** Campaign-local projection and auditable retrieval over global memory. */

import { createHash, randomUUID } from "node:crypto";

import { nowIso, type Store } from "../store/store.js";
import { GlobalMemoryStore, type MemorySearchResult } from "./store.js";

export interface IdeaScores {
  originality: number;
  applicability: number;
  implementationGap: number;
  expectedImpact: number;
  evidenceQuality: number;
  transferPotential: number;
  recency: number;
}

export interface IdeaCardInput {
  mechanismId?: string | null;
  action: "adopt" | "adapt" | "combine" | "verify" | "investigate";
  title: string;
  targetDomain: string;
  rationale: string;
  scores: IdeaScores;
  codeStatus: "absent" | "present" | "partial" | "unknown";
  assumptions: string[];
  smallestExperiment: string;
  macroImplications: string;
  sourceIds: string[];
  contradiction?: boolean;
}

function clampScore(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function linkCampaignMemory(
  store: Store, campaignId: string,
  kind: "source" | "mechanism" | "idea" | "code_inventory",
  memoryId: string, relevance = 0,
): void {
  const at = nowIso();
  store.db.prepare(
    `INSERT INTO campaign_memory_links
       (campaign_id, memory_kind, memory_id, relevance, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(campaign_id, memory_kind, memory_id) DO UPDATE SET
       relevance=MAX(campaign_memory_links.relevance, excluded.relevance),
       last_seen_at=excluded.last_seen_at`,
  ).run(campaignId, kind, memoryId, clampScore(relevance), at, at);
}

export function recordIdeaCard(store: Store, campaignId: string, input: IdeaCardInput): string {
  const scores = Object.fromEntries(
    Object.entries(input.scores).map(([key, value]) => [key, clampScore(value)]),
  ) as unknown as IdeaScores;
  const signal = scores.applicability >= 0.75 && (
    scores.implementationGap >= 0.60
    || scores.transferPotential >= 0.70
    || Boolean(input.contradiction)
  );
  const fingerprint = createHash("sha256").update(JSON.stringify({
    campaignId, action: input.action, title: input.title.trim().toLowerCase(),
    sourceIds: [...new Set(input.sourceIds)].sort(),
  })).digest("hex");
  const ideaId = `IDEA-${fingerprint.slice(0, 16)}`;
  const existing = store.db.prepare(
    "SELECT idea_id FROM idea_cards WHERE campaign_id=? AND idea_id=?",
  ).get(campaignId, ideaId) as { idea_id: string } | undefined;
  if (existing) return existing.idea_id;
  const at = nowIso();
  const signalReason = signal
    ? input.contradiction ? "contradicts_active_program"
      : scores.transferPotential >= 0.70 ? "cross_domain_transfer"
        : "implementation_gap"
    : null;
  store.transact((s) => {
    s.db.prepare(
      `INSERT INTO idea_cards
         (idea_id, campaign_id, mechanism_id, action, title, target_domain, rationale,
          scores_json, code_status, assumptions_json, experiment_json, macro_implications,
          source_ids_json, state, signal_reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?)`,
    ).run(
      ideaId, campaignId, input.mechanismId ?? null, input.action, input.title,
      input.targetDomain, input.rationale, JSON.stringify(scores), input.codeStatus,
      JSON.stringify(input.assumptions), JSON.stringify({ smallest: input.smallestExperiment }),
      input.macroImplications, JSON.stringify(input.sourceIds), signalReason, at, at,
    );
    linkCampaignMemory(s, campaignId, "idea", ideaId, scores.applicability);
    s.appendEvent({
      campaignId, aggregateKind: "idea", aggregateId: ideaId, aggregateRevision: 0,
      eventType: signal ? "research.signal_detected" : "research.idea_recorded",
      actorKind: "system", idempotencyKey: `research.idea:${ideaId}`,
      payload: { action: input.action, title: input.title, scores, signalReason,
        sourceIds: input.sourceIds, mechanismId: input.mechanismId ?? null },
    });
  });
  return ideaId;
}

export interface PendingSignal {
  ideaId: string;
  title: string;
  action: string;
  rationale: string;
  signalReason: string;
  scores: IdeaScores;
  sourceIds: string[];
  mechanismId: string | null;
  macroImplications: string;
}

export function pendingSignals(store: Store, campaignId: string): PendingSignal[] {
  const rows = store.db.prepare(
    `SELECT idea_id, title, action, rationale, signal_reason, scores_json,
            source_ids_json, mechanism_id, macro_implications
     FROM idea_cards
     WHERE campaign_id=? AND state='new' AND signal_reason IS NOT NULL
     ORDER BY created_at`,
  ).all(campaignId) as Array<Record<string, any>>;
  return rows.map((row) => ({
    ideaId: row.idea_id, title: row.title, action: row.action, rationale: row.rationale,
    signalReason: row.signal_reason, scores: JSON.parse(row.scores_json),
    sourceIds: JSON.parse(row.source_ids_json), mechanismId: row.mechanism_id,
    macroImplications: row.macro_implications,
  }));
}

export function markSignalsReviewed(
  store: Store, campaignId: string, ideaIds: string[], accepted: boolean,
): void {
  if (ideaIds.length === 0) return;
  const at = nowIso();
  const update = store.db.prepare(
    "UPDATE idea_cards SET state=?, reviewed_at=?, updated_at=? WHERE campaign_id=? AND idea_id=? AND state='new'",
  );
  store.transact(() => {
    for (const id of ideaIds) update.run(accepted ? "accepted" : "rejected", at, at, campaignId, id);
  });
}

export function searchCampaignMemory(
  store: Store,
  memory: GlobalMemoryStore,
  input: {
    campaignId: string; query: string; role: "architect" | "manager" | "executor" | "watcher" | "human";
    attemptId?: string | null; asOf?: string | null; limit?: number; offset?: number;
  },
): { results: MemorySearchResult[]; nextOffset: number | null; retrievalId: string } {
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const offset = Math.max(0, input.offset ?? 0);
  const results = memory.search(input.query, { limit: limit + 1, offset, asOf: input.asOf ?? null });
  const page = results.slice(0, limit);
  const nextOffset = results.length > limit ? offset + limit : null;
  const retrievalId = `RET-${randomUUID().slice(0, 12)}`;
  store.db.prepare(
    `INSERT INTO memory_retrievals
       (retrieval_id, campaign_id, attempt_id, role, query_text, filters_json, result_ids_json, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    retrievalId, input.campaignId, input.attemptId ?? null, input.role, input.query,
    JSON.stringify({ asOf: input.asOf ?? null, limit, offset }),
    JSON.stringify(page.map((result) => result.id)), nowIso(),
  );
  for (const result of page) linkCampaignMemory(store, input.campaignId, result.kind, result.id, result.score);
  return { results: page, nextOffset, retrievalId };
}

export function rankedCampaignBriefing(
  store: Store, memory: GlobalMemoryStore, campaignId: string, query: string, asOf?: string | null,
): { signals: PendingSignal[]; memories: MemorySearchResult[] } {
  const signals = pendingSignals(store, campaignId);
  const retrieval = searchCampaignMemory(store, memory, {
    campaignId, query, role: "architect", asOf: asOf ?? null, limit: 30, offset: 0,
  });
  return { signals, memories: retrieval.results };
}
