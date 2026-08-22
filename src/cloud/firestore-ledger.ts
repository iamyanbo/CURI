/** Transactional Firestore implementation of the immutable evidence ledger. */

import { randomUUID } from "node:crypto";

import { Firestore, FieldValue, type DocumentData } from "@google-cloud/firestore";

import {
  canonicalJson, nowIso, SCHEMA_VERSION, sha256,
  type AppendEventInput, type AppendedEvent,
} from "../store/store.js";

const ZERO_HASH = "0".repeat(64);

export interface LedgerEventDocument {
  seq: number;
  eventId: string;
  occurredAt: string;
  recordedAt: string;
  campaignId: string | null;
  aggregateKind: string;
  aggregateId: string;
  aggregateRevision: number;
  eventType: string;
  actorKind: string;
  attemptId: string | null;
  idempotencyKey: string;
  payload: unknown;
  payloadJson: string;
  payloadHash: string;
  prevChainHash: string | null;
  chainHash: string;
  schemaVersion: number;
}

export function calculateLedgerEvent(
  input: AppendEventInput,
  seq: number,
  previousHash: string | null,
  identity: { eventId: string; occurredAt: string; recordedAt: string },
): LedgerEventDocument {
  const payloadJson = canonicalJson(input.payload);
  const payloadHash = sha256(payloadJson);
  const framed = canonicalJson({
    eventId: identity.eventId,
    occurredAt: identity.occurredAt,
    campaignId: input.campaignId,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateRevision: input.aggregateRevision,
    eventType: input.eventType,
    actorKind: input.actorKind,
    attemptId: input.attemptId ?? null,
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    schemaVersion: SCHEMA_VERSION,
  });
  return {
    seq,
    eventId: identity.eventId,
    occurredAt: identity.occurredAt,
    recordedAt: identity.recordedAt,
    campaignId: input.campaignId,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateRevision: input.aggregateRevision,
    eventType: input.eventType,
    actorKind: input.actorKind,
    attemptId: input.attemptId ?? null,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    payloadJson,
    payloadHash,
    prevChainHash: previousHash,
    chainHash: sha256(`${previousHash ?? ZERO_HASH}${framed}`),
    schemaVersion: SCHEMA_VERSION,
  };
}

function eventDocumentId(seq: number): string {
  return String(seq).padStart(16, "0");
}

/**
 * One global chain is retained for parity with the SQLite implementation.
 * The campaign loop is single-writer, so the head document is intentionally a
 * serialization point rather than a hidden concurrency feature.
 */
export class FirestoreLedger {
  constructor(
    readonly firestore = new Firestore(),
    readonly namespace = process.env.AR_FIRESTORE_NAMESPACE ?? "adversarial-autoresearch",
  ) {}

  private root() { return this.firestore.collection(this.namespace).doc("ledger"); }
  private head() { return this.root().collection("meta").doc("head"); }
  private events() { return this.root().collection("events"); }
  private keys() { return this.root().collection("idempotency"); }

  async appendEvent(input: AppendEventInput): Promise<AppendedEvent> {
    const keyRef = this.keys().doc(sha256(input.idempotencyKey));
    const headRef = this.head();
    return await this.firestore.runTransaction(async (transaction) => {
      // Firestore requires transaction reads to precede writes.
      const [keySnapshot, headSnapshot] = await Promise.all([
        transaction.get(keyRef), transaction.get(headRef),
      ]);
      if (keySnapshot.exists) {
        const prior = keySnapshot.data() as { seq: number; eventId: string; chainHash: string };
        return { seq: prior.seq, eventId: prior.eventId, chainHash: prior.chainHash, duplicate: true };
      }

      const head = headSnapshot.exists
        ? headSnapshot.data() as { seq: number; chainHash: string }
        : { seq: 0, chainHash: null as unknown as string };
      const seq = head.seq + 1;
      const occurredAt = input.occurredAt ?? nowIso();
      const event = calculateLedgerEvent(input, seq, head.seq === 0 ? null : head.chainHash, {
        eventId: randomUUID(), occurredAt, recordedAt: nowIso(),
      });
      const eventRef = this.events().doc(eventDocumentId(seq));

      transaction.create(eventRef, { ...event, createdAtServer: FieldValue.serverTimestamp() });
      transaction.create(keyRef, {
        idempotencyKey: input.idempotencyKey,
        seq,
        eventId: event.eventId,
        chainHash: event.chainHash,
      });
      transaction.set(headRef, { seq, chainHash: event.chainHash, updatedAt: FieldValue.serverTimestamp() });
      return { seq, eventId: event.eventId, chainHash: event.chainHash, duplicate: false };
    });
  }

  async verifyEventChain(): Promise<{ ok: true; count: number } | { ok: false; brokenAtSeq: number; reason: string }> {
    const snapshot = await this.events().orderBy("seq", "asc").get();
    let previous: string | null = null;
    let expectedSeq = 1;
    for (const document of snapshot.docs) {
      const row = document.data() as LedgerEventDocument & DocumentData;
      if (row.seq !== expectedSeq) return { ok: false, brokenAtSeq: expectedSeq, reason: `missing sequence ${expectedSeq}` };
      if ((row.prevChainHash ?? null) !== previous) return { ok: false, brokenAtSeq: row.seq, reason: "previous hash mismatch" };
      if (sha256(row.payloadJson) !== row.payloadHash) return { ok: false, brokenAtSeq: row.seq, reason: "payload hash mismatch" };
      const recalculated = calculateLedgerEvent({
        campaignId: row.campaignId,
        aggregateKind: row.aggregateKind,
        aggregateId: row.aggregateId,
        aggregateRevision: row.aggregateRevision,
        eventType: row.eventType,
        actorKind: row.actorKind as AppendEventInput["actorKind"],
        attemptId: row.attemptId,
        idempotencyKey: row.idempotencyKey,
        payload: JSON.parse(row.payloadJson),
        occurredAt: row.occurredAt,
      }, row.seq, previous, { eventId: row.eventId, occurredAt: row.occurredAt, recordedAt: row.recordedAt });
      if (recalculated.chainHash !== row.chainHash) return { ok: false, brokenAtSeq: row.seq, reason: "chain hash mismatch" };
      previous = row.chainHash;
      expectedSeq++;
    }
    return { ok: true, count: expectedSeq - 1 };
  }
}
