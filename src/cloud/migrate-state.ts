/** Verified, opt-in migration from the local SQLite projection to Firestore. */

import Database from "better-sqlite3";
import { Firestore } from "@google-cloud/firestore";

import { canonicalJson, sha256, Store } from "../store/store.js";
import { FirestoreLedger, type LedgerEventDocument } from "./firestore-ledger.js";

const argv = process.argv.slice(2);
const valueOf = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};

const dbPath = valueOf("db", ".autoresearch/state.sqlite");
const namespace = valueOf("namespace", process.env.AR_FIRESTORE_NAMESPACE ?? "adversarial-autoresearch");
const commit = argv.includes("--commit");
const projectId = valueOf("project", process.env.GOOGLE_CLOUD_PROJECT ?? "");

const TABLE_IDS: Record<string, string[]> = {
  campaigns: ["campaign_id"], principles: ["principles_id"], hypotheses: ["hypothesis_id"],
  contracts: ["contract_id"], runs: ["run_id"], attempts: ["attempt_id"], artifacts: ["artifact_id"],
  evaluations: ["evaluation_id"], sources: ["source_id"], evidence: ["evidence_id"],
  budgets: ["campaign_id", "lane", "category"], human_interventions: ["intervention_id"],
  intervals: ["interval_id"],
};

function documentId(table: string, row: Record<string, unknown>): string {
  const fields = TABLE_IDS[table];
  if (!fields) throw new Error(`no document identity for ${table}`);
  return sha256(canonicalJson(fields.map((field) => row[field])));
}

function eventFromSql(row: Record<string, any>): LedgerEventDocument {
  return {
    seq: Number(row.seq), eventId: row.event_id, occurredAt: row.occurred_at, recordedAt: row.recorded_at,
    campaignId: row.campaign_id ?? null, aggregateKind: row.aggregate_kind, aggregateId: row.aggregate_id,
    aggregateRevision: Number(row.aggregate_revision), eventType: row.event_type, actorKind: row.actor_kind,
    attemptId: row.attempt_id ?? null, idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json), payloadJson: row.payload_json, payloadHash: row.payload_hash,
    prevChainHash: row.prev_chain_hash ?? null, chainHash: row.chain_hash, schemaVersion: Number(row.schema_version),
  };
}

async function main() {
  const local = Store.open(dbPath);
  const verification = local.verifyEventChain();
  if (!verification.ok) throw new Error(`local event chain is broken at ${verification.brokenAtSeq}: ${verification.reason}`);
  const db = local.db as Database.Database;
  const tableRows = Object.fromEntries(Object.keys(TABLE_IDS).map((table) => [
    table, db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
  ]));
  const events = (db.prepare("SELECT * FROM events ORDER BY seq").all() as Record<string, any>[]).map(eventFromSql);
  const summary = Object.fromEntries(Object.entries(tableRows).map(([table, rows]) => [table, rows.length]));
  console.log(JSON.stringify({ mode: commit ? "commit" : "dry-run", projectId: projectId || "ADC default", namespace, events: events.length, tables: summary }, null, 2));
  if (!commit) { local.close(); return; }

  const firestore = new Firestore(projectId ? { projectId } : undefined);
  const root = firestore.collection(namespace).doc("ledger");
  const headRef = root.collection("meta").doc("head");
  if ((await headRef.get()).exists) throw new Error(`Firestore namespace ${namespace} is not empty; refusing to merge ledgers`);

  let batch = firestore.batch();
  let writes = 0;
  const flush = async () => {
    if (writes === 0) return;
    await batch.commit();
    batch = firestore.batch();
    writes = 0;
  };
  const enqueue = async (ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) => {
    batch.set(ref, data);
    writes++;
    if (writes >= 400) await flush();
  };

  for (const [table, rows] of Object.entries(tableRows)) {
    const collection = firestore.collection(`${namespace}-${table}`);
    for (const row of rows) await enqueue(collection.doc(documentId(table, row)), row);
  }
  for (const event of events) {
    await enqueue(root.collection("events").doc(String(event.seq).padStart(16, "0")), event);
    await enqueue(root.collection("idempotency").doc(sha256(event.idempotencyKey)), {
      idempotencyKey: event.idempotencyKey, seq: event.seq, eventId: event.eventId, chainHash: event.chainHash,
    });
  }
  await flush();
  const tail = events.at(-1);
  await headRef.set({ seq: tail?.seq ?? 0, chainHash: tail?.chainHash ?? null, migratedFrom: dbPath });
  const cloudVerification = await new FirestoreLedger(firestore, namespace).verifyEventChain();
  if (!cloudVerification.ok) throw new Error(`cloud event chain verification failed at ${cloudVerification.brokenAtSeq}: ${cloudVerification.reason}`);
  if (cloudVerification.count !== events.length) throw new Error(`cloud event count ${cloudVerification.count} does not match local ${events.length}`);
  console.log(`migration complete: ${cloudVerification.count} verified events`);
  local.close();
}

await main();
