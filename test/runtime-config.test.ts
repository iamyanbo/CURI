import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runtimeConfig } from "../src/config/runtime.js";

describe("runtime profiles", () => {
  it("defaults to a locally executable profile", () => {
    assert.deepEqual(runtimeConfig([], {} as NodeJS.ProcessEnv), {
      profile: "local", modelProvider: "openrouter", compute: "local", store: "sqlite",
      region: "us-central1", maxCostUsd: 0,
    });
  });

  it("selects Google Cloud defaults without preventing hybrid overrides", () => {
    const cloud = runtimeConfig(["--profile", "cloud"], {} as NodeJS.ProcessEnv);
    assert.equal(cloud.modelProvider, "vertex-ai");
    assert.equal(cloud.compute, "cloud-run");
    assert.equal(cloud.store, "firestore");
    const hybrid = runtimeConfig(["--profile", "local", "--compute", "cloud-run"], {} as NodeJS.ProcessEnv);
    assert.equal(hybrid.store, "sqlite");
    assert.equal(hybrid.compute, "cloud-run");
  });
});
