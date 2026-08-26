/** Durable watcher sweeps: raw ingestion first, optional model enrichment later. */

import { createHash, randomUUID } from "node:crypto";

import { GlobalMemoryStore, type SourceObservation } from "../memory/store.js";
import { linkCampaignMemory } from "../memory/campaign-memory.js";
import { sanitise, PROVIDERS, queryFor, type Lead, type Provider } from "../scout.js";
import { nowIso, sha256, type Store } from "../store/store.js";
import type { ProgressHeartbeat } from "../supervision/progress-heartbeat.js";
import { assessSourceRelevance } from "./relevance.js";

export interface WatcherSubscription {
  campaignId: string;
  intervalSeconds: number;
  topics: string[];
  feeds: string[];
  queryStrategy: Record<string, unknown>;
}

export function configureWatcher(
  store: Store, campaignId: string,
  options: {
    intervalSeconds?: number; topics?: string[]; feeds?: string[]; enabled?: boolean;
    maxResultsPerQuery?: number; overlapHours?: number;
    lifetime?: "campaign" | "persistent";
  },
): WatcherSubscription {
  const existing = readWatcherSubscription(store, campaignId);
  const row = store.db.prepare("SELECT title, objective FROM campaigns WHERE campaign_id=?")
    .get(campaignId) as { title: string; objective: string } | undefined;
  const fallbackTopics = [row?.title || row?.objective || campaignId];
  const requestedTopics = options.topics === undefined
    ? (existing?.topics ?? fallbackTopics)
    : (options.topics.length > 0 ? options.topics : fallbackTopics);
  const topics = [...new Set(requestedTopics)];
  const feeds = [...new Set(options.feeds ?? existing?.feeds ?? [])];
  const intervalSeconds = Math.max(30, options.intervalSeconds ?? existing?.intervalSeconds ?? 3600);
  const queryStrategy = {
    ...(existing?.queryStrategy ?? {}),
    max_results_per_query: Math.max(5, Math.min(100,
      options.maxResultsPerQuery ?? Number(existing?.queryStrategy.max_results_per_query ?? 50))),
    overlap_hours: Math.max(1, Math.min(24 * 30,
      options.overlapHours ?? Number(existing?.queryStrategy.overlap_hours ?? 72))),
    lifetime: options.lifetime ?? existing?.queryStrategy.lifetime ?? "persistent",
  };
  const querySetChanged = Boolean(existing) && (
    JSON.stringify(existing!.topics) !== JSON.stringify(topics)
    || JSON.stringify(existing!.feeds) !== JSON.stringify(feeds)
  );
  const at = nowIso();
  store.db.prepare(
    `INSERT INTO watcher_subscriptions
       (campaign_id, enabled, interval_seconds, topics_json, feeds_json, query_strategy_json,
        next_sweep_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,NULL,?,?)
     ON CONFLICT(campaign_id) DO UPDATE SET enabled=excluded.enabled,
       interval_seconds=excluded.interval_seconds, topics_json=excluded.topics_json,
       feeds_json=excluded.feeds_json, query_strategy_json=excluded.query_strategy_json,
       updated_at=excluded.updated_at`,
  ).run(
    campaignId, options.enabled === false ? 0 : 1, intervalSeconds,
    JSON.stringify(topics), JSON.stringify(feeds), JSON.stringify(queryStrategy), at, at,
  );
  // Cursors identify a specific provider/query pair. Keeping them after a
  // configuration replacement makes old failures look active forever and can
  // accidentally carry a watermark into a semantically different search.
  // Source versions remain durable; only obsolete polling positions are reset.
  if (querySetChanged) {
    store.db.prepare("DELETE FROM watcher_cursors WHERE campaign_id=?").run(campaignId);
  }
  return { campaignId, intervalSeconds, topics, feeds, queryStrategy };
}

export function readWatcherSubscription(store: Store, campaignId: string): WatcherSubscription | null {
  const row = store.db.prepare(
    `SELECT interval_seconds, topics_json, feeds_json, query_strategy_json
     FROM watcher_subscriptions WHERE campaign_id=? AND enabled=1`,
  ).get(campaignId) as Record<string, any> | undefined;
  if (!row) return null;
  return {
    campaignId, intervalSeconds: row.interval_seconds,
    topics: JSON.parse(row.topics_json), feeds: JSON.parse(row.feeds_json),
    queryStrategy: JSON.parse(row.query_strategy_json),
  };
}

function latestWatchStrategy(store: Store, campaignId: string): Record<string, string[]> {
  const row = store.db.prepare(
    `SELECT payload_json FROM events WHERE campaign_id=? AND event_type='architect.plan_registered'
     ORDER BY seq DESC LIMIT 1`,
  ).get(campaignId) as { payload_json: string } | undefined;
  try {
    const payload = JSON.parse(row?.payload_json ?? "{}");
    return payload?.plan?.program?.watch_strategy ?? {};
  } catch { return {}; }
}

export function watcherTopics(store: Store, subscription: WatcherSubscription): string[] {
  const strategy = latestWatchStrategy(store, subscription.campaignId);
  const steers = store.db.prepare(
    `SELECT text FROM attention_steers
     WHERE campaign_id=? AND consumed_at IS NULL AND scope IN ('watcher','all') ORDER BY created_at`,
  ).all(subscription.campaignId) as Array<{ text: string }>;
  return [...new Set([
    ...subscription.topics,
    ...(strategy.core_topics ?? []), ...(strategy.adjacent_domains ?? []),
    ...(strategy.enabling_disciplines ?? []), ...(strategy.bottlenecks ?? []),
    ...steers.map((row) => row.text),
  ].map((topic) => String(topic).trim()).filter(Boolean))];
}

export function watcherSourceBacklog(
  store: Store, campaignId: string, newest: string[] = [],
): string[] {
  // Newest first. Enrichment reads a bounded batch per sweep, and this list is
  // every source ever linked to the campaign — including a long tail ingested
  // before any of it was read. Oldest-first ordering meant current work queued
  // behind that backlog and would have waited days to be looked at.
  const durable = store.db.prepare(
    `SELECT memory_id FROM campaign_memory_links
     WHERE campaign_id=? AND memory_kind='source' ORDER BY first_seen_at DESC`,
  ).all(campaignId) as Array<{ memory_id: string }>;
  return [...new Set([...newest, ...durable.map((row) => row.memory_id)])];
}

interface RecentProvider extends Provider {
  fetchRecent?(query: string, max: number, since: string | null): Promise<Lead[]>;
}

const crossrefProvider: RecentProvider = {
  id: "crossref",
  async fetch(query: string, max: number): Promise<Lead[]> {
    const mail = process.env.CROSSREF_MAILTO;
    const url = new URL("https://api.crossref.org/v1/works");
    url.searchParams.set("query", query);
    url.searchParams.set("rows", String(max));
    url.searchParams.set("sort", "published");
    url.searchParams.set("order", "desc");
    if (mail) url.searchParams.set("mailto", mail);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: { "User-Agent": `adversarial-autoresearch/0.1${mail ? ` (mailto:${mail})` : ""}` },
    });
    if (!response.ok) throw new Error(`crossref returned ${response.status}`);
    const body = await response.json() as any;
    return (body?.message?.items ?? []).map((item: any) => {
      const title = Array.isArray(item.title) ? item.title[0] : item.title;
      const published = item.published?.["date-parts"]?.[0]?.filter(Boolean).join("-") ?? "";
      return {
        url: String(item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : "")),
        title: sanitise(String(title ?? ""), 200),
        abstract: sanitise(String(item.abstract ?? item.subtitle?.[0] ?? ""), 700),
        published: sanitise(String(published), 40), sourceClass: "article" as const,
      };
    }).filter((lead: Lead) => lead.url && lead.title);
  },
  async fetchRecent(query: string, max: number, since: string | null): Promise<Lead[]> {
    const mail = process.env.CROSSREF_MAILTO;
    const url = new URL("https://api.crossref.org/v1/works");
    url.searchParams.set("query", query);
    url.searchParams.set("rows", String(max));
    url.searchParams.set("sort", "published");
    url.searchParams.set("order", "desc");
    if (since) url.searchParams.set("filter", `from-pub-date:${since.slice(0, 10)}`);
    if (mail) url.searchParams.set("mailto", mail);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: { "User-Agent": `adversarial-autoresearch/0.1${mail ? ` (mailto:${mail})` : ""}` },
    });
    if (!response.ok) throw new Error(`crossref returned ${response.status}`);
    const body = await response.json() as any;
    return (body?.message?.items ?? []).map((item: any) => ({
      url: String(item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : "")),
      title: sanitise(String(Array.isArray(item.title) ? item.title[0] : item.title ?? ""), 200),
      abstract: sanitise(String(item.abstract ?? item.subtitle?.[0] ?? ""), 700),
      published: sanitise(String(item.published?.["date-parts"]?.[0]?.filter(Boolean).join("-") ?? ""), 40),
      sourceClass: "article" as const,
    })).filter((lead: Lead) => lead.url && lead.title);
  },
};

const openAlexProvider: RecentProvider = {
  id: "openalex",
  async fetch(query: string, max: number): Promise<Lead[]> {
    const apiKey = process.env.OPENALEX_API_KEY;
    if (!apiKey) return [];
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("sort", "publication_date:desc");
    url.searchParams.set("per-page", String(max));
    url.searchParams.set("api_key", apiKey);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "adversarial-autoresearch/0.1" },
    });
    if (!response.ok) throw new Error(`openalex returned ${response.status}`);
    const body = await response.json() as any;
    return (body?.results ?? []).map((work: any) => {
      const inverted = work.abstract_inverted_index ?? {};
      const words: Array<[number, string]> = [];
      for (const [word, positions] of Object.entries(inverted)) {
        for (const position of positions as number[]) words.push([position, word]);
      }
      words.sort((a, b) => a[0] - b[0]);
      return {
        url: String(work.doi ?? work.id ?? ""), title: sanitise(String(work.display_name ?? ""), 200),
        abstract: sanitise(words.map((entry) => entry[1]).join(" "), 700),
        published: sanitise(String(work.publication_date ?? ""), 40), sourceClass: "article" as const,
      };
    }).filter((lead: Lead) => lead.url && lead.title);
  },
  async fetchRecent(query: string, max: number, since: string | null): Promise<Lead[]> {
    const apiKey = process.env.OPENALEX_API_KEY;
    if (!apiKey) return [];
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("sort", "publication_date:desc");
    url.searchParams.set("per-page", String(max));
    if (since) url.searchParams.set("filter", `from_publication_date:${since.slice(0, 10)}`);
    url.searchParams.set("api_key", apiKey);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "adversarial-autoresearch/0.1" },
    });
    if (!response.ok) throw new Error(`openalex returned ${response.status}`);
    const body = await response.json() as any;
    return (body?.results ?? []).map((work: any) => {
      const words: Array<[number, string]> = [];
      for (const [word, positions] of Object.entries(work.abstract_inverted_index ?? {})) {
        for (const position of positions as number[]) words.push([position, word]);
      }
      words.sort((a, b) => a[0] - b[0]);
      return {
        url: String(work.doi ?? work.id ?? ""), title: sanitise(String(work.display_name ?? ""), 200),
        abstract: sanitise(words.map((entry) => entry[1]).join(" "), 700),
        published: sanitise(String(work.publication_date ?? ""), 40), sourceClass: "article" as const,
      };
    }).filter((lead: Lead) => lead.url && lead.title);
  },
};

async function fetchFeed(feedUrl: string, max: number): Promise<Lead[]> {
  const response = await fetch(feedUrl, {
    signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "adversarial-autoresearch/0.1" },
  });
  if (!response.ok) throw new Error(`feed returned ${response.status}`);
  const xml = await response.text();
  const entries = xml.split(/<(?:item|entry)(?:\s[^>]*)?>/i).slice(1, max + 1);
  const pick = (entry: string, tags: string[]): string => {
    for (const tag of tags) {
      const match = entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
      if (match?.[1]) return match[1].replace(/<!\[CDATA\[|\]\]>/g, "");
    }
    return "";
  };
  return entries.map((entry) => {
    const href = entry.match(/<link[^>]+href=["']([^"']+)/i)?.[1] ?? pick(entry, ["link", "guid", "id"]);
    return {
      url: sanitise(href, 1000), title: sanitise(pick(entry, ["title"]), 200),
      abstract: sanitise(pick(entry, ["summary", "description", "content"]), 700),
      published: sanitise(pick(entry, ["published", "updated", "pubDate"]), 40),
      sourceClass: "feed" as const,
    };
  }).filter((lead) => lead.url && lead.title);
}

function providerSet(subscription: WatcherSubscription): RecentProvider[] {
  const feeds = subscription.feeds.map((feedUrl) => ({
    id: `feed:${createHash("sha256").update(feedUrl).digest("hex").slice(0, 12)}`,
    fetch: (_query: string, max: number) => fetchFeed(feedUrl, max),
  }));
  return [...PROVIDERS, crossrefProvider, ...(process.env.OPENALEX_API_KEY ? [openAlexProvider] : []), ...feeds];
}

function overlapStart(watermark: string | null, overlapHours: number): string | null {
  if (!watermark) return null;
  const time = Date.parse(watermark);
  if (!Number.isFinite(time)) return null;
  return new Date(Math.min(time, Date.now()) - overlapHours * 3_600_000).toISOString();
}

async function fetchRecent(
  provider: RecentProvider, query: string, max: number, since: string | null,
): Promise<Lead[]> {
  if (provider.fetchRecent) return provider.fetchRecent(query, max, since);
  let providerQuery = query;
  if (since && provider.id === "github") providerQuery += ` pushed:>=${since.slice(0, 10)}`;
  if (since && provider.id === "arxiv") {
    const from = since.replace(/[-:TZ.]/g, "").slice(0, 12);
    const to = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
    providerQuery = `(${query}) AND submittedDate:[${from} TO ${to}]`;
  }
  // Providers sort newest-first. Asking for one extra window and filtering
  // client-side gives feeds/HN the same overlap behaviour as APIs with native
  // date filters, while source-version hashes make repeated observations cheap.
  const fetched = await provider.fetch(providerQuery, since ? Math.min(100, max * 2) : max);
  if (!since || provider.id === "github" || provider.id === "arxiv") return fetched.slice(0, max);
  const lower = Date.parse(since);
  return fetched.filter((lead) => {
    const published = Date.parse(lead.published);
    return !Number.isFinite(published) || published >= lower;
  }).slice(0, max);
}

function campaignSource(
  store: Store, campaignId: string, provider: string, lead: Lead,
  metadata: Record<string, unknown>,
): void {
  const hash = sha256(`${lead.title}\n${lead.abstract}\n${lead.published}`);
  const id = `S-${sha256(`${campaignId}\n${provider}\n${lead.url}\n${hash}`).slice(0, 20)}`;
  const exists = store.db.prepare(
    "SELECT 1 FROM sources WHERE campaign_id=? AND canonical_url=? AND content_hash=?",
  ).get(campaignId, lead.url, hash);
  if (exists) return;
  store.transact((s) => {
    s.db.prepare(
      `INSERT INTO sources
         (source_id, campaign_id, provider, canonical_url, title, retrieved_at,
          content_hash, raw_artifact_id, source_class, reliability, metadata_json)
       VALUES (?,?,?,?,?,?,?,NULL,?,'lead',?)`,
    ).run(id, campaignId, provider, lead.url, lead.title, nowIso(), hash,
      lead.sourceClass, JSON.stringify({
        abstract: lead.abstract, published: normalizedPublished(lead.published), ...metadata,
      }));
    s.appendEvent({
      campaignId, aggregateKind: "source", aggregateId: id, aggregateRevision: 0,
      eventType: "literature.lead_found", actorKind: "system",
      idempotencyKey: `literature.lead:${campaignId}:${hash.slice(0, 20)}`,
      payload: { url: lead.url, title: lead.title, provider, published: lead.published },
    });
  });
}

function normalizedPublished(value: string): string | null {
  if (!value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function retryDelayMs(failures: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
}

function priorFailures(store: Store, campaignId: string, provider: string, queryHash: string): number {
  const row = store.db.prepare(
    "SELECT cursor_json FROM watcher_cursors WHERE campaign_id=? AND provider=? AND query_hash=?",
  ).get(campaignId, provider, queryHash) as { cursor_json: string } | undefined;
  try { return Number(JSON.parse(row?.cursor_json ?? "{}").failures ?? 0); }
  catch { return 0; }
}

export async function sweepWatcher(
  store: Store, memory: GlobalMemoryStore, subscription: WatcherSubscription,
  heartbeat?: ProgressHeartbeat,
): Promise<{ seen: number; inserted: number; lowSignal: number; failures: number; sourceVersionIds: string[] }> {
  const topics = watcherTopics(store, subscription);
  const maxResults = Math.max(5, Math.min(100,
    Number(subscription.queryStrategy.max_results_per_query ?? 50)));
  const overlapHours = Math.max(1, Math.min(24 * 30,
    Number(subscription.queryStrategy.overlap_hours ?? 72)));
  // Counted for observability only: nothing is discarded for a low score.
  let seen = 0; let inserted = 0; let lowSignal = 0; let failures = 0;
  const sourceVersionIds: string[] = [];
  for (const provider of providerSet(subscription)) {
    // Feeds are already scoped; polling once avoids duplicate copies per topic.
    const providerTopics = provider.id.startsWith("feed:") ? [""] : topics;
    for (const topic of providerTopics) {
      const query = provider.id === "crossref" || provider.id.startsWith("feed:")
        ? topic : queryFor(provider.id, topic);
      const queryHash = sha256(query || provider.id).slice(0, 20);
      const cursor = store.db.prepare(
        `SELECT next_retry_at, watermark_at FROM watcher_cursors
         WHERE campaign_id=? AND provider=? AND query_hash=?`,
      ).get(subscription.campaignId, provider.id, queryHash) as {
        next_retry_at: string | null; watermark_at: string | null;
      } | undefined;
      if (cursor?.next_retry_at && Date.parse(cursor.next_retry_at) > Date.now()) continue;
      heartbeat?.activity("tool_running", `watching ${provider.id}: ${topic || "configured feed"}`,
        { kind: "tool", name: provider.id });
      try {
        const since = overlapStart(cursor?.watermark_at ?? null, overlapHours);
        const leads = await fetchRecent(provider, query, maxResults, since);
        seen += leads.length;
        for (const lead of leads) {
          const relevance = topic
            ? assessSourceRelevance(topic, { title: lead.title, abstract: lead.abstract })
            : { keep: true, score: 0.5, matchedTerms: [], reason: "configured feed" };
          // Ingestion no longer drops a lead for want of shared vocabulary.
          // Most providers return no abstract at all, so this screen was
          // deciding from the title alone, and a genuinely cross-domain result
          // has no vocabulary in common with the topic by its very nature. The
          // score is kept as an ordering hint; enrichment reads the page and
          // makes the relevance judgement.
          if (!relevance.keep) lowSignal++;
          const observation: SourceObservation = {
            provider: provider.id, canonicalUrl: lead.url, title: lead.title,
            abstract: lead.abstract, publishedAt: normalizedPublished(lead.published),
            retrievedAt: nowIso(), sourceClass: lead.sourceClass,
            metadata: {
              query, topic, relevanceScore: relevance.score,
              matchedTerms: relevance.matchedTerms, relevanceReason: relevance.reason,
            },
          };
          const recorded = memory.recordSource(observation);
          sourceVersionIds.push(recorded.sourceVersionId);
          if (recorded.inserted) inserted++;
          linkCampaignMemory(store, subscription.campaignId, "source", recorded.sourceVersionId, relevance.score);
          campaignSource(store, subscription.campaignId, provider.id, lead, {
            query, topic, relevanceScore: relevance.score,
            matchedTerms: relevance.matchedTerms, relevanceReason: relevance.reason,
            sourceVersionId: recorded.sourceVersionId,
          });
        }
        const newest = leads.map((lead) => normalizedPublished(lead.published))
          .filter((value): value is string => Boolean(value))
          .sort().at(-1) ?? cursor?.watermark_at ?? nowIso();
        store.db.prepare(
          `INSERT INTO watcher_cursors
             (campaign_id, provider, query_hash, query_text, cursor_json, watermark_at,
              last_success_at, last_error, next_retry_at)
           VALUES (?,?,?,?,?,?,?,NULL,NULL)
           ON CONFLICT(campaign_id, provider, query_hash) DO UPDATE SET
             cursor_json=excluded.cursor_json, watermark_at=excluded.watermark_at,
             last_success_at=excluded.last_success_at, last_error=NULL, next_retry_at=NULL`,
        ).run(subscription.campaignId, provider.id, queryHash, query,
          JSON.stringify({ failures: 0, overlapHours, maxResults }), newest, nowIso());
        heartbeat?.progress("checkpoint",
          `${provider.id} returned ${leads.length}; all recorded, `
          + `${leads.filter((lead) => topic && !assessSourceRelevance(topic, lead).keep).length} `
          + "with no lexical overlap and queued behind the rest", null);
      } catch (error) {
        failures++;
        const count = priorFailures(store, subscription.campaignId, provider.id, queryHash) + 1;
        const retryAt = new Date(Date.now() + retryDelayMs(count)).toISOString();
        store.db.prepare(
          `INSERT INTO watcher_cursors
             (campaign_id, provider, query_hash, query_text, cursor_json, last_error, next_retry_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(campaign_id, provider, query_hash) DO UPDATE SET
             cursor_json=excluded.cursor_json, last_error=excluded.last_error,
             next_retry_at=excluded.next_retry_at`,
        ).run(subscription.campaignId, provider.id, queryHash, query,
          JSON.stringify({ failures: count }), String(error).slice(0, 500), retryAt);
        heartbeat?.activity("waiting_external", `${provider.id} failed; retry after ${retryAt}`, null);
      }
    }
  }
  const next = new Date(Date.now() + subscription.intervalSeconds * 1000).toISOString();
  store.db.prepare("UPDATE watcher_subscriptions SET next_sweep_at=?, updated_at=? WHERE campaign_id=?")
    .run(next, nowIso(), subscription.campaignId);
  return { seen, inserted, lowSignal, failures, sourceVersionIds: [...new Set(sourceVersionIds)] };
}
