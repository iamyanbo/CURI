/** Read-only inspector for the last cycle. Debug aid, not part of the control plane. */
import { Store } from "./store/store.js";

const store = Store.open(".autoresearch/state.sqlite");
const h = store.db.prepare("SELECT * FROM hypotheses ORDER BY created_at DESC LIMIT 1").get() as any;
if (!h) {
  console.log("no hypotheses yet");
} else {
  console.log(`title     : ${h.title}`);
  console.log(`lane      : ${h.lane}   class: ${h.change_class}   status: ${h.status}`);
  console.log(`belief_adv: ${h.belief_advisory}   belief_derived: ${h.belief_derived}`);
  console.log(`mechanism : ${String(h.mechanism).slice(0, 300)}`);
  console.log(`falsifier : ${String(h.falsifier).slice(0, 300)}`);

  const c = store.db.prepare(
    "SELECT contract_hash, threshold_json, registered_at FROM contracts WHERE hypothesis_id = ?",
  ).get(h.hypothesis_id) as any;
  if (c) {
    console.log(`contract  : ${c.contract_hash.slice(0, 16)}  ${c.threshold_json}  registered ${c.registered_at}`);
  }

  const ev = store.db.prepare(
    "SELECT kind, polarity, statement FROM evidence WHERE hypothesis_id = ?",
  ).all(h.hypothesis_id) as any[];
  for (const e of ev) console.log(`evidence  : [${e.kind}/${e.polarity}] ${e.statement}`);
}

console.log("\n--- events ---");
for (const e of store.db.prepare(
  "SELECT seq, event_type, actor_kind FROM events ORDER BY seq",
).all() as any[]) {
  console.log(`  ${String(e.seq).padStart(3)} ${e.event_type.padEnd(22)} ${e.actor_kind}`);
}
store.close();
