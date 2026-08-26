/**
 * Literature scout: a perpetual watcher for work related to the campaign.
 *
 * Runs alongside a campaign and never inside it. The manager deliberately has
 * NO tools - its context packet is its whole world - so the scout cannot be a
 * tool the manager calls. It is a separate process that writes into `sources`,
 * and the packet surfaces what it found. That separation is what keeps the
 * manager's inputs reproducible: every cycle can be replayed from a packet that
 * was written to disk, including whatever literature was known at the time.
 *
 * ## Fetched text is data, never instructions
 *
 * This is the one genuinely new attack surface in the system. Everything else
 * the harness reads is either its own output or a candidate diff it treats as
 * hostile by default. Paper titles and abstracts come from an open API that
 * anyone can post to, and they end up inside a model's context.
 *
 * So the scout:
 *   - stores only title, URL, date and abstract - never full text, never HTML
 *   - strips control characters and collapses whitespace
 *   - clips hard, so a long injected payload cannot dominate the packet
 *   - neutralises the obvious framing tricks (fenced blocks, role headers)
 *   - marks every record `reliability = 'lead'`, never 'primary'
 *
 * A lead is a pointer to read something, not evidence. Nothing the scout writes
 * can support or refute a claim on its own: promoting a lead to evidence
 * requires a human, exactly as the autonomy ladder says A4 requires.
 *
 *   usage: tsx src/scout.ts --campaign cuda-001 --query "cuda softmax kernel"
 *                           [--every 3600] [--once]
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { latestCampaignId, nowIso, sha256, Store } from "./store/store.js";

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, ".autoresearch");

const argOf = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string): boolean => process.argv.includes(`--${n}`);

const CAMPAIGN = argOf("campaign") ?? process.env.AR_CAMPAIGN ?? latestCampaignId();
const EVERY_MS = Number(argOf("every") ?? 3600) * 1000;
const MAX_RESULTS = Number(argOf("max") ?? 15);

/** Hard caps. A lead that cannot be read in a few seconds is not a lead. */
const MAX_TITLE = 200;
const MAX_ABSTRACT = 700;

export interface Lead {
  url: string;
  title: string;
  abstract: string;
  published: string;
  /** What kind of thing this is, for `sources.source_class`. */
  sourceClass: "preprint" | "repository" | "discussion" | "release" | "article" | "feed";
}

/**
 * A place to watch.
 *
 * Deliberately a small interface. Research does not only appear on arXiv: a
 * kernel technique often lands as a GitHub release or a thread weeks before any
 * paper, and for fast-moving systems work the preprint is frequently the LAST
 * artifact rather than the first. Each provider maps its own response into the
 * same bounded `Lead`, so the sanitising and the untrusted framing downstream
 * are identical no matter where the text came from.
 */
export interface Provider {
  id: string;
  /** Fetch recent items. Must never throw for an empty result. */
  fetch(query: string, max: number): Promise<Lead[]>;
}

/**
 * Make third-party text safe to place in a model's context.
 *
 * Not a claim that injection is solved - it is not, and cannot be by filtering.
 * The real defence is structural: leads are labelled as untrusted, cannot alter
 * a threshold, and cannot become evidence without a human. This function only
 * removes the cheapest tricks and bounds the blast radius.
 */
/**
 * Strip characters that can hide or reorder text in a terminal or a prompt.
 *
 * Written as a codepoint test rather than a regex character class on purpose:
 * the class needs escapes, and every attempt to write it through a shell here
 * embedded the raw control bytes instead - which is exactly the payload it is
 * meant to remove.
 */
function stripHidden(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const hidden =
      c < 0x20 ||                       // C0 controls
      (c >= 0x7f && c <= 0x9f) ||       // DEL and C1 controls
      (c >= 0x200b && c <= 0x200f) ||   // zero-width and directional marks
      c === 0x2028 || c === 0x2029 ||   // line and paragraph separators
      (c >= 0x202a && c <= 0x202e) ||   // bidi embedding and overrides
      (c >= 0x2066 && c <= 0x2069);     // bidi isolates
    out += hidden ? " " : ch;
  }
  return out;
}

export function sanitise(text: string, max: number): string {
  return stripHidden(text)
    // Fenced blocks and role headers are how injected text tries to look like
    // part of the prompt rather than part of the data.
    .replace(/```+/g, "'''")
    .replace(/^\s*(system|assistant|user|developer)\s*:/gim, "$1 -")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Query arXiv's public API. No key, no account, deliberately read-only. */
export async function fetchArxiv(query: string, max: number): Promise<Lead[]> {
  const url = "http://export.arxiv.org/api/query"
    + `?search_query=${encodeURIComponent(query)}`
    + `&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;

  const res = await fetch(url, { headers: { "User-Agent": "adversarial-autoresearch/0.1" } });
  if (!res.ok) throw new Error(`arXiv returned ${res.status}`);
  const xml = await res.text();

  const leads: Lead[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const pick = (tag: string): string => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m?.[1] ?? "";
    };
    const link = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? "";
    if (!link) continue;
    leads.push({
      url: link,
      title: sanitise(pick("title"), MAX_TITLE),
      abstract: sanitise(pick("summary"), MAX_ABSTRACT),
      published: sanitise(pick("published"), 40),
      sourceClass: "preprint",
    });
  }
  return leads;
}


/**
 * GitHub: code and releases, which is where a kernel technique usually lands
 * first. Unauthenticated search allows ~10 requests/minute, and one sweep an
 * hour is well inside that; set GITHUB_TOKEN to raise the ceiling.
 */
export const githubProvider: Provider = {
  id: "github",
  async fetch(query: string, max: number): Promise<Lead[]> {
    const headers: Record<string, string> = {
      "User-Agent": "adversarial-autoresearch/0.1",
      Accept: "application/vnd.github+json",
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    const url = "https://api.github.com/search/repositories"
      + `?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${max}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`github returned ${res.status}`);
    const body = await res.json() as { items?: Array<Record<string, any>> };

    return (body.items ?? []).map((r) => ({
      url: String(r.html_url ?? ""),
      title: sanitise(`${r.full_name ?? ""} (${r.stargazers_count ?? 0} stars)`, MAX_TITLE),
      abstract: sanitise(String(r.description ?? ""), MAX_ABSTRACT),
      published: sanitise(String(r.pushed_at ?? ""), 40),
      sourceClass: "repository" as const,
    })).filter((l) => l.url && l.abstract.length > 0);
  },
};

/**
 * Hacker News via Algolia: the discussion layer. Catches releases, blog posts
 * and announcements that never become papers. Free, no key, no account.
 */
export const hackerNewsProvider: Provider = {
  id: "hackernews",
  async fetch(query: string, max: number): Promise<Lead[]> {
    const url = "https://hn.algolia.com/api/v1/search_by_date"
      + `?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${max}`;
    const res = await fetch(url, { headers: { "User-Agent": "adversarial-autoresearch/0.1" } });
    if (!res.ok) throw new Error(`hn returned ${res.status}`);
    const body = await res.json() as { hits?: Array<Record<string, any>> };

    return (body.hits ?? []).map((h) => ({
      url: String(h.url || `https://news.ycombinator.com/item?id=${h.objectID}`),
      title: sanitise(String(h.title ?? ""), MAX_TITLE),
      abstract: sanitise(String(h.story_text ?? h._highlightResult?.title?.value ?? ""), MAX_ABSTRACT),
      published: sanitise(String(h.created_at ?? ""), 40),
      sourceClass: "discussion" as const,
    })).filter((l) => l.url && l.title);
  },
};

export const arxivProvider: Provider = {
  id: "arxiv",
  fetch: (query, max) => fetchArxiv(query, max),
};

export const PROVIDERS: Provider[] = [arxivProvider, githubProvider, hackerNewsProvider];

/**
 * Queries differ per provider on purpose.
 *
 * arXiv wants its own field syntax; GitHub wants keywords plus qualifiers; HN
 * wants plain words. Sending one string to all three returns nothing useful
 * from at least two of them.
 */
export function queryFor(providerId: string, topic: string): string {
  switch (providerId) {
    case "arxiv":
      return topic.split(/\s+/).filter(Boolean).map((w) => `all:"${w}"`).join(" OR ");
    case "github":
      // A stars floor, because sorting purely by "recently pushed" returned
      // one-star scratch repos with a matching word in the readme. Recency
      // still drives the sort; the floor only removes noise that no reader
      // would follow up. GITHUB_MIN_STARS tunes it per campaign.
      return `${topic} in:name,description,readme stars:>=${process.env.GITHUB_MIN_STARS ?? 25}`;
    default:
      return topic;
  }
}

/** Record leads, skipping ones already known. Returns how many were new. */
export function recordLeads(store: Store, campaignId: string, provider: string, leads: Lead[]): number {
  let added = 0;
  for (const lead of leads) {
    const hash = sha256(`${lead.title}\n${lead.abstract}`);
    // sources.source_id is a global primary key, so it has to be scoped by
    // campaign as well as by content. Two campaigns scouting overlapping
    // topics both pass the per-campaign duplicate check above and then
    // collided on the same content-only id, which failed every arXiv sweep
    // of the second campaign.
    const sourceId = `S-${sha256([campaignId, lead.url, hash].join("|")).slice(0, 12)}`;
    const exists = store.db.prepare(
      "SELECT 1 FROM sources WHERE campaign_id=? AND canonical_url=? AND content_hash=?",
    ).get(campaignId, lead.url, hash);
    if (exists) continue;

    store.transact((s) => {
      s.db.prepare(
        `INSERT INTO sources
           (source_id, campaign_id, provider, canonical_url, title, retrieved_at,
            content_hash, raw_artifact_id, source_class, reliability, metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        sourceId, campaignId, provider, lead.url, lead.title, nowIso(),
        hash, null, lead.sourceClass, "lead",
        JSON.stringify({ abstract: lead.abstract, published: lead.published }),
      );
      s.appendEvent({
        campaignId, aggregateKind: "campaign", aggregateId: campaignId, aggregateRevision: 10,
        eventType: "literature.lead_found", actorKind: "system",
        idempotencyKey: `literature.lead:${campaignId}:${hash.slice(0, 16)}`,
        payload: { url: lead.url, title: lead.title, provider, published: lead.published },
      });
    });
    added++;
  }
  return added;
}

async function sweep(store: Store, topic: string): Promise<void> {
  for (const provider of PROVIDERS) {
    try {
      const leads = await provider.fetch(queryFor(provider.id, topic), MAX_RESULTS);
      const added = recordLeads(store, CAMPAIGN, provider.id, leads);
      console.log(`[${nowIso()}] ${provider.id}: ${leads.length} seen, ${added} new`);
    } catch (err) {
      // One provider failing must not take the others down with it, and a scout
      // that dies takes its monitoring with it.
      console.log(`[${nowIso()}] ${provider.id} failed: ${String(err).slice(0, 160)}`);
    }
  }
}

/**
 * States in which a campaign can still receive literature. A campaign that has
 * stopped, completed or failed is finished with, and one that was never created
 * cannot be scouted for at all.
 */
const SCOUTABLE_STATUSES = new Set(["draft", "ready", "running", "paused"]);

/**
 * The scout runs beside a campaign rather than inside it, so before this check
 * nothing ended it when the campaign did. Orphans outlived their campaigns by
 * days, kept writing leads nobody would read, and — because they hold their
 * code in memory for as long as they run — kept executing whatever revision
 * they happened to start with. Re-reading the status each sweep binds the
 * process lifetime to the campaign's own lifecycle.
 */
export function scoutableStatus(store: Store, campaignId: string): string | null {
  const row = store.db.prepare(
    "SELECT status FROM campaigns WHERE campaign_id=?",
  ).get(campaignId) as { status: string } | undefined;
  if (!row) return null;
  return SCOUTABLE_STATUSES.has(row.status) ? row.status : null;
}

async function main(): Promise<void> {
  // A plain topic. Each provider translates it into its own query syntax.
  const query = argOf("query") ?? argOf("topic") ?? "CUDA softmax kernel optimization";
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const store = Store.open(join(STATE_DIR, "state.sqlite"));

  const stop = (reason: string): void => {
    console.log(`[${nowIso()}] campaign ${CAMPAIGN} ${reason}; scout exiting`);
    store.close();
    process.exit(0);
  };

  if (scoutableStatus(store, CAMPAIGN) === null) {
    stop("is not accepting literature");
  }

  console.log(`literature scout on ${CAMPAIGN}`);
  console.log(`topic : ${query}`);
  console.log(`watch : ${PROVIDERS.map((p) => p.id).join(", ")}`);
  console.log(`every : ${has("once") ? "once" : `${EVERY_MS / 1000}s`}`);

  await sweep(store, query);
  if (has("once")) { store.close(); return; }

  setInterval(() => {
    // Checked every sweep, not only at startup: a campaign stops long after
    // its scout began, and that is exactly the case that used to leak.
    if (scoutableStatus(store, CAMPAIGN) === null) stop("is no longer accepting literature");
    void sweep(store, query);
  }, EVERY_MS);
}

if (process.argv[1]?.endsWith("scout.ts") || process.argv[1]?.endsWith("scout.js")) {
  void main();
}
