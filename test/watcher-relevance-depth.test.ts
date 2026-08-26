/**
 * The watcher exists to surface macro and cross-domain work: a mathematical
 * result that bears on matrix multiplication, or LLM work that carries over to
 * VLMs. These tests pin the two properties that made it fail at that job — a
 * lexical screen standing in for a relevance judgement, and an unvalidated
 * model reply that ended every sweep before anything was read.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assessSourceRelevance } from "../src/watcher/relevance.js";
import { enrichmentBatchSize, validateEnrichment } from "../src/watcher/enrichment.js";
import { watcherSourceBacklog } from "../src/watcher/service.js";
import { Store } from "../src/store/store.js";

const GEMM_TOPIC = "high-performance CPU BLAS/GEMM practice (register blocking, packing, microkernel chaining)";

test("keyword overlap is not a relevance judgement, in either direction", () => {
  // Observed live: organic chemistry admitted into a CUDA attention campaign
  // because one bigram of the topic string appears in the abstract.
  const chemistry = assessSourceRelevance(GEMM_TOPIC, {
    title: "Manipulating Molecular Packing Mode and Excited-State Dynamics",
    abstract: "A high performance organic semiconductor with tuned molecular packing.",
  });
  assert.equal(chemistry.keep, true, "the lexical screen admits this, which is why it cannot be the judge");

  // And the case the watcher exists for: a genuine cross-domain result that
  // shares no vocabulary with the topic at all.
  const mathematics = assessSourceRelevance(GEMM_TOPIC, {
    title: "A new upper bound on the rank of the bilinear complexity tensor",
    abstract: "We lower the exponent for the product of two square arrays over any field.",
  });
  assert.equal(mathematics.keep, false,
    "a screen that rejects this must never hold a veto over what gets read");
});

test("a malformed enrichment item costs that item, not the whole sweep", () => {
  const reply = {
    sourceAssessments: [
      { sourceVersionId: "SV-1", relevant: true, confidence: 0.9, contentBasis: "full_text", rationale: "reads on the bottleneck" },
      { sourceVersionId: "SV-2", relevant: true, confidence: 5, contentBasis: "full_text", rationale: "confidence out of range" },
    ],
    mechanisms: [
      {
        canonicalName: "register tiling", description: "d", operation: "o", bottleneck: "b",
        intervention: "i", prerequisites: [], constraints: [], claimedEffects: [], aliases: [],
        originDomains: [], confidence: 0.8, sourceVersionIds: ["SV-1"],
      },
      // The exact shape that threw "Cannot read properties of undefined
      // (reading 'toLowerCase')" and ended every watcher run.
      {
        description: "no canonical name", operation: "o", bottleneck: "b", intervention: "i",
        prerequisites: [], constraints: [], claimedEffects: [], aliases: [],
        originDomains: [], confidence: 0.8, sourceVersionIds: ["SV-1"],
      },
    ],
    ideas: [
      // The shape behind "Cannot read properties of undefined (reading 'trim')".
      { action: "adopt", targetDomain: "cuda", rationale: "r", sourceVersionIds: ["SV-1"] },
    ],
    relations: [
      { fromMechanismName: "register tiling", relation: "enables", confidence: 0.5, rationale: "r" },
    ],
  };

  const clean = validateEnrichment(reply);
  assert.equal(clean.mechanisms.length, 1);
  assert.equal(clean.mechanisms[0]!.canonicalName, "register tiling");
  assert.equal(clean.sourceAssessments.length, 1, "an out-of-range confidence is dropped");
  assert.equal(clean.ideas.length, 0, "an idea with no title is dropped rather than thrown on");
  assert.equal(clean.relations.length, 0, "a relation missing an endpoint cannot be resolved");

  // Every field the caller dereferences without guarding must now be present.
  for (const mechanism of clean.mechanisms) assert.equal(typeof mechanism.canonicalName, "string");
  for (const relation of clean.relations) {
    assert.equal(typeof relation.fromMechanismName, "string");
    assert.equal(typeof relation.toMechanismName, "string");
  }
  for (const idea of clean.ideas) assert.equal(typeof idea.title, "string");
});

test("the enrichment batch is bounded by what one prompt can carry", () => {
  const original = process.env.AR_ENRICHMENT_BATCH;
  try {
    delete process.env.AR_ENRICHMENT_BATCH;
    assert.equal(enrichmentBatchSize(), 24);
    process.env.AR_ENRICHMENT_BATCH = "8";
    assert.equal(enrichmentBatchSize(), 8);
    // The reply schema caps each array at 30, so a larger batch could not be
    // assessed in full even if it were requested.
    process.env.AR_ENRICHMENT_BATCH = "500";
    assert.equal(enrichmentBatchSize(), 30);
    process.env.AR_ENRICHMENT_BATCH = "0";
    assert.throws(() => enrichmentBatchSize(), /positive number/);
  } finally {
    if (original === undefined) delete process.env.AR_ENRICHMENT_BATCH;
    else process.env.AR_ENRICHMENT_BATCH = original;
  }
});

test("the enrichment queue is ordered newest first", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-backlog-"));
  const store = Store.open(join(root, "state.sqlite"));
  try {
    store.db.prepare(
      `INSERT INTO campaigns (campaign_id, title, objective, status, base_revision, revision, config_json, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("c-1", "c-1", "o", "running", "0".repeat(40), 0, "{}", "2026-08-01T00:00:00.000Z");
    const link = store.db.prepare(
      `INSERT INTO campaign_memory_links (campaign_id, memory_kind, memory_id, relevance, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?)`,
    );
    link.run("c-1", "source", "SV-old", 0.5, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    link.run("c-1", "source", "SV-mid", 0.5, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
    link.run("c-1", "source", "SV-new", 0.5, "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");

    const backlog = watcherSourceBacklog(store, "c-1");
    assert.deepEqual(backlog, ["SV-new", "SV-mid", "SV-old"],
      "a legacy tail must not push current work past the batch cut");

    // Sources from the sweep that just ran come ahead of the durable list.
    assert.equal(watcherSourceBacklog(store, "c-1", ["SV-fresh"])[0], "SV-fresh");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reply that is not the expected shape yields empty lists, never a throw", () => {
  assert.deepEqual(validateEnrichment(null).mechanisms, []);
  assert.deepEqual(validateEnrichment({ mechanisms: "not an array" }).mechanisms, []);
  assert.deepEqual(validateEnrichment({}).relations, []);
});
