/**
 * Harvest the sources a subagent actually consulted, out of its sealed trace.
 *
 * The manager and executor have search tools, and what they read genuinely
 * shapes what they propose - one campaign's kernel work was informed by
 * PyTorch's own `SoftMax.cu` and two NVIDIA engineering posts. None of that was
 * anywhere an operator could see it: the URLs sat inside `tool_result` blobs in
 * an NDJSON artifact, while the dashboard's source list showed only what a
 * separate scout process had polled.
 *
 * A claim's provenance has to include what the agent read before proposing it.
 * This walks sealed agent traces, pulls every URL out of search and fetch
 * results, and records them in `sources` attributed to the ROLE that found them
 * and the CYCLE it happened in.
 *
 * Everything harvested is `reliability = 'lead'`, the same as scout output:
 * untrusted third-party text that can suggest an idea and can never move a
 * threshold or stand as evidence.
 *
 *   usage: tsx src/harvest.ts [--campaign id] [--quiet]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { latestCampaignId, nowIso, sha256, Store } from "./store/store.js";

const ROOT = process.cwd();
const argOf = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Tool names whose results carry things the agent read. */
const SEARCH_TOOLS = /^(web_search|arxiv_search|code_search|fetch_content|get_search_content)$/;

/** Junk that appears in prose but is not a source anyone can follow. */
function usableUrl(u: string): boolean {
  if (u.length < 16) return false;                 // truncated fragments
  if (!/^https?:\/\/[^/]+\.[a-z]{2,}/i.test(u)) return false;
  if (/\.(png|jpe?g|gif|svg|css|js|ico)$/i.test(u)) return false;
  return true;
}

/** A readable name for a bare URL, since search prose rarely gives a clean title. */
function titleFor(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const tail = path.slice(-2).join("/") || u.hostname;
    return `${u.hostname.replace(/^www\./, "")} · ${tail}`.slice(0, 190);
  } catch {
    return url.slice(0, 190);
  }
}

export interface Harvested {
  url: string;
  title: string;
  tool: string;
  role: string;
  hypothesisId: string | null;
}

export function harvestCampaign(store: Store, campaignId: string): Harvested[] {
  const rows = store.db.prepare(
    `SELECT ar.relative_path, r.kind AS role, r.hypothesis_id
     FROM artifacts ar
     JOIN attempts a ON a.attempt_id = ar.attempt_id
     JOIN runs r ON r.run_id = a.run_id
     WHERE ar.campaign_id = ? AND ar.kind = 'agent-trace'`,
  ).all(campaignId) as Array<{ relative_path: string; role: string; hypothesis_id: string | null }>;

  const out: Harvested[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    let lines: string[];
    try {
      lines = readFileSync(join(ROOT, ".autoresearch", "artifacts", row.relative_path), "utf8")
        .split("\n").filter(Boolean);
    } catch {
      continue;                                     // an unreadable trace is not fatal
    }
    for (const line of lines) {
      let step: any;
      try { step = JSON.parse(line); } catch { continue; }
      if (step.kind !== "tool_result") continue;
      if (!SEARCH_TOOLS.test(String(step.toolName ?? ""))) continue;

      for (const m of String(step.content ?? "").matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) {
        const url = m[0].replace(/[.,;:]+$/, "");
        if (!usableUrl(url) || seen.has(url)) continue;
        seen.add(url);
        out.push({
          url, title: titleFor(url), tool: String(step.toolName),
          role: row.role, hypothesisId: row.hypothesis_id,
        });
      }
    }
  }
  return out;
}

/** Record harvested URLs as leads. Returns how many were new. */
export function recordHarvest(store: Store, campaignId: string, items: Harvested[]): number {
  let added = 0;
  for (const it of items) {
    const hash = sha256(it.url);
    const exists = store.db.prepare(
      "SELECT 1 FROM sources WHERE campaign_id = ? AND canonical_url = ? AND content_hash = ?",
    ).get(campaignId, it.url, hash);
    if (exists) continue;

    store.transact((s) => {
      s.db.prepare(
        `INSERT INTO sources
           (source_id, campaign_id, provider, canonical_url, title, retrieved_at,
            content_hash, raw_artifact_id, source_class, reliability, metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `S-${hash.slice(0, 12)}`, campaignId, `agent:${it.role}`, it.url, it.title, nowIso(),
        hash, null, "consulted", "lead",
        JSON.stringify({ tool: it.tool, role: it.role, hypothesis: it.hypothesisId }),
      );
    });
    added++;
  }
  return added;
}

function main(): void {
  const campaign = argOf("campaign") ?? process.env.AR_CAMPAIGN ?? latestCampaignId();
  const store = Store.open(join(ROOT, ".autoresearch", "state.sqlite"));
  const items = harvestCampaign(store, campaign);
  const added = recordHarvest(store, campaign, items);

  if (!process.argv.includes("--quiet")) {
    const byRole: Record<string, number> = {};
    for (const i of items) byRole[i.role] = (byRole[i.role] ?? 0) + 1;
    console.log(`harvested ${items.length} distinct URLs from ${campaign} traces (${added} new)`);
    for (const [role, n] of Object.entries(byRole)) console.log(`  ${role}: ${n}`);
  }
  store.close();
}

if (process.argv[1]?.endsWith("harvest.ts") || process.argv[1]?.endsWith("harvest.js")) main();
