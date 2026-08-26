import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Firestore, WriteBatch } from "@google-cloud/firestore";

import { assertPublishable } from "./trace-publish.js";
import type { PublishedRecord } from "./publish.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The published mirror: a read-only view of a research record held in Firestore.
 *
 * It deliberately shares nothing with the operator dashboard's server except the
 * page itself. There is no control endpoint, no synthesis review, no workspace
 * file access and no local filesystem read, because this process is the one that
 * faces the public internet. Anything it cannot serve is simply absent from the
 * state it returns, and the page degrades to the parts it can show.
 */

/**
 * Published collections and the field that identifies a document in each.
 *
 * The identifier is declared per collection rather than guessed from whichever
 * *_id field happens to be present: runs and commands both carry a task_id, so a
 * generic fallback keyed several runs to the same document and they silently
 * overwrote one another while the publish still reported success.
 */
export const MIRROR_COLLECTIONS = [
  { name: "components", idField: "component_id" },
  { name: "componentRelations", idField: null },
  { name: "tasks", idField: "task_id" },
  { name: "outcomes", idField: "outcome_id" },
  { name: "syntheses", idField: "synthesis_id" },
  { name: "sources", idField: "source_id" },
  { name: "runs", idField: "run_id" },
  { name: "commands", idField: null },
  // Trace steps arrive grouped: a trace is append-only, so all but the last
  // group are final once written and republishing them is idempotent. Grouping
  // keeps a thousand-step run to a dozen writes per sync.
  { name: "traceSteps", idField: "chunk_id" },
] as const;

export function firestoreClient(projectId?: string): Firestore {
  return new Firestore(projectId ? { projectId } : {});
}

/** Writes a record as one document per entity, under the direction. */
export async function publishToFirestore(input: {
  record: PublishedRecord; projectId?: string; databaseId?: string;
}): Promise<{ directionId: string; documents: number }> {
  const firestore = input.projectId || input.databaseId
    ? new Firestore({ ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.databaseId ? { databaseId: input.databaseId } : {}) })
    : new Firestore();
  // Nothing is written until the assembled record passes the identifier check.
  // The per-field redactors run on the way in; this is the check on the way out,
  // and it is the reason publishing can be automatic rather than reviewed by
  // hand before each sync.
  assertPublishable(input.record);
  const directionId = String(input.record.direction.direction_id);
  const root = firestore.collection("directions").doc(directionId);
  let documents = 0;

  await root.set({
    ...input.record.direction,
    spend: input.record.spend,
    publishedAt: input.record.publishedAt,
    counts: Object.fromEntries(MIRROR_COLLECTIONS.map(({ name }) =>
      [name, (input.record[name] as unknown[]).length])),
  });
  documents++;

  // Batches are chunked because Firestore rejects one over 500 writes, and only
  // documents that have actually gone are deleted. Emptying each collection
  // before rewriting it doubled the writes on every sync and left a reader who
  // arrived mid-publish looking at a half-empty record.
  const commitInChunks = async (work: Array<(batch: WriteBatch) => void>) => {
    for (let index = 0; index < work.length; index += 400) {
      const batch = firestore.batch();
      for (const apply of work.slice(index, index + 400)) apply(batch);
      await batch.commit();
    }
  };

  for (const { name, idField } of MIRROR_COLLECTIONS) {
    const rows = input.record[name] as Array<Record<string, unknown>>;
    const collection = root.collection(name);
    const wanted = new Map<string, Record<string, unknown>>();
    for (const [index, row] of rows.entries()) {
      const declared = idField ? row[idField] : undefined;
      const id = declared === undefined || declared === null
        ? `${name}-${String(index).padStart(5, "0")}`
        : String(declared);
      wanted.set(id, row);
    }
    const existing = await collection.listDocuments();
    await commitInChunks(existing.filter((doc) => !wanted.has(doc.id))
      .map((doc) => (batch: WriteBatch) => { batch.delete(doc); }));
    await commitInChunks([...wanted].map(([id, row]) => (batch: WriteBatch) => {
      batch.set(collection.doc(id), row); documents++;
    }));
  }
  return { directionId, documents };
}

export async function readPublishedRecord(input: {
  directionId?: string; projectId?: string; databaseId?: string;
}): Promise<PublishedRecord | null> {
  const firestore = input.projectId || input.databaseId
    ? new Firestore({ ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.databaseId ? { databaseId: input.databaseId } : {}) })
    : new Firestore();
  const directions = firestore.collection("directions");
  const doc = input.directionId
    ? await directions.doc(input.directionId).get()
    : (await directions.orderBy("publishedAt", "desc").limit(1).get()).docs.at(0);
  if (!doc || !doc.exists) return null;
  const direction = doc.data() as Record<string, unknown>;
  const record: Record<string, unknown> = {
    direction, spend: direction.spend ?? {}, publishedAt: direction.publishedAt ?? null,
  };
  for (const { name } of MIRROR_COLLECTIONS) {
    const snapshot = await directions.doc(doc.id).collection(name).get();
    record[name] = snapshot.docs.map((entry) => entry.data());
  }
  return record as unknown as PublishedRecord;
}

/** Shapes a published record into what the dashboard page expects to receive. */
export function mirrorState(record: PublishedRecord): Record<string, unknown> {
  // Chunks are stored per run and in order; the page wants one flat trace.
  const byRun = new Map<string, Array<Record<string, unknown>>>();
  for (const chunk of record.traceSteps ?? []) {
    const runId = String(chunk.run_id);
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId)!.push(chunk);
  }
  const stepsFor = (runId: string) => (byRun.get(runId) ?? [])
    .sort((left, right) => Number(left.from_seq ?? 0) - Number(right.from_seq ?? 0))
    .flatMap((chunk) => (chunk.steps as Array<Record<string, unknown>>) ?? []);

  const lanes = record.runs.map((run) => {
    const start = Date.parse(String(run.started_at));
    const end = run.completed_at ? Date.parse(String(run.completed_at)) : start;
    const task = record.tasks.find((item) => item.task_id === run.task_id);
    return {
      id: run.run_id, role: run.role, state: run.state, taskId: run.task_id ?? null,
      componentId: task?.component_id ?? null, componentIds: task?.component_id ? [task.component_id] : [],
      title: task ? (String(task.brief_md).split(/\r?\n/)[0] ?? "").replace(/^#+\s*/, "") : String(run.role),
      startedAt: run.started_at, completedAt: run.completed_at,
      startMs: start, endMs: end, durationMs: Math.max(0, end - start),
      model: run.model, tokens: Number(run.input_tokens ?? 0) + Number(run.output_tokens ?? 0),
      costUsd: run.cost_usd, failure: run.failure,
      segments: run.segments ?? [],
      breakdown: run.breakdown ?? { total: Math.max(0, end - start) },
      trace: stepsFor(String(run.run_id)),
      traceTotal: Number(run.trace_steps ?? 0),
      traceWithheld: Number(run.trace_withheld ?? 0),
      heartbeat: null,
    };
  });
  return {
    empty: false,
    published: true,
    publishedAt: record.publishedAt,
    direction: record.direction,
    components: record.components,
    componentRelations: record.componentRelations,
    tasks: record.tasks,
    outcomes: record.outcomes,
    syntheses: record.syntheses,
    sources: record.sources,
    commands: record.commands,
    artifacts: [],
    notes: [],
    watcherRequests: [],
    events: [],
    synthesisReviews: record.syntheses.flatMap((item) => (item.review ? [item.review] : [])),
    knowledge: { undigestedOutcomeIds: [], uncitedRelevantSourceIds: [] },
    execution: { lanes },
    environment: "The verified environment sheet describes the machine the research ran on and is not published.",
    spend: { ...record.spend, tokens: Number(record.spend.inputTokens ?? 0) + Number(record.spend.outputTokens ?? 0) },
    timeline: { firstRunAt: lanes.length ? new Date(Math.min(...lanes.map((l) => l.startMs))).toISOString() : null,
      workedMs: lanes.reduce((total, lane) => total + lane.durationMs, 0) },
    budget: { ceilingUsd: 0 },
    continuous: false,
    supervisor: { running: false }, watcher: { running: false }, dashboard: { running: true },
    principles: [
      "Not every study should use the same evaluator.",
      "No global score, incumbent, or baseline advancement.",
      "Benchmarks are scoped evidence, not the scheduling objective.",
      "Negative and bounded findings are completed research.",
    ],
  };
}

export async function serveMirror(input: { port: number; directionId?: string; projectId?: string; databaseId?: string }): Promise<void> {
  const html = readFileSync(join(HERE, "dashboard.html"), "utf8");
  const vendorRoot = join(HERE, "..", "..", "node_modules");
  const VENDOR: Record<string, { file: string; type: string }> = {
    "/vendor/katex.css": { file: "katex/dist/katex.min.css", type: "text/css; charset=utf-8" },
    "/vendor/katex.js": { file: "katex/dist/katex.min.js", type: "text/javascript; charset=utf-8" },
    "/vendor/marked.js": { file: "marked/lib/marked.umd.js", type: "text/javascript; charset=utf-8" },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "mirror"}`);
    // Read-only by construction: anything that is not one of these is a 404.
    if (request.method !== "GET") { response.writeHead(405).end("read-only mirror"); return; }
    if (url.pathname === "/api/state") {
      try {
        const record = await readPublishedRecord({ directionId: input.directionId,
          projectId: input.projectId, databaseId: input.databaseId });
        const body = record ? mirrorState(record) : { empty: true };
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify(body));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }
    const vendor = VENDOR[url.pathname];
    if (vendor) {
      const path = join(vendorRoot, vendor.file);
      if (!existsSync(path)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": vendor.type, "Cache-Control": "max-age=86400" });
      response.end(readFileSync(path)); return;
    }
    const font = url.pathname.match(/^\/vendor\/fonts\/([A-Za-z0-9_.-]+)$/);
    if (font) {
      const path = join(vendorRoot, "katex", "dist", "fonts", font[1]!);
      if (!existsSync(path)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": font[1]!.endsWith(".woff2") ? "font/woff2" : "font/woff" });
      response.end(readFileSync(path)); return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Cloud Run requires listening on all interfaces at $PORT.
    server.listen(input.port, "0.0.0.0", resolve);
  });
  console.log(`research mirror listening on ${input.port}`);
  await new Promise<void>((resolve) => {
    const close = () => server.close(() => resolve());
    process.once("SIGINT", close); process.once("SIGTERM", close);
  });
}
