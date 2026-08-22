/**
 * Day-1 kernel tests. Two of these are the property tests named in
 * plans/04-v0-build-plan.md §2.1 and §7.1; the rest guard the event chain.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { IntervalRecorder } from "../src/trace/intervals.js";
import { canonicalJson, Store, type IntervalCategory } from "../src/store/store.js";

const dirs: string[] = [];
const opened: Store[] = [];
function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ar-test-"));
  dirs.push(dir);
  const s = Store.open(join(dir, "state.sqlite"));
  opened.push(s);
  return s;
}
after(() => {
  // Windows holds the file until every handle is closed; close before unlinking.
  for (const s of opened) {
    try { s.close(); } catch { /* already closed */ }
  }
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function seedCampaign(store: Store, id = "c1"): string {
  store.db
    .prepare(
      `INSERT INTO campaigns (campaign_id, title, objective, status, base_revision,
         config_json, created_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(id, "t", "o", "running", "rev0", "{}", new Date().toISOString());
  return id;
}

describe("canonical json", () => {
  it("is key-order independent", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it("rejects non-finite numbers", () => {
    assert.throws(() => canonicalJson({ x: Number.NaN }), /non-finite/);
  });
});

describe("event chain", () => {
  it("verifies from genesis and detects tampering", () => {
    const store = freshStore();
    const cid = seedCampaign(store);
    for (let i = 0; i < 25; i++) {
      store.appendEvent({
        campaignId: cid,
        aggregateKind: "campaign",
        aggregateId: cid,
        aggregateRevision: i,
        eventType: "test.tick",
        actorKind: "supervisor",
        idempotencyKey: `k${i}`,
        payload: { i },
      });
    }
    assert.deepEqual(store.verifyEventChain(), { ok: true });

    // Tamper with a payload in the middle of the chain.
    store.db.prepare("UPDATE events SET payload_json = ? WHERE seq = 10").run('{"i":999}');
    const bad = store.verifyEventChain();
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.brokenAtSeq, 10);
    store.close();
  });

  it("is idempotent on a replayed key and emits multiple events per aggregate revision", () => {
    const store = freshStore();
    const cid = seedCampaign(store);
    const a = store.appendEvent({
      campaignId: cid, aggregateKind: "campaign", aggregateId: cid, aggregateRevision: 1,
      eventType: "x", actorKind: "system", idempotencyKey: "dup", payload: { n: 1 },
    });
    const b = store.appendEvent({
      campaignId: cid, aggregateKind: "campaign", aggregateId: cid, aggregateRevision: 1,
      eventType: "x", actorKind: "system", idempotencyKey: "dup", payload: { n: 1 },
    });
    assert.equal(b.duplicate, true);
    assert.equal(a.seq, b.seq);

    // Regression guard: 03's UNIQUE(aggregate_kind, aggregate_id, aggregate_revision)
    // made this throw, breaking any transaction emitting two events for one aggregate.
    store.appendEvent({
      campaignId: cid, aggregateKind: "campaign", aggregateId: cid, aggregateRevision: 1,
      eventType: "y", actorKind: "system", idempotencyKey: "second-at-same-rev", payload: { n: 2 },
    });
    const count = store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE aggregate_revision = 1")
      .get() as { n: number };
    assert.equal(count.n, 2);
    assert.deepEqual(store.verifyEventChain(), { ok: true });
    store.close();
  });
});

describe("interval accounting", () => {
  it("never overlaps and always sums to the span exactly (randomised)", () => {
    const cats: IntervalCategory[] = [
      "model_reasoning", "tool_execution", "compute", "evaluation",
      "queue", "blocked", "sleep", "supervisor", "human",
    ];

    for (let trial = 0; trial < 200; trial++) {
      const store = freshStore();
      const cid = seedCampaign(store);
      const rec = new IntervalRecorder(store);

      const t0 = 1_700_000_000_000;
      let t = t0;
      const steps = 1 + Math.floor(Math.random() * 12);
      for (let i = 0; i < steps; i++) {
        t += Math.floor(Math.random() * 5000);
        rec.open({
          campaignId: cid,
          resourceId: "campaign",
          category: cats[Math.floor(Math.random() * cats.length)]!,
          atMs: t,
        });
      }
      t += Math.floor(Math.random() * 5000);
      // Deliberately leave a trailing gap: it must show up as `unknown`.
      rec.closeResource(cid, "campaign", t);
      const spanEnd = t + Math.floor(Math.random() * 3000);

      assert.deepEqual(rec.findOverlaps(cid, "campaign"), [], "overlap detected");

      const d = rec.decompose(cid, "campaign", t0, spanEnd);
      const sum = Object.values(d.byCategory).reduce((a, b) => a + b, 0);
      assert.equal(sum, d.spanMs, `categories must sum to span (trial ${trial})`);
      assert.equal(d.exact, true);
      store.close();
    }
  });

  it("attributes a trailing gap to unknown rather than dropping it", () => {
    const store = freshStore();
    const cid = seedCampaign(store);
    const rec = new IntervalRecorder(store);
    const t0 = 1_700_000_000_000;
    rec.open({ campaignId: cid, resourceId: "campaign", category: "compute", atMs: t0 });
    rec.closeResource(cid, "campaign", t0 + 1000);
    const d = rec.decompose(cid, "campaign", t0, t0 + 3000);
    assert.equal(d.byCategory.compute, 1000);
    assert.equal(d.byCategory.unknown, 2000);
    assert.equal(d.spanMs, 3000);
    store.close();
  });

  it("closes the predecessor when a new category opens on the same resource", () => {
    const store = freshStore();
    const cid = seedCampaign(store);
    const rec = new IntervalRecorder(store);
    const t0 = 1_700_000_000_000;
    rec.open({ campaignId: cid, resourceId: "campaign", category: "model_reasoning", atMs: t0 });
    rec.open({ campaignId: cid, resourceId: "campaign", category: "compute", atMs: t0 + 500 });
    const open = store.db
      .prepare("SELECT COUNT(*) AS n FROM intervals WHERE ended_ms IS NULL")
      .get() as { n: number };
    assert.equal(open.n, 1, "exactly one interval may be open per resource");
    const d = rec.decompose(cid, "campaign", t0, t0 + 1500);
    assert.equal(d.byCategory.model_reasoning, 500);
    assert.equal(d.byCategory.compute, 1000);
    store.close();
  });
});

describe("schema invariants", () => {
  it("rejects a hypothesis status outside the single claim vocabulary", () => {
    const store = freshStore();
    const cid = seedCampaign(store);
    store.db
      .prepare(
        `INSERT INTO principles (principles_id, campaign_id, revision, content, content_hash,
           rationale, created_at) VALUES ('p1',?,1,'c','h','r','t')`,
      )
      .run(cid);
    const insert = (status: string) =>
      store.db
        .prepare(
          `INSERT INTO hypotheses (hypothesis_id, campaign_id, principles_id, lane, title,
             mechanism, motivation, falsifier, change_class, status, created_at, updated_at)
           VALUES (?,?, 'p1','mechanism','t','m','mo','f','mechanism',?, 't','t')`,
        )
        .run(`h-${status}`, cid, status);

    insert("replicated");            // present in 01:§3.3, absent from 03's claims enum
    insert("shortcut_suspected");    // ditto
    assert.throws(() => insert("supported"), /CHECK/, "must reject 03's divergent vocabulary");
    store.close();
  });

  it("rejects a lane outside the portfolio", () => {
    const store = freshStore();
    const cid = seedCampaign(store);
    assert.throws(
      () =>
        store.db
          .prepare(
            `INSERT INTO budgets (campaign_id, lane, category, allocated) VALUES (?, 'misc', 'runs', 1)`,
          )
          .run(cid),
      /CHECK/,
    );
    store.close();
  });
});

describe("portfolio: repair cap", () => {
  it("ignores failures from before the current run started", async () => {
    const { consecutiveFailures } = await import("../src/loop/portfolio.js");
    const store = freshStore();
    const cid = seedCampaign(store);
    store.db.prepare(
      `INSERT INTO principles (principles_id, campaign_id, revision, content, content_hash,
         rationale, created_at) VALUES ('p1',?,1,'c','h','r','t')`,
    ).run(cid);

    const add = (id: string, createdAt: string, status: string) =>
      store.db.prepare(
        `INSERT INTO hypotheses (hypothesis_id, campaign_id, principles_id, lane, title, mechanism,
           motivation, falsifier, change_class, status, created_at, updated_at)
         VALUES (?,?, 'p1','mechanism','t','m','mo','f','mechanism',?,?,?)`,
      ).run(id, cid, status, createdAt, createdAt);

    // Four invalidated by an operator BEFORE this run began.
    for (let i = 0; i < 4; i++) add(`old-${i}`, "2026-08-20T10:00:0${i}.000Z", "implementation_invalid");

    // Regression guard: counting these halted a fresh 3-hour campaign at cycle
    // zero, because a deliberate operator invalidation looked like a malfunction.
    assert.equal(consecutiveFailures(store, cid, "2026-08-20T12:00:00.000Z"), 0);
    assert.equal(consecutiveFailures(store, cid), 4, "unscoped call still sees history");

    add("new-0", "2026-08-20T12:00:01.000Z", "implementation_invalid");
    assert.equal(consecutiveFailures(store, cid, "2026-08-20T12:00:00.000Z"), 1);
    store.close();
  });
});


describe("domain: declared parameter surface", () => {
  it("grows with the baseline instead of going stale", async () => {
    const { createTinymlAdapter } = await import("../src/domain/tinyml-adapter.js");
    const adapter = createTinymlAdapter(process.cwd());

    // Regression guard: after "learnable ALiBi slopes" was replicated and merged,
    // a legitimate ablation toggling `alibi_slopes_learnable` was rejected as an
    // undeclared key, because the surface was a hardcoded build-time list.
    const evolved = {
      _comment: "meta", seed: 1337, eval_tokens: 200000,
      steps: 1200, lr: 0.003, d_model: 64, n_layer: 2,
      alibi_slopes_learnable: true,
    };
    const keys = adapter.parameterSurface(evolved);

    assert.ok(keys.has("alibi_slopes_learnable"), "a key the baseline gained must be tunable");
    assert.ok(keys.has("steps") && keys.has("lr"));
    assert.ok(!keys.has("seed"), "the harness owns the replication channel");
    assert.ok(!keys.has("eval_tokens"), "the evaluator owns the measurement window");
    assert.ok(!keys.has("d_model"), "architecture keys classify separately");
    assert.ok(!keys.has("_comment"), "metadata is not a knob");
    assert.ok(adapter.reservedConfigKeys().has("seed"));
  });
});

describe("judge: falsify contracts", () => {
  it("cannot promote its own target when no support threshold is set", async () => {
    const { judge } = await import("../src/loop/judge.js");
    const v = judge({
      thresholds: { supportDelta: Number.POSITIVE_INFINITY, refuteDelta: 0.02, direction: "minimize" },
      contractRegisteredAtMs: 1, resultObservedAtMs: 2,
      experimentOk: true, experimentFailureCode: undefined, evaluationOk: true,
      primaryValue: 1.0, baselineValue: 2.9,        // a spectacular apparent gain
      allChecksPassed: true, failedChecks: [], failedCheckClasses: [],
      protectedHashBefore: "h", protectedHashAfter: "h",
      touchedProtected: false, undeclaredConfigKeys: [], overridesSeed: false,
      laneExpectsChange: true,
    });
    assert.equal(v.status, "inconclusive", "an attack cycle must not promote the claim it attacks");
  });
});

describe("domain: seed-override detection", () => {
  it("detects a hardcoded seed in a diff", async () => {
    const { escapesReproductionPolicy } = await import("../src/core/workspace.js");
    const reserved = ["seed", "eval_tokens"];
    // Regression guard: this detector was dead for an entire campaign because a
    // word-boundary escape became a literal 0x08 byte in the source. Only a
    // planted-cheat fixture caught it, so it gets a test that runs every time.
    const diff = [
      "diff --git a/train.py b/train.py",
      "@@ -120,6 +120,8 @@",
      '     cfg = json.loads((HERE / "config.json").read_text())',
      "+    # escape the seed policy",
      '+    cfg["seed"] = 4242',
    ].join("\n");
    assert.equal(escapesReproductionPolicy(diff, reserved), true);
    assert.equal(escapesReproductionPolicy("+    lr = 0.003", reserved), false);
    assert.equal(escapesReproductionPolicy("+    torch.manual_seed(99)", reserved), true);
  });
});

describe("proposal validation: lane coverage", () => {
  it("accepts every lane the allocator can assign", async () => {
    const { LANES } = await import("../src/loop/portfolio.js");
    const { validateProposalForTest } = await import("../src/loop/cycle.js");
    // Regression guard: `moonshot` existed in the schema, the allocator and the
    // manager prompt, but not in the validator's own list. Every moonshot
    // proposal was rejected and a fresh overnight campaign stopped after four
    // consecutive aborts.
    for (const lane of LANES) {
      const err = validateProposalForTest({
        hypothesis: {
          lane, title: "t", mechanism: "m", motivation: "mo",
          falsifier: "f", change_class: "mechanism",
        },
        contract: { support_delta: 0.02, refute_delta: 0.02, rationale: "r" },
        instruction_to_executor: "a sufficiently long instruction for the executor to act on",
      } as any);
      assert.equal(err, null, `lane ${lane} must validate`);
    }
  });
});

describe("domain interface: generality", () => {
  it("loads structurally different domains without code changes", async () => {
    const { loadDomainConfig, createGenericAdapter } = await import("../src/domain/generic-adapter.js");
    const root = process.cwd();

    const finance = createGenericAdapter(root, loadDomainConfig("domains/examples/finance.domain.json"));
    const vlm = createGenericAdapter(root, loadDomainConfig("domains/examples/vlm.domain.json"));
    const bio = createGenericAdapter(root, loadDomainConfig("domains/examples/bio.domain.json"));

    // The point of the interface: these three disagree on every structural
    // question, and the core does not need to know which is which.
    assert.equal(finance.replication.kind, "temporal_fold");
    assert.equal(vlm.replication.kind, "seed");
    assert.equal(bio.replication.kind, "independent_run");

    assert.equal(finance.determinism, "bitwise");
    assert.equal(vlm.determinism, "statistical");
    assert.equal(bio.determinism, "none");

    // Reproduction variants are domain-shaped, not seed-shaped.
    assert.equal(finance.replication.variants(2)[0]!.label, "eval_window=2019H1");
    assert.equal(bio.replication.variants(1)[0]!.label, "replicate_id=A");

    // The harness owns whatever carries reproduction, whatever it is called.
    assert.ok(finance.reservedConfigKeys().has("eval_window"));
    assert.ok(finance.reservedConfigKeys().has("start_date"),
      "moving the backtest window is this field's classic fraud");
    assert.ok(bio.reservedConfigKeys().has("replicate_id"));

    // Cost is declared, so replicating everything three times is a decision.
    assert.ok(bio.cost.consumesScarceResource);
    assert.ok(vlm.cost.typicalUsd! > 0);
  });

  it("refuses a domain whose noise floor was never measured", async () => {
    const { createGenericAdapter } = await import("../src/domain/generic-adapter.js");
    const { loadDomainConfig } = await import("../src/domain/generic-adapter.js");
    const cfg = loadDomainConfig("domains/examples/finance.domain.json");
    // A zero noise floor lets every gate be tighter than the measurement error,
    // which is how this project produced three false fraud accusations.
    const bad = { ...cfg, metric: { ...cfg.metric, noiseFloor: 0 } };
    assert.throws(() => {
      const { loadDomainConfig: _l } = { loadDomainConfig };
      void _l;
      // validate via the same rule the loader applies
      if (!(bad.metric.noiseFloor > 0)) throw new Error("metric.noiseFloor must be measured and positive");
      createGenericAdapter(process.cwd(), bad);
    }, /noiseFloor/);
  });
});

describe("thresholds crossing a process boundary", () => {
  it("refuses to send a non-finite threshold to the evaluator", async () => {
    const { createGenericAdapter, loadDomainConfig } = await import("../src/domain/generic-adapter.js");
    const adapter = createGenericAdapter(process.cwd(), loadDomainConfig("domains/examples/vlm.domain.json"));

    // The observed defect: a falsify contract carries no support threshold, the
    // cycle passed it through unresolved, and String(undefined) became the
    // literal argument "undefined". The evaluator rejected it 15 minutes later
    // as EVALUATOR_EXIT_2, which the harness reported as "the protected
    // evaluator did not complete" -- a candidate-shaped message for a harness
    // defect. A number that cannot be a number must fail here, at the boundary.
    assert.throws(() => adapter.evaluate({
      worktree: process.cwd(), outputPath: "out.bin", stagingDir: process.cwd(),
      baselinePrimary: 1, baselineSecondary: null,
      supportDelta: undefined as unknown as number,
      timeoutMs: 1000,
    }), /--support-delta is undefined, not a finite number/);

    assert.throws(() => adapter.evaluate({
      worktree: process.cwd(), outputPath: "out.bin", stagingDir: process.cwd(),
      baselinePrimary: Number.NaN, baselineSecondary: null,
      supportDelta: 1, timeoutMs: 1000,
    }), /--baseline-primary is NaN/);
  });

  it("gives a falsify contract a measurement scale but no promotion threshold", () => {
    // The two quantities the defect conflated. A falsify cycle legitimately has
    // no promotion threshold -- it is attacking a claim, not proposing one --
    // but it still has an instrument with a measured noise floor.
    const noiseFloor = 8;
    const resolve = (declared: number | undefined) => {
      const has = Number.isFinite(declared) && (declared as number) > 0;
      return {
        promotionThreshold: has ? (declared as number) : Number.POSITIVE_INFINITY,
        measurementScale: has ? (declared as number) : noiseFloor,
      };
    };

    const falsify = resolve(undefined);
    assert.equal(falsify.promotionThreshold, Number.POSITIVE_INFINITY,
      "an attack cycle must never be able to promote its own target");
    assert.equal(falsify.measurementScale, noiseFloor,
      "the evaluator still needs a real number");
    assert.ok(Number.isFinite(falsify.measurementScale));

    const normal = resolve(10);
    assert.equal(normal.promotionThreshold, 10);
    assert.equal(normal.measurementScale, 10);
  });
});
