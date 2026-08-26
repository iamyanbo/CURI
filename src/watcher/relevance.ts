/** Deterministic first-pass relevance screening for watcher search results. */

export interface SourceRelevance {
  keep: boolean;
  score: number;
  matchedTerms: string[];
  matchedPhrases: string[];
  topicTerms: string[];
  reason: string;
}

const STOP_WORDS = new Set([
  "about", "after", "against", "also", "among", "and", "analysis", "approach", "are",
  "based", "been", "being", "between", "can", "could", "did", "different", "does",
  "during", "each", "exploring", "figure", "for", "from", "had", "has", "have", "how", "including",
  "into", "its", "may", "method", "model", "models", "more", "most", "new", "not",
  "our", "paper", "partially", "per", "present", "relationship", "research", "result",
  "results", "study", "system", "systems", "than", "that", "the", "their", "these",
  "this", "those", "through", "using", "versus", "was", "were", "what", "when", "where",
  "which", "while", "will", "with", "without", "would",
]);

// Long but broad words must not single-handedly admit an unrelated result.
const BROAD_TECH_WORDS = new Set([
  "attention", "blocking", "calculation", "compute", "computing", "cross", "data",
  "evaluation", "full", "learning", "machine", "mechanism", "memory", "neural",
  "optimization", "performance", "processing", "register", "thread", "vectors",
]);

// A single match from this vocabulary is meaningful enough to survive the
// cheap provider-result screen. Generic words such as `register` or `blocking`
// deliberately are not anchors; they only count when they form a phrase such
// as `register blocking`.
const DOMAIN_ANCHORS = new Set([
  "cuda", "cudnn", "flashattention", "gemm", "gemv", "nvcc",
  "ptx", "simd", "softmax", "tensorcore", "tensorcores", "tflops", "triton", "warp",
]);

const GENERIC_UPPERCASE_TERMS = new Set(["ai", "cpu", "gpu", "llm", "ml", "nvidia"]);

function terms(value: string): string[] {
  return String(value ?? "").toLowerCase()
    .replace(/&(?:[a-z]+|#\d+);/g, " ")
    .split(/[^a-z0-9+#.]+/)
    .map((term) => term.replace(/^\.+|\.+$/g, ""))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

function phrases(values: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index + 1 < values.length; index += 1) {
    result.push(`${values[index]} ${values[index + 1]}`);
  }
  return result;
}

function explicitTopicAnchors(topic: string, topicTerms: string[]): Set<string> {
  const uppercase = new Set(
    (topic.match(/\b[A-Z][A-Z0-9.+-]{2,}\b/g) ?? [])
      .flatMap((value) => terms(value)).filter((term) => !GENERIC_UPPERCASE_TERMS.has(term)),
  );
  return new Set(topicTerms.filter((term) =>
    DOMAIN_ANCHORS.has(term) || uppercase.has(term) || /\d/.test(term),
  ));
}

/**
 * Search APIs are candidate generators, not relevance judges. A result must
 * share concrete vocabulary with the exact topic that produced it. This still
 * permits cross-domain discovery because adjacent domains are searched as
 * their own topics; it only rejects results that do not match even that topic.
 */
export function assessSourceRelevance(
  topic: string,
  source: { title?: string | null; abstract?: string | null },
): SourceRelevance {
  const topicTerms = [...new Set(terms(topic))];
  if (topicTerms.length === 0) {
    return {
      keep: false, score: 0, matchedTerms: [], matchedPhrases: [], topicTerms,
      reason: "no usable topic terms",
    };
  }
  const sourceTermList = terms(`${source.title ?? ""} ${source.abstract ?? ""}`);
  const sourceTerms = new Set(sourceTermList);
  const matchedTerms = topicTerms.filter((term) => sourceTerms.has(term));
  const topicPhraseSet = new Set(phrases(terms(topic)));
  const matchedPhrases = [...new Set(phrases(sourceTermList).filter((phrase) => topicPhraseSet.has(phrase)))];
  const anchors = explicitTopicAnchors(topic, topicTerms);
  const matchedAnchors = matchedTerms.filter((term) => anchors.has(term));
  const strongMatches = matchedTerms.filter((term) => term.length >= 10 && !BROAD_TECH_WORDS.has(term));
  const coverage = matchedTerms.length / topicTerms.length;
  const keep = topicTerms.length <= 2
    ? matchedTerms.length >= 1
    : matchedPhrases.length >= 1
      || matchedAnchors.length >= 1
      || (matchedTerms.length >= 3 && strongMatches.length >= 2);
  const score = Math.max(0, Math.min(1,
    0.1 + coverage * 0.5
      + Math.min(0.2, matchedPhrases.length * 0.1)
      + Math.min(0.2, matchedAnchors.length * 0.1),
  ));
  return {
    keep, score: keep ? score : 0, matchedTerms, matchedPhrases, topicTerms,
    reason: keep
      ? `matched ${[
        ...matchedAnchors.map((term) => `anchor:${term}`),
        ...matchedPhrases.map((phrase) => `phrase:${phrase}`),
      ].join(", ") || matchedTerms.join(", ") || "a short topic"}`
      : `no technical anchor or phrase overlap with topic (${topicTerms.slice(0, 8).join(", ")})`,
  };
}

export function storedSourceIsRelevant(source: {
  title?: string | null; abstract?: string | null; metadata?: Record<string, unknown> | null;
}): boolean {
  const topic = String(source.metadata?.topic ?? "").trim();
  return !topic || assessSourceRelevance(topic, source).keep;
}
