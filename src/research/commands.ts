import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { requestResearchStop, watcherStopFile } from "./control.js";
import {
  archiveLegacyState, clearRunStops, continuousFile, continuousMode, costCeilingFile, directionSpendUsd,
  openResearchStore, researchCostCeiling,
  researchDashboardStatus, researchSupervisorStatus, researchWatcherStatus,
  reconcileSupervisorState, runResearchLoop, runResearchSupervisor, runWatcherDaemon, startResearchSupervisor, startWatcherDaemon,
  startResearchDashboard, watcherSweep,
} from "./runtime.js";
import { collectPreflight, preflightCachePath, preflightFacts, renderPreflightMarkdown } from "./preflight.js";
import { buildPublishedRecord } from "./publish.js";
import { auditPublishedRecord, machineIdentifiers } from "./trace-publish.js";
import { stateDir, stateDirName } from "./paths.js";
import {
  livePidFiles, migrateState, planMigration, rewriteRecordedPaths, staleRecordedPaths,
} from "./migrate-state.js";
import { publishToFirestore, serveMirror } from "./mirror.js";
import { serveResearchDashboard } from "./server.js";
import { RESEARCH_SCHEMA_VERSION } from "./store.js";
import { configureResearchWatcher } from "./watcher.js";

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined;
}
function values(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === `--${name}`) out.push(args[i + 1]!);
  return out;
}
function directionId(projectRoot: string, args: string[]): string {
  const store = openResearchStore(projectRoot);
  try {
    const id = value(args, "direction") ?? store.latestDirectionId();
    if (!id) throw new Error("no research direction exists; run research init first");
    return id;
  } finally { store.close(); }
}
function usage(): void {
  console.log([
    "CURI — Cumulative Research & Inquiry:",
    "  research reset --archive",
    "  research init --direction ID --title TEXT (--brief MARKDOWN|--brief-file PATH) --domain PATH [--fixed TEXT] [--open TEXT] [--topic TEXT]",
    "  research run|turn [--direction ID] [--model MODEL] [--resume] [--no-watch]",
    "  research supervisor start|status|daemon [--direction ID] [--model MODEL]",
    "  research watch start|stop|status|sweep|daemon [--direction ID] [--model MODEL]",
    "  research watch configure [--every SECONDS] [--max-read N]",
    "  research stop --now|--after-study|--all [--reason TEXT]",
    "  research preflight [--refresh]",
    "  research publish [--dry-run] [--out FILE] [--project ID] [--database ID]",
    "  research mirror [--port N] [--project ID] [--database ID]",
    "  research budget [--max USD] [--clear] [--record-spend USD --reason TEXT]",
    "  research resume [--direction ID] [--reason TEXT]",
    "  research continuous [--off]",
    "  research status [--direction ID]",
    "  research dashboard [start|status|daemon] [--direction ID] [--port 7331]",
  ].join("\n"));
}

export async function handleResearchCommand(projectRoot: string, args: string[]): Promise<void> {
  const action = args[0]; if (!action) { usage(); return; }
  if (action === "reset") {
    if (!args.includes("--archive")) throw new Error("reset requires --archive");
    console.log(archiveLegacyState(projectRoot) ?? "no state to archive");
    const store = openResearchStore(projectRoot); store.close(); return;
  }
  if (action === "init") {
    const id = value(args, "direction") ?? `research-${Date.now()}`;
    const briefFile = value(args, "brief-file");
    const brief = briefFile ? readFileSync(resolve(projectRoot, briefFile), "utf8") : value(args, "brief");
    const domain = value(args, "domain");
    if (!brief || !domain) throw new Error("research init requires --brief or --brief-file, and --domain");
    const domainPath = resolve(projectRoot, domain); if (!existsSync(domainPath)) throw new Error(`domain does not exist: ${domainPath}`);
    const constraints = [...values(args, "fixed"), ...values(args, "negotiable").map((item) => `Negotiable: ${item}`),
      ...values(args, "open").map((item) => `Open direction: ${item}`)].map((item) => `- ${item}`).join("\n");
    const store = openResearchStore(projectRoot);
    try {
      store.createDirection({ id, title: value(args, "title") ?? id, briefMarkdown: brief,
        constraintsMarkdown: constraints, domainPath });
      configureResearchWatcher(store, { directionId: id,
        topics: values(args, "topic").length ? values(args, "topic") : [value(args, "title") ?? id],
        feeds: values(args, "feed"), intervalSeconds: Number(value(args, "watch-every") ?? 3600) });
    } finally { store.close(); }
    clearRunStops(projectRoot); console.log(`initialized lean research direction ${id}`); return;
  }
  if (action === "run" || action === "turn") {
    const id = directionId(projectRoot, args);
    if (researchSupervisorStatus(projectRoot, id).running) {
      throw new Error("research supervisor is already running; inspect status or stop it before a foreground run");
    }
    if (args.includes("--resume")) {
      clearRunStops(projectRoot); const store = openResearchStore(projectRoot);
      try { store.db.prepare("UPDATE directions SET status='active',updated_at=? WHERE direction_id=?").run(new Date().toISOString(), id); }
      finally { store.close(); }
    }
    const recoveryStore = openResearchStore(projectRoot);
    try { reconcileSupervisorState(recoveryStore, id); } finally { recoveryStore.close(); }
    if (!args.includes("--no-watch") && !(researchWatcherStatus(projectRoot, id).running)) {
      startWatcherDaemon({ projectRoot, directionId: id, model: value(args, "model") });
    }
    console.log(await runResearchLoop({ projectRoot, directionId: id, model: value(args, "model"),
      maxTurns: action === "turn" ? 1 : Number(value(args, "max-turns") ?? 0) }));
    return;
  }
  if (action === "supervisor") {
    const id = directionId(projectRoot, args); const sub = args[1] ?? "status";
    if (sub === "status") { console.log(researchSupervisorStatus(projectRoot, id)); return; }
    if (sub === "daemon") { await runResearchSupervisor({ projectRoot, directionId: id, model: value(args, "model") }); return; }
    if (sub === "start") {
      clearRunStops(projectRoot); const store = openResearchStore(projectRoot);
      try { store.db.prepare("UPDATE directions SET status='active',updated_at=? WHERE direction_id=?").run(new Date().toISOString(), id); }
      finally { store.close(); }
      console.log(startResearchSupervisor({ projectRoot, directionId: id, model: value(args, "model") })); return;
    }
    throw new Error("supervisor action must be start, status, or daemon");
  }
  if (action === "watch") {
    const id = directionId(projectRoot, args); const sub = args[1] ?? "status";
    if (sub === "status") { console.log(researchWatcherStatus(projectRoot, id)); return; }
    if (sub === "daemon") { await runWatcherDaemon({ projectRoot, directionId: id, model: value(args, "model") }); return; }
    if (sub === "start") {
      const stop = watcherStopFile(projectRoot); if (existsSync(stop)) unlinkSync(stop);
      console.log(startWatcherDaemon({ projectRoot, directionId: id, model: value(args, "model") })); return;
    }
    if (sub === "stop") {
      mkdirSync(stateDir(projectRoot), { recursive: true });
      writeFileSync(watcherStopFile(projectRoot), "operator requested watcher stop", "utf8"); console.log("watcher stop requested"); return;
    }
    if (sub === "configure") {
      // Written to watcher_config, which the daemon re-reads each cycle, so the
      // pace changes without restarting a process mid-sweep.
      const store = openResearchStore(projectRoot);
      try {
        const every = value(args, "every");
        const maxRead = value(args, "max-read");
        if (every !== undefined) {
          const seconds = Number(every);
          if (!Number.isFinite(seconds) || seconds < 30) throw new Error("watch configure --every must be at least 30 seconds");
          store.db.prepare("UPDATE watcher_config SET interval_seconds=?,updated_at=? WHERE direction_id=?")
            .run(Math.round(seconds), new Date().toISOString(), id);
        }
        if (maxRead !== undefined) {
          const reads = Number(maxRead);
          if (!Number.isFinite(reads) || reads < 1) throw new Error("watch configure --max-read must be at least 1");
          store.db.prepare("UPDATE watcher_config SET max_read=?,updated_at=? WHERE direction_id=?")
            .run(Math.round(reads), new Date().toISOString(), id);
        }
        console.log(store.db.prepare("SELECT interval_seconds,max_read FROM watcher_config WHERE direction_id=?").get(id));
      } finally { store.close(); }
      return;
    }
    if (sub === "sweep") { console.log(await watcherSweep({ projectRoot, directionId: id,
      model: value(args, "model"), maxRead: Number(value(args, "max-read") ?? 3) })); return; }
    throw new Error("watch action must be start, stop, status, sweep, configure, or daemon");
  }
  if (action === "resume" || action === "continuous") {
    const id = directionId(projectRoot, args);
    if (action === "continuous") {
      const off = args.includes("--off");
      mkdirSync(stateDir(projectRoot), { recursive: true });
      if (off) { if (existsSync(continuousFile(projectRoot))) unlinkSync(continuousFile(projectRoot)); }
      else writeFileSync(continuousFile(projectRoot), "enabled", "utf8");
      console.log({ continuous: continuousMode(projectRoot) });
      return;
    }
    clearRunStops(projectRoot);
    const store = openResearchStore(projectRoot);
    try {
      store.db.prepare("UPDATE directions SET status='active',updated_at=? WHERE direction_id=?")
        .run(new Date().toISOString(), id);
      store.appendEvent(id, null, "direction.resumed", "human",
        value(args, "reason") ?? "Operator resumed the direction.");
    } finally { store.close(); }
    console.log(startResearchSupervisor({ projectRoot, directionId: id, model: value(args, "model") }));
    return;
  }
  if (action === "migrate-state") {
    if (args.includes("--repair-paths")) {
      // For a directory that has already been moved: rewrite any recorded path
      // still pointing at the old name. Separate from the move so an
      // interrupted or incomplete migration can be finished without one.
      const from = value(args, "from") ?? ".autoresearch";
      const store = openResearchStore(projectRoot);
      try {
        const before = staleRecordedPaths(store, from);
        const rewritten = rewriteRecordedPaths(store, from, stateDirName(projectRoot));
        console.log({ from, to: stateDirName(projectRoot), staleBefore: before,
          rewritten, staleAfter: staleRecordedPaths(store, from) });
      } finally { store.close(); }
      return;
    }
    // Renaming the state directory is a migration, not a rename: the store keeps
    // absolute attempt paths and git registers worktrees by absolute path.
    const plan = planMigration(projectRoot);
    if (args.includes("--dry-run")) {
      console.log({ ...plan, live: livePidFiles(projectRoot, plan.from) });
      return;
    }
    console.log(migrateState(projectRoot));
    return;
  }
  if (action === "publish") {
    // Publishing is the boundary between the operator's machine and the public
    // record, so the redacted document set is built here and can be inspected
    // as JSON before anything is sent to Firestore.
    const id = directionId(projectRoot, args);
    const store = openResearchStore(projectRoot);
    try {
      // Tool output is machine output, so publishing it is an explicit choice
      // rather than a default.
      const record = buildPublishedRecord(store, id, projectRoot,
        { includeToolOutput: args.includes("--with-tool-output"),
          includeTrace: !args.includes("--no-trace") });
      const out = value(args, "out");
      if (out) {
        writeFileSync(resolve(projectRoot, out), JSON.stringify(record, null, 2), "utf8");
        console.log({ wrote: out, bytes: JSON.stringify(record).length });
        return;
      }
      if (args.includes("--dry-run")) {
        // The same gate the real publish runs, reported rather than thrown, so
        // an operator can see what would be refused before sending anything.
        const findings = auditPublishedRecord(record, machineIdentifiers());
        console.log({ directionId: id, bytes: JSON.stringify(record).length,
          identifierFindings: findings.length, findingPaths: findings.slice(0, 5).map((f) => f.path),
          counts: Object.fromEntries(Object.entries(record)
            .filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])) });
        return;
      }
      const result = await publishToFirestore({ record, projectId: value(args, "project"),
        databaseId: value(args, "database") });
      console.log(result);
    } finally { store.close(); }
    return;
  }
  if (action === "mirror") {
    await serveMirror({ port: Number(value(args, "port") ?? process.env.PORT ?? 8080),
      directionId: value(args, "direction"), projectId: value(args, "project"),
      databaseId: value(args, "database") });
    return;
  }
  if (action === "budget") {
    // Written as a control file so a change reaches a running supervisor at its
    // next loop iteration, rather than requiring a restart that would discard an
    // in-flight experiment.
    const id = directionId(projectRoot, args);
    const path = costCeilingFile(projectRoot);
    const requested = value(args, "max");
    if (args.includes("--clear")) {
      if (existsSync(path)) unlinkSync(path);
    } else if (requested !== undefined) {
      const amount = Number(requested);
      if (!Number.isFinite(amount) || amount < 0) throw new Error("budget --max must be a non-negative number");
      mkdirSync(stateDir(projectRoot), { recursive: true });
      writeFileSync(path, `${amount}`, "utf8");
    }
    const store = openResearchStore(projectRoot);
    try {
      // Usage the runtime could not observe — spend from before metering was
      // fixed, or from runs it never completed — is reconciled against the
      // provider console as an explicit, auditable ledger entry, so the ceiling
      // counts from what was really consumed rather than from what we captured.
      const reconcile = value(args, "record-spend");
      if (reconcile !== undefined) {
        const amount = Number(reconcile);
        if (!Number.isFinite(amount) || amount < 0) throw new Error("budget --record-spend must be a non-negative number");
        const note = value(args, "reason") ?? "operator reconciliation against the provider console";
        const runId = store.beginRun({ directionId: id, role: "system", inputMarkdown: note });
        store.finishRun({ runId, state: "succeeded", outputMarkdown: note, costUsd: amount,
          inputTokens: Number(value(args, "input-tokens") ?? 0),
          outputTokens: Number(value(args, "output-tokens") ?? 0) });
      }
      const ceiling = researchCostCeiling(projectRoot);
      console.log({ ceilingUsd: ceiling || "none", spentUsd: Number(directionSpendUsd(store, id).toFixed(4)),
        source: existsSync(path) ? "control file" : "environment", path });
    } finally { store.close(); }
    return;
  }
  if (action === "preflight") {
    // Operators need to see, and be able to invalidate, the same environment
    // facts the orchestrator and executor are handed.
    const facts = args.includes("--refresh")
      ? (() => { const collected = collectPreflight(projectRoot);
          mkdirSync(stateDir(projectRoot), { recursive: true });
          writeFileSync(preflightCachePath(projectRoot), JSON.stringify(collected, null, 2), "utf8");
          return collected; })()
      : preflightFacts(projectRoot);
    console.log(renderPreflightMarkdown(facts)); return;
  }
  if (action === "stop") {
    mkdirSync(stateDir(projectRoot), { recursive: true });
    const reason = value(args, "reason") ?? "operator requested stop";
    requestResearchStop(projectRoot, args.includes("--now") || args.includes("--all") ? "now" : "after-study", reason);
    if (args.includes("--all")) writeFileSync(watcherStopFile(projectRoot), reason, "utf8");
    console.log("stop requested"); return;
  }
  if (action === "status") {
    const id = directionId(projectRoot, args); const store = openResearchStore(projectRoot);
    try {
      const context = store.context(id);
      console.log({ schemaVersion: RESEARCH_SCHEMA_VERSION, direction: context.direction,
        supervisor: researchSupervisorStatus(projectRoot, id), watcher: researchWatcherStatus(projectRoot, id),
        dashboard: researchDashboardStatus(projectRoot, id),
        counts: { components: context.components.length, sources: context.sources.length,
          tasks: context.tasks.length, outcomes: context.outcomes.length, syntheses: context.syntheses.length,
          activeRuns: context.runs.filter((run) => ["active", "waiting_external"].includes(String(run.state))).length } });
    } finally { store.close(); }
    return;
  }
  if (action === "dashboard") {
    const id = directionId(projectRoot, args); const sub = args[1]?.startsWith("--") ? "daemon" : (args[1] ?? "daemon");
    const port = Number(value(args, "port") ?? 7331);
    if (sub === "status") { console.log(researchDashboardStatus(projectRoot, id)); return; }
    if (sub === "start") { console.log(startResearchDashboard({ projectRoot, directionId: id, port })); return; }
    if (sub !== "daemon") throw new Error("dashboard action must be start, status, or daemon");
    await serveResearchDashboard({ projectRoot, directionId: value(args, "direction"),
      port }); return;
  }
  usage();
}
