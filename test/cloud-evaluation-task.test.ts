import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLOUD_TASK_VERSION, executeCloudTask } from "../src/cloud/evaluation-task.js";

test("portable evaluator task applies its variant and runs outside the coordinator", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-cloud-task-"));
  mkdirSync(join(root, "protected"));
  writeFileSync(join(root, "protected", "evaluate.mjs"), `
    import fs from 'node:fs';
    const a = process.argv.slice(2); const get = k => a[a.indexOf(k) + 1];
    const cfg = JSON.parse(fs.readFileSync(get('--output'), 'utf8'));
    fs.writeFileSync(get('--out'), JSON.stringify({primary: cfg.seed, secondary: null,
      measurement_resolution: 1, checks:[{id:'truth',class:'integrity',passed:true,detail:'ok'}]}));
  `);
  writeFileSync(join(root, "domain.json"), JSON.stringify({
    id: "fixture", metric: { name: "score", direction: "maximize", noiseFloor: 1 },
    determinism: "bitwise", replication: { kind: "seed", attempts: 1, minAgreement: 1,
      variantKey: "seed", variantValues: [7] }, cost: { typicalSeconds: 1 },
    candidateFiles: ["result.json", "run.mjs"], configFile: "result.json", protectedPaths: ["protected"],
    seedFiles: [], runCommand: [process.execPath, "run.mjs"],
    evaluatorCommand: [process.execPath, "protected/evaluate.mjs"], outputPath: "result.json",
    reservedConfigKeys: ["seed"], cheats: [{ id: "fixture", title: "fixture", targets: "fixture",
      kind: "other", acceptableVerdicts: ["implementation_invalid"], file: "result.json",
      insertAfter: "seed", insert: "", expectedChecks: ["truth"] }],
  }));
  try {
    const result = executeCloudTask({
      version: CLOUD_TASK_VERSION, taskId: "test-1", domainConfigPath: "domain.json",
      candidateFiles: { "result.json": JSON.stringify({ seed: 1 }), "run.mjs": "// output already materialised\n" }, configPatch: { seed: 7 },
      baselinePrimary: 0, baselineSecondary: null, supportDelta: 1,
      experimentTimeoutMs: 10_000, evaluatorTimeoutMs: 10_000,
    }, root, 0);
    assert.equal(result.failure, undefined);
    assert.equal(result.evaluation?.primary, 7);
    assert.equal(result.evaluation?.measurementResolution, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
