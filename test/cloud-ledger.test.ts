import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateLedgerEvent } from "../src/cloud/firestore-ledger.js";

describe("cloud ledger framing", () => {
  it("is deterministic and extends the predecessor hash", () => {
    const input = {
      campaignId: "C1", aggregateKind: "claim", aggregateId: "H1", aggregateRevision: 1,
      eventType: "claim.judged", actorKind: "supervisor" as const,
      idempotencyKey: "claim.judged:H1", payload: { status: "refuted", delta: -1 },
    };
    const identity = { eventId: "event-1", occurredAt: "2026-08-22T00:00:00.000Z", recordedAt: "2026-08-22T00:00:01.000Z" };
    const first = calculateLedgerEvent(input, 1, null, identity);
    const again = calculateLedgerEvent(input, 1, null, identity);
    assert.deepEqual(first, again);
    const second = calculateLedgerEvent({ ...input, idempotencyKey: "claim.judged:H2", aggregateId: "H2" }, 2, first.chainHash,
      { ...identity, eventId: "event-2" });
    assert.equal(second.prevChainHash, first.chainHash);
    assert.notEqual(second.chainHash, first.chainHash);
  });

  it("changes when evidence payload changes", () => {
    const base = {
      campaignId: "C1", aggregateKind: "evidence", aggregateId: "E1", aggregateRevision: 1,
      eventType: "evidence.recorded", actorKind: "evaluator" as const, idempotencyKey: "E1",
    };
    const identity = { eventId: "event-1", occurredAt: "2026-08-22T00:00:00.000Z", recordedAt: "2026-08-22T00:00:01.000Z" };
    const a = calculateLedgerEvent({ ...base, payload: { value: 1 } }, 1, null, identity);
    const b = calculateLedgerEvent({ ...base, payload: { value: 2 } }, 1, null, identity);
    assert.notEqual(a.chainHash, b.chainHash);
  });
});
