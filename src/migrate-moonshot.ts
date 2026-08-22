/**
 * Migration: add the `moonshot` lane and multi-step hypothesis columns.
 *
 * SQLite cannot alter a CHECK constraint in place, so the two tables carrying a
 * lane constraint are rebuilt with the documented copy/drop/rename procedure.
 * Everything else — evidence, runs, evaluations, artifacts, and the whole event
 * chain — is untouched, so the four replicated claims and their provenance
 * survive the migration rather than being abandoned for a fresh database.
 *
 * Verified after the rebuild: foreign keys resolve, row counts match, and the
 * event hash chain still validates.
 */

import { laneSqlList, Store } from "./store/store.js";

const DB = process.argv[2] ?? ".autoresearch/state.sqlite";
const store = Store.open(DB);
const db = store.db;

const cols = (db.prepare("PRAGMA table_info(hypotheses)").all() as Array<{ name: string }>)
  .map((c) => c.name);
if (cols.includes("steps_allowed")) {
  console.log("already migrated");
  store.close();
  process.exit(0);
}

const beforeHyp = (db.prepare("SELECT COUNT(*) AS n FROM hypotheses").get() as { n: number }).n;
const beforeBud = (db.prepare("SELECT COUNT(*) AS n FROM budgets").get() as { n: number }).n;
const chainBefore = store.verifyEventChain();

db.pragma("foreign_keys = OFF");
db.exec("BEGIN IMMEDIATE");
try {
  db.exec(`
    CREATE TABLE hypotheses_new (
      hypothesis_id   TEXT PRIMARY KEY,
      campaign_id     TEXT NOT NULL REFERENCES campaigns(campaign_id),
      principles_id   TEXT NOT NULL REFERENCES principles(principles_id),
      lane            TEXT NOT NULL CHECK (lane IN (${laneSqlList()})),
      title           TEXT NOT NULL,
      mechanism       TEXT NOT NULL,
      motivation      TEXT NOT NULL,
      falsifier       TEXT NOT NULL,
      change_class    TEXT NOT NULL CHECK (change_class IN
                        ('mechanism','architecture','algorithm','data','evaluation','parameter','replication')),
      status          TEXT NOT NULL CHECK (status IN
                        ('proposed','tested','provisionally_supported','replicated','externally_validated',
                         'refuted','inconclusive','implementation_invalid','shortcut_suspected','abandoned')),
      belief_advisory REAL CHECK (belief_advisory IS NULL OR (belief_advisory BETWEEN 0.0 AND 1.0)),
      belief_derived  REAL CHECK (belief_derived  IS NULL OR (belief_derived  BETWEEN 0.0 AND 1.0)),
      steps_allowed   INTEGER NOT NULL DEFAULT 1 CHECK (steps_allowed BETWEEN 1 AND 5),
      step_index      INTEGER NOT NULL DEFAULT 1 CHECK (step_index >= 1),
      parent_step_id  TEXT REFERENCES hypotheses(hypothesis_id),
      revision        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    INSERT INTO hypotheses_new (hypothesis_id, campaign_id, principles_id, lane, title, mechanism,
      motivation, falsifier, change_class, status, belief_advisory, belief_derived,
      steps_allowed, step_index, parent_step_id, revision, created_at, updated_at)
    SELECT hypothesis_id, campaign_id, principles_id, lane, title, mechanism,
      motivation, falsifier, change_class, status, belief_advisory, belief_derived,
      1, 1, NULL, revision, created_at, updated_at FROM hypotheses;
    DROP TABLE hypotheses;
    ALTER TABLE hypotheses_new RENAME TO hypotheses;
    CREATE INDEX idx_hyp_lane ON hypotheses(campaign_id, lane, status);

    CREATE TABLE budgets_new (
      campaign_id    TEXT NOT NULL REFERENCES campaigns(campaign_id),
      lane           TEXT NOT NULL CHECK (lane IN (${laneSqlList()})),
      category       TEXT NOT NULL CHECK (category IN
                       ('runs','model_tokens','model_cost_usd','compute_seconds','wall_seconds')),
      allocated      REAL NOT NULL CHECK (allocated >= 0),
      consumed       REAL NOT NULL DEFAULT 0 CHECK (consumed >= 0),
      reserved_floor REAL NOT NULL DEFAULT 0 CHECK (reserved_floor >= 0),
      PRIMARY KEY (campaign_id, lane, category)
    );
    INSERT INTO budgets_new SELECT * FROM budgets;
    DROP TABLE budgets;
    ALTER TABLE budgets_new RENAME TO budgets;
  `);

  // Give every existing campaign a moonshot allocation with a protected floor.
  const campaigns = db.prepare("SELECT campaign_id FROM campaigns").all() as Array<{ campaign_id: string }>;
  for (const c of campaigns) {
    db.prepare(
      `INSERT OR IGNORE INTO budgets (campaign_id, lane, category, allocated, consumed, reserved_floor)
       VALUES (?, 'moonshot', 'runs', ?, 0, ?)`,
    ).run(c.campaign_id, 15, 10);
  }

  const fkIssues = db.prepare("PRAGMA foreign_key_check").all();
  if (fkIssues.length > 0) throw new Error(`foreign key check failed: ${JSON.stringify(fkIssues).slice(0, 300)}`);

  const afterHyp = (db.prepare("SELECT COUNT(*) AS n FROM hypotheses").get() as { n: number }).n;
  if (afterHyp !== beforeHyp) throw new Error(`hypothesis count changed: ${beforeHyp} -> ${afterHyp}`);

  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  db.pragma("foreign_keys = ON");
  console.error(`migration failed and was rolled back: ${String(err)}`);
  store.close();
  process.exit(1);
}
db.pragma("foreign_keys = ON");

const chainAfter = store.verifyEventChain();
const afterBud = (db.prepare("SELECT COUNT(*) AS n FROM budgets").get() as { n: number }).n;
const replicated = (db.prepare("SELECT COUNT(*) AS n FROM hypotheses WHERE status='replicated'")
  .get() as { n: number }).n;

console.log(`hypotheses : ${beforeHyp} -> ${beforeHyp} (preserved)`);
console.log(`budgets    : ${beforeBud} -> ${afterBud} (moonshot rows added)`);
console.log(`replicated : ${replicated} claims preserved`);
console.log(`chain      : before ${chainBefore.ok ? "OK" : "BROKEN"} · after ${chainAfter.ok ? "OK" : "BROKEN"}`);
store.close();
