/** Batched Ox enrichment. Raw watcher ingestion never depends on this succeeding. */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { recordIdeaCard, linkCampaignMemory, type IdeaCardInput } from "../memory/campaign-memory.js";
import { GlobalMemoryStore, type MechanismMemory } from "../memory/store.js";
import { nowIso, type Store } from "../store/store.js";
import {
  EnrichmentIdeaSchema, MechanismMemorySchema, MechanismRelationSchema,
  SourceAssessmentSchema, fetchPublicText, runWorker,
} from "../worker/genkit-worker.js";
import { extractJson } from "../worker/types.js";
import { sanitise } from "../scout.js";
import { storedSourceIsRelevant } from "./relevance.js";

interface EnrichmentOutput {
  sourceAssessments: Array<{
    sourceVersionId: string; relevant: boolean; confidence: number;
    contentBasis: "full_text" | "abstract_only" | "metadata_only"; rationale: string;
  }>;
  mechanisms: Array<Omit<MechanismMemory, "inferenceModel" | "promptHash">>;
  ideas: Array<Omit<IdeaCardInput, "sourceIds" | "mechanismId"> & {
    mechanismName?: string; sourceVersionIds: string[];
  }>;
  relations: Array<{
    fromMechanismName: string; toMechanismName: string;
    relation: "requires" | "enables" | "contradicts" | "analogous_to" | "implemented_by";
    confidence: number; rationale: string;
  }>;
}

function readablePage(text: string): string {
  return sanitise(text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'"), 8_000);
}

function latestContextPacket(projectRoot: string): Record<string, unknown> | null {
  const root = join(projectRoot, ".autoresearch", "attempts");
  if (!existsSync(root)) return null;
  const found: Array<{ path: string; mtime: number }> = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === "context-packet.json") {
        try { found.push({ path: full, mtime: statSync(full).mtimeMs }); } catch { /* ignored */ }
      }
    }
  };
  visit(root);
  for (const item of found.sort((a, b) => b.mtime - a.mtime)) {
    try { return JSON.parse(readFileSync(item.path, "utf8")) as Record<string, unknown>; }
    catch { /* try the next complete packet */ }
  }
  return null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function campaignSourcesNeedingEnrichment(
  store: Store, memory: GlobalMemoryStore, campaignId: string, ids: string[], limit = 12,
): ReturnType<GlobalMemoryStore["sourceVersions"]> {
  const status = store.db.prepare(
    `SELECT status, attempted_at FROM campaign_source_enrichments
     WHERE campaign_id=? AND source_version_id=?`,
  );
  const now = Date.now();
  return memory.sourceVersions([...new Set(ids)]).filter((source) => {
    const row = status.get(campaignId, source.sourceVersionId) as {
      status: string; attempted_at: string;
    } | undefined;
    if (!row) return true;
    if (row.status === "succeeded") return false;
    const age = now - Date.parse(row.attempted_at);
    if (!Number.isFinite(age)) return true;
    if (row.status === "waiting_external") return age >= 12 * 3_600_000;
    if (row.status === "pending") return age >= 2 * 3_600_000;
    return age >= 3_600_000;
  }).slice(0, Math.max(1, limit));
}

/**
 * How many sources one enrichment pass reads.
 *
 * Every source in a batch contributes up to 8k characters of fetched page to a
 * single prompt, so this trades throughput against context: too large and the
 * batch stops fitting, too small and the queue never drains. Now that no source
 * is discarded before being read, the queue is longer and the default is
 * correspondingly higher than the original twelve.
 */
export function enrichmentBatchSize(): number {
  const configured = Number(process.env.AR_ENRICHMENT_BATCH ?? 24);
  if (!Number.isFinite(configured) || configured < 1) {
    throw new Error("AR_ENRICHMENT_BATCH must be a positive number of sources");
  }
  return Math.min(30, Math.floor(configured));
}

function markCampaignEnrichment(
  store: Store, campaignId: string, sourceIds: string[],
  status: "pending" | "succeeded" | "failed" | "waiting_external",
  details: { model?: string | null; promptHash?: string | null; error?: string | null } = {},
): void {
  const at = nowIso();
  const write = store.db.prepare(
    `INSERT INTO campaign_source_enrichments
       (campaign_id, source_version_id, status, model, prompt_hash, last_error, attempted_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(campaign_id, source_version_id) DO UPDATE SET
       status=excluded.status, model=excluded.model, prompt_hash=excluded.prompt_hash,
       last_error=excluded.last_error, attempted_at=excluded.attempted_at,
       completed_at=excluded.completed_at`,
  );
  store.transact(() => {
    for (const id of sourceIds) write.run(
      campaignId, id, status, details.model ?? null, details.promptHash ?? null,
      details.error?.slice(0, 1000) ?? null, at, status === "succeeded" ? at : null,
    );
  });
}

/**
 * Enforce the enrichment contract on a model reply, item by item.
 *
 * Only a provider with native structured output validates this schema for us;
 * with any other provider the reply is free text that is merely JSON-parsed.
 * The fields were then read as though they were guaranteed — `canonicalName`,
 * `title`, `fromMechanismName` — and one omitted field threw a TypeError that
 * propagated out of the whole watcher sweep. Enrichment is explicitly optional
 * to this system, so a malformed item must cost that item and nothing more.
 *
 * Validation is per element rather than whole-object so that one bad idea does
 * not discard a batch of good mechanisms alongside it.
 */
export function validateEnrichment(raw: unknown): EnrichmentOutput {
  const source = (raw ?? {}) as Record<string, unknown>;
  const keep = <T>(values: unknown, schema: { safeParse(value: unknown): { success: boolean; data?: unknown } }): T[] => {
    if (!Array.isArray(values)) return [];
    const out: T[] = [];
    for (const value of values) {
      const result = schema.safeParse(value);
      if (result.success) out.push(result.data as T);
    }
    return out;
  };
  return {
    sourceAssessments: keep(source.sourceAssessments, SourceAssessmentSchema),
    mechanisms: keep(source.mechanisms, MechanismMemorySchema),
    ideas: keep(source.ideas, EnrichmentIdeaSchema),
    relations: keep(source.relations, MechanismRelationSchema),
  } as EnrichmentOutput;
}

export async function enrichWatcherSources(
  store: Store, memory: GlobalMemoryStore,
  input: { campaignId: string; projectRoot: string; sourceVersionIds: string[]; model?: string },
): Promise<{ enriched: number; ideas: number; deferred: boolean; failure?: string }> {
  const candidates = campaignSourcesNeedingEnrichment(
    store, memory, input.campaignId, input.sourceVersionIds, enrichmentBatchSize(),
  );
  // Keyword overlap no longer vetoes anything. This watcher exists to surface
  // macro and cross-domain work — a new mathematical result that bears on
  // matrix multiplication, or LLM work that carries over to VLMs — and such a
  // source shares no vocabulary with the campaign topic by definition. The
  // lexical screen rejected exactly those while admitting unrelated papers that
  // happened to share a phrase, so it now only orders the queue: the model
  // below reads the page and makes the actual judgement.
  const sources = [...candidates].sort((a, b) =>
    (storedSourceIsRelevant(b) ? 1 : 0) - (storedSourceIsRelevant(a) ? 1 : 0));
  if (sources.length === 0) return { enriched: 0, ideas: 0, deferred: false };
  const sourceIds = sources.map((source) => source.sourceVersionId);
  const campaign = store.db.prepare("SELECT objective, base_revision FROM campaigns WHERE campaign_id=?")
    .get(input.campaignId) as { objective: string; base_revision: string };
  const prior = store.db.prepare(
    `SELECT title, mechanism, status FROM hypotheses WHERE campaign_id=?
     ORDER BY created_at DESC LIMIT 50`,
  ).all(input.campaignId);
  const packet = latestContextPacket(input.projectRoot);
  // A search result is only a lead. Fetch the actual page before the model can
  // turn it into a mechanism or an idea. Retrieval failures are labelled so
  // the model can abstain instead of inventing detail from a fuzzy title.
  const sourceDocuments = await Promise.all(sources.map(async (source) => {
    try {
      const fullText = readablePage(await fetchPublicText(source.canonicalUrl));
      if (!fullText) throw new Error("page contained no readable text");
      memory.attachRawText(source.sourceVersionId, fullText);
      return { ...source, contentBasis: "full_text", fullText };
    } catch (error) {
      return {
        ...source, contentBasis: source.abstract ? "abstract_only" : "metadata_only",
        fullText: null, fetchFailure: String(error).slice(0, 240),
      };
    }
  }));
  const promptTemplate = readFileSync(join(input.projectRoot, "prompts", "memory-enrichment.md"), "utf8");
  const prompt = [
    promptTemplate,
    "\n## Campaign\n", JSON.stringify({ objective: campaign.objective, baseRevision: campaign.base_revision }),
    "\n## Current candidate and macro state\n", JSON.stringify({
      currentCandidate: packet?.current_candidate ?? null,
      macroProgram: packet?.macro_program ?? null,
      priorHypotheses: prior,
    }),
    "\n## New untrusted source documents\n", JSON.stringify(sourceDocuments),
  ].join("\n");
  const promptHash = hash(prompt);
  memory.markEnrichment(sourceIds, "pending", { model: input.model ?? "stealth/ox-alpha", promptHash });
  markCampaignEnrichment(store, input.campaignId, sourceIds, "pending", {
    model: input.model ?? "stealth/ox-alpha", promptHash,
  });
  const runId = randomUUID();
  const run = await runWorker({
    role: "architect", prompt, cwd: input.projectRoot,
    attemptDir: join(input.projectRoot, ".autoresearch", "attempts", "watcher", input.campaignId, runId),
    tools: [], model: input.model, timeoutMs: 0,
    campaignId: input.campaignId, cycleId: "watcher-enrichment", attemptId: `watcher-${runId}`,
    structuredOutput: "memory-enrichment",
  });
  if (!run.ok) {
    const quota = run.failure?.startsWith("PROVIDER_RATE_LIMITED") ?? false;
    memory.markEnrichment(sourceIds, quota ? "waiting_external" : "failed", {
      model: run.model, promptHash, error: run.failure ?? run.stderrTail,
    });
    markCampaignEnrichment(store, input.campaignId, sourceIds, quota ? "waiting_external" : "failed", {
      model: run.model, promptHash, error: run.failure ?? run.stderrTail,
    });
    store.appendEvent({
      campaignId: input.campaignId, aggregateKind: "watcher", aggregateId: input.campaignId,
      aggregateRevision: 0, eventType: quota ? "watcher.enrichment_deferred" : "watcher.enrichment_failed",
      actorKind: "system", idempotencyKey: `watcher.enrichment:${runId}`,
      payload: { sourceIds, failure: run.failure ?? run.stderrTail },
    });
    return { enriched: 0, ideas: 0, deferred: quota, failure: run.failure ?? run.stderrTail };
  }
  const rawParsed = extractJson<unknown>(run.finalText);
  if (!rawParsed.ok) {
    memory.markEnrichment(sourceIds, "failed", { model: run.model, promptHash, error: rawParsed.error });
    markCampaignEnrichment(store, input.campaignId, sourceIds, "failed", {
      model: run.model, promptHash, error: rawParsed.error,
    });
    return { enriched: 0, ideas: 0, deferred: false, failure: rawParsed.error };
  }
  const parsed = { value: validateEnrichment(rawParsed.value) };
  const allowed = new Set(sourceIds);
  const assessments = new Map(parsed.value.sourceAssessments
    .filter((assessment) => allowed.has(assessment.sourceVersionId))
    .map((assessment) => [assessment.sourceVersionId, assessment]));
  const relevant = new Set(sourceIds.filter((id) => {
    const assessment = assessments.get(id);
    return Boolean(assessment?.relevant) && Number(assessment?.confidence ?? 0) >= 0.55;
  }));
  const updateRelevance = store.db.prepare(
    `UPDATE campaign_memory_links SET relevance=?, last_seen_at=?
     WHERE campaign_id=? AND memory_kind='source' AND memory_id=?`,
  );
  store.transact(() => {
    for (const id of sourceIds) {
      const assessment = assessments.get(id);
      updateRelevance.run(
        relevant.has(id) ? Math.max(0, Math.min(1, Number(assessment?.confidence ?? 0))) : 0,
        nowIso(), input.campaignId, id,
      );
    }
  });
  const mechanismIds = new Map<string, string>();
  for (const mechanism of parsed.value.mechanisms) {
    const validSourceIds = mechanism.sourceVersionIds.filter((id) => relevant.has(id));
    if (validSourceIds.length === 0) continue;
    const recorded = memory.recordMechanism({
      ...mechanism, sourceVersionIds: validSourceIds,
      inferenceModel: run.model ?? input.model ?? "stealth/ox-alpha", promptHash,
    });
    mechanismIds.set(mechanism.canonicalName.toLowerCase(), recorded.mechanismId);
    linkCampaignMemory(store, input.campaignId, "mechanism", recorded.mechanismId, mechanism.confidence);
  }
  for (const relation of parsed.value.relations ?? []) {
    const from = mechanismIds.get(relation.fromMechanismName.toLowerCase());
    const to = mechanismIds.get(relation.toMechanismName.toLowerCase());
    if (!from || !to) continue;
    memory.recordRelation({
      fromMechanismId: from, toMechanismId: to, relation: relation.relation,
      confidence: relation.confidence,
      provenance: { sourceIds: [...relevant], rationale: relation.rationale, model: run.model, promptHash },
    });
  }
  let ideas = 0;
  for (const idea of parsed.value.ideas) {
    const validSourceIds = idea.sourceVersionIds.filter((id) => relevant.has(id));
    if (validSourceIds.length === 0) continue;
    recordIdeaCard(store, input.campaignId, {
      ...idea, sourceIds: validSourceIds,
      mechanismId: idea.mechanismName ? mechanismIds.get(idea.mechanismName.toLowerCase()) ?? null : null,
    });
    const mechanismId = idea.mechanismName
      ? mechanismIds.get(idea.mechanismName.toLowerCase()) ?? null : null;
    if (mechanismId) {
      memory.recordCodeStatus({
        projectKey: hash(input.projectRoot).slice(0, 20), revision: campaign.base_revision,
        mechanismId, status: idea.codeStatus, detail: idea.rationale,
      });
    }
    ideas++;
  }
  memory.markEnrichment(sourceIds, "succeeded", { model: run.model, promptHash });
  markCampaignEnrichment(store, input.campaignId, sourceIds, "succeeded", {
    model: run.model, promptHash,
  });
  memory.recordConsolidation({
    model: run.model ?? input.model ?? "stealth/ox-alpha", promptHash, sourceIds,
    mechanismIds: [...mechanismIds.values()],
    summary: `Extracted ${mechanismIds.size} mechanisms, ${ideas} ideas, and ${(parsed.value.relations ?? []).length} relations`,
  });
  store.appendEvent({
    campaignId: input.campaignId, aggregateKind: "watcher", aggregateId: input.campaignId,
    aggregateRevision: 0, eventType: "watcher.enrichment_completed", actorKind: "system",
    idempotencyKey: `watcher.enrichment:${runId}`,
    payload: {
      sourceIds, relevantSources: relevant.size, rejectedSources: sourceIds.length - relevant.size,
      fullTextFetched: sourceDocuments.filter((source) => source.contentBasis === "full_text").length,
      mechanisms: mechanismIds.size, ideas, model: run.model, at: nowIso(),
    },
  });
  return { enriched: mechanismIds.size, ideas, deferred: false };
}
