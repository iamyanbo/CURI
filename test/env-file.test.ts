import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { geminiApiKey, loadEnvFile } from "../src/config/env-file.js";

function sandbox(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "env-file-"));
  const saved = { ...process.env };
  try { fn(root); } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

test("a missing .env is not an error, so cloud deployments need no file", () => {
  sandbox((root) => {
    assert.equal(loadEnvFile(root), null);
  });
});

test("the real environment always beats the file", () => {
  sandbox((root) => {
    writeFileSync(join(root, ".env"), "AR_ENV_TEST_SHARED=from_file\nAR_ENV_TEST_ONLY=from_file\n", "utf8");
    process.env.AR_ENV_TEST_SHARED = "from_environment";
    loadEnvFile(root);
    // This precedence is what makes the file safe to ship alongside a cloud
    // deployment: a Cloud Run service variable or Secret Manager binding can
    // never be shadowed by a stray file.
    assert.equal(process.env.AR_ENV_TEST_SHARED, "from_environment");
    assert.equal(process.env.AR_ENV_TEST_ONLY, "from_file");
  });
});

test("an unreadable .env warns instead of taking the runtime down", () => {
  sandbox((root) => {
    // A directory where the file should be: loadable only by failing.
    const path = join(root, ".env");
    mkdirSync(path);
    assert.doesNotThrow(() => loadEnvFile(root));
  });
});

test("either Google key name is accepted", () => {
  assert.equal(geminiApiKey({ GEMINI_API_KEY: "a" } as NodeJS.ProcessEnv), "a");
  assert.equal(geminiApiKey({ GOOGLE_API_KEY: "b" } as NodeJS.ProcessEnv), "b");
  assert.equal(geminiApiKey({ GEMINI_API_KEY: " ", GOOGLE_API_KEY: "b" } as NodeJS.ProcessEnv), "b");
  assert.equal(geminiApiKey({} as NodeJS.ProcessEnv), undefined);
});
