import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openRouterCredentialSource, resolveOpenRouterApiKey } from "../src/config/openrouter-auth.js";

test("OpenRouter credential resolution prefers environment and supports Pi fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-auth-"));
  const auth = join(dir, "auth.json");
  try {
    writeFileSync(auth, JSON.stringify({ openrouter: { type: "api_key", key: "pi-secret" } }));
    assert.equal(resolveOpenRouterApiKey({ OPENROUTER_API_KEY: "env-secret" } as NodeJS.ProcessEnv, auth), "env-secret");
    assert.equal(openRouterCredentialSource({ OPENROUTER_API_KEY: "env-secret" } as NodeJS.ProcessEnv, auth), "environment");
    assert.equal(resolveOpenRouterApiKey({} as NodeJS.ProcessEnv, auth), "pi-secret");
    assert.equal(openRouterCredentialSource({} as NodeJS.ProcessEnv, auth), "pi-fallback");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing or malformed Pi auth fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-auth-"));
  const auth = join(dir, "auth.json");
  try {
    assert.equal(resolveOpenRouterApiKey({} as NodeJS.ProcessEnv, auth), null);
    writeFileSync(auth, "not-json");
    assert.equal(resolveOpenRouterApiKey({} as NodeJS.ProcessEnv, auth), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
