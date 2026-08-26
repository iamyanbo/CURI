import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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
