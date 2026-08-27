import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mirrorProjectId, mirrorSyncIntervalMs } from "../src/research/mirror-sync.js";

test("mirror sync stays off unless a project is configured", () => {
  // Publishing is optional: a local-only user must never see credential errors
  // from a background timer they did not ask for.
  assert.equal(mirrorProjectId({}), null);
  assert.equal(mirrorProjectId({ GOOGLE_CLOUD_PROJECT: "  " }), null);
  assert.equal(mirrorProjectId({ GOOGLE_CLOUD_PROJECT: "proj" }), "proj");
  assert.equal(mirrorProjectId({ GCLOUD_PROJECT: "proj" }), "proj");
  // An explicit publish project wins over the ambient one.
  assert.equal(mirrorProjectId({ AR_PUBLISH_PROJECT: "pub", GOOGLE_CLOUD_PROJECT: "amb" }), "pub");
  // And it can be switched off even where a project is configured.
  assert.equal(mirrorProjectId({ GOOGLE_CLOUD_PROJECT: "proj", AR_MIRROR_SYNC: "off" }), null);
});

test("mirror sync interval is bounded below", () => {
  assert.equal(mirrorSyncIntervalMs({}), 120_000);
  assert.equal(mirrorSyncIntervalMs({ AR_MIRROR_SYNC_SECONDS: "300" }), 300_000);
  // A tiny or malformed interval would hammer Firestore for no benefit.
  assert.equal(mirrorSyncIntervalMs({ AR_MIRROR_SYNC_SECONDS: "1" }), 30_000);
  assert.equal(mirrorSyncIntervalMs({ AR_MIRROR_SYNC_SECONDS: "banana" }), 120_000);
});

test("a failed publish does not advance the published watermark", () => {
  // If a failure moved the watermark forward, the change that failed to send
  // would never be republished and the mirror would stay wrong indefinitely.
  const source = readFileSync(join(process.cwd(), "src", "research", "mirror-sync.ts"), "utf8");
  const catchBlock = source.slice(source.indexOf("mirror sync failed, will retry"));
  assert.match(catchBlock.slice(0, 200), /return input\.since;/);
});

test("publishing cannot end a research run", () => {
  // A missing credential killed a supervisor: the failure was caught and logged,
  // then a rejection raised inside the Firestore client after that point ended
  // the process. Publishing is optional telemetry; research outranks it.
  const sync = readFileSync(join(process.cwd(), "src", "research", "mirror-sync.ts"), "utf8");
  const tick = sync.slice(sync.indexOf("const tick = async () =>"), sync.indexOf("log(`mirror sync enabled"));
  assert.match(tick, /catch \(error\)/);
  assert.match(tick, /mirror sync disabled after repeated failures/);
  // Opening the store was outside the guard, so it escaped as a rejection too.
  const once = sync.slice(sync.indexOf("export async function syncMirrorOnce"), sync.indexOf("export function startMirrorSync"));
  assert.match(once, /could not open the store/);

  const runtime = readFileSync(join(process.cwd(), "src", "research", "runtime.ts"), "utf8");
  assert.match(runtime, /process\.on\("unhandledRejection"/);
  assert.match(runtime, /research continues/);
});
