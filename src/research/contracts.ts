/**
 * Lean research has no agent-authored JSON contract. Scientific intent and
 * conclusions are preserved verbatim as Markdown; tool names carry the small
 * amount of routing information the runtime needs.
 */
export const MARKDOWN_RESEARCH_CONTRACT = [
  "Scientific content is unrestricted Markdown.",
  "Tool names select actions; payloads are not parsed into a domain schema.",
  "No global score, incumbent, or baseline advancement exists.",
  "Every claim uses the evaluation method appropriate to its question.",
].join("\n");
