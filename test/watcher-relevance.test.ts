import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { doiFrom, looksClosed } from "../src/research/open-access.js";

import { discoveryQuery, plausibleDiscovery } from "../src/research/watcher.js";

test("lean watcher reads sources before relevance decisions", () => {
  const source = readFileSync(join(process.cwd(), "src", "research", "watcher.ts"), "utf8");
  assert.match(source, /acquireDocument/);
  assert.match(source, /admit_source/);
  assert.match(source, /Discovery metadata is deliberately not a relevance verdict/);
  assert.doesNotMatch(source, /assessSourceRelevance|two valid supporting spans|validateBrief/);
});

test("discovery narrows provider queries without pretending to admit a source", () => {
  const query = discoveryQuery("arxiv", "transformer inference KV cache eviction compression");
  assert.match(query, / AND /); assert.doesNotMatch(query, / OR /);
  assert.equal(plausibleDiscovery("transformer inference KV cache eviction compression", {
    title: "KV cache compression for transformer inference", abstract: "eviction under memory pressure",
  }), true);
  assert.equal(plausibleDiscovery("transformer inference KV cache eviction compression", {
    title: "Two-loop Higgs phenomenology", abstract: "five-dimensional supersymmetry",
  }), false);
});

test("a paywalled publisher is recorded as closed access, not as unreadable", () => {
  // A third of one direction's sources came back unreadable, every one a 403
  // from Elsevier, SSRN or Taylor & Francis. Those are not broken papers.
  assert.equal(looksClosed("https://www.sciencedirect.com/science/article/pii/S0304405X16301490", "Error: HTTP 403"), true);
  assert.equal(looksClosed("https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2942641", "Error: HTTP 403"), true);
  // A genuine retrieval failure on an open host is still just a failure.
  assert.equal(looksClosed("https://example.org/paper", "Error: connect ETIMEDOUT"), false);
  // DOIs are recovered from either the doi.org form or a publisher URL.
  assert.equal(doiFrom("https://doi.org/10.1016/j.euroecorev.2024.104916"), "10.1016/j.euroecorev.2024.104916");
  assert.equal(doiFrom("https://www.tandfonline.com/doi/abs/10.1080/1351847X.2022.2062250"), "10.1080/1351847X.2022.2062250");
  assert.equal(doiFrom("https://arxiv.org/abs/2306.14048"), null);
});
