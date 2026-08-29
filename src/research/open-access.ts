/**
 * Finding a readable copy of a paper the publisher will not serve.
 *
 * A third of one direction's sources came back unreadable, every one of them a
 * 403 from Elsevier, SSRN or Taylor & Francis. That is not a retrieval bug: those
 * hosts refuse automated clients by design, and the finance literature lives
 * disproportionately behind them. Giving up there quietly narrows what the
 * watcher can read to whatever happens to be ungated.
 *
 * So a blocked DOI is resolved through Unpaywall, which indexes author-deposited
 * and publisher open-access copies, and falls back to an arXiv title match. Only
 * locations the rights-holder has made openly available are followed — the point
 * is to read the version that is legitimately readable, not to get around a
 * paywall.
 */

const DOI = /\b10\.\d{4,9}\/[^\s"'<>]+/i;
/** Hosts that answer an automated fetch with 403 and will not be retried directly. */
const CLOSED_HOSTS = /(?:sciencedirect|elsevier|tandfonline|springer|wiley|jstor|ssrn|sagepub|academic\.oup)\./i;

export function doiFrom(url: string): string | null {
  const match = url.match(DOI);
  return match ? match[0].replace(/[.,;)]+$/, "") : null;
}

export function looksClosed(url: string, error: string): boolean {
  return /HTTP 40[13]/.test(error) || (CLOSED_HOSTS.test(url) && /HTTP \d{3}|too little readable/.test(error));
}

/** An openly available copy of a DOI, or null. Never a paywalled location. */
export async function openAccessUrl(doi: string, mailto: string): Promise<string | null> {
  const endpoint = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(mailto)}`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "lean-research-watcher/1.0" } });
  if (!response.ok) return null;
  const body = await response.json() as {
    is_oa?: boolean;
    best_oa_location?: { url_for_pdf?: string; url?: string } | null;
    oa_locations?: Array<{ url_for_pdf?: string; url?: string }>;
  };
  if (!body.is_oa) return null;
  const candidates = [body.best_oa_location, ...(body.oa_locations ?? [])];
  for (const location of candidates) {
    const url = location?.url_for_pdf || location?.url;
    if (url && !CLOSED_HOSTS.test(url)) return url;
  }
  return null;
}

/** An arXiv preprint whose title matches, or null. */
export async function arxivByTitle(title: string): Promise<string | null> {
  const clean = title.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 12) return null;
  const query = `http://export.arxiv.org/api/query?search_query=ti:%22${encodeURIComponent(clean)}%22&max_results=1`;
  const response = await fetch(query, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  const feed = await response.text();
  const id = feed.match(/<id>(http:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/i)?.[1];
  const found = feed.match(/<title>([\s\S]*?)<\/title>/gi)?.[1]?.replace(/<\/?title>/gi, "").trim();
  if (!id || !found) return null;
  // Guard against the API returning a loosely related paper.
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = new Set(norm(found).split(" ").filter(w => w.length > 3));
  const b = new Set(norm(clean).split(" ").filter(w => w.length > 3));
  const shared = [...a].filter(w => b.has(w)).length;
  if (!a.size || shared / a.size < 0.7) return null;
  return id;
}

/**
 * Unpaywall asks for a contact address so it can reach someone about a badly
 * behaved client. It is a courtesy the API documents, not a credential.
 */
export function openAccessContact(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPEN_ACCESS_CONTACT?.trim() || env.SEC_USER_AGENT?.trim() || "research@example.com";
}
