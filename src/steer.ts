/**
 * Operator steering: a hand on the wheel that stays inside the evidence chain.
 *
 * A campaign you cannot redirect is a campaign you have to kill and restart to
 * change your mind about, which is what happened repeatedly during this
 * project's first days. But redirection has to be *recorded*: an operator who
 * can silently reshape what the manager considers has become an unlogged author
 * of the findings, and the whole point of this system is that every input to a
 * claim is inspectable afterwards.
 *
 * So a steer is:
 *   - read at a cycle boundary, never mid-experiment
 *   - written into `human_interventions` and the hash-chained event log
 *   - shown to the MANAGER as operator guidance, clearly labelled as such
 *   - never able to touch a threshold, a verdict, or the protected evaluator
 *
 * The last point matters most. A steer redirects ATTENTION - what to try next -
 * and cannot alter what counts as success. If an operator could set thresholds
 * mid-campaign, every result after that point would be unfalsifiable.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nowIso, type Store } from "./store/store.js";

export interface Steer {
  text: string;
  at: string;
}

const FILE = "steer.json";

/** Queue a steer for the next cycle boundary. */
export function requestSteer(stateDir: string, text: string): void {
  writeFileSync(join(stateDir, FILE), JSON.stringify({ text, at: nowIso() }), "utf8");
}

/** Read a pending steer without consuming it. */
export function pendingSteer(stateDir: string): Steer | null {
  const p = join(stateDir, FILE);
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as Steer;
    return typeof s.text === "string" && s.text.trim().length > 0 ? s : null;
  } catch {
    return null;
  }
}

export function clearSteer(stateDir: string): void {
  const p = join(stateDir, FILE);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* best effort */ }
  }
}

/**
 * Consume a pending steer and record it as a human intervention.
 *
 * Recorded BEFORE it reaches the manager, so the ledger cannot end up with a
 * steered proposal whose steer was never written down.
 */
export function consumeSteer(store: Store, campaignId: string, stateDir: string): Steer | null {
  const steer = pendingSteer(stateDir);
  if (!steer) return null;

  store.transact((s) => {
    s.db.prepare(
      `INSERT INTO human_interventions
         (intervention_id, campaign_id, kind, changed_frontier, detail, occurred_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      // `hint` is the schema's existing kind for exactly this: an operator
      // pointing the campaign somewhere without changing its rules. Inventing
      // a `steer` kind tripped the column's CHECK constraint and threw on the
      // first cycle of a fresh run - the same one-place-not-the-other mistake
      // that a derived lane list was introduced to prevent.
      `I-${Date.now()}`, campaignId, "hint", 1,
      `operator steer: ${steer.text.slice(0, 900)}`, nowIso(),
    );
    s.appendEvent({
      campaignId, aggregateKind: "campaign", aggregateId: campaignId, aggregateRevision: 9,
      eventType: "campaign.steered", actorKind: "human",
      idempotencyKey: `campaign.steered:${campaignId}:${steer.at}`,
      payload: { text: steer.text.slice(0, 2000), requestedAt: steer.at },
    });
  });

  clearSteer(stateDir);
  return steer;
}

/**
 * How a steer appears to the manager.
 *
 * Framed as guidance from a named human, not as a system rule, and explicitly
 * bounded: the operator directs attention, the contract still decides truth.
 * Marked as untrusted-for-thresholds so a steer saying "use a threshold of
 * 0.001" cannot launder itself into the pre-registration.
 */
export function steerBlock(steer: Steer): string {
  return [
    "",
    "## Operator guidance",
    "",
    "A human operator has left the following note for this cycle:",
    "",
    "> " + steer.text.trim().split("\n").join("\n> "),
    "",
    "Treat this as a strong steer about WHAT TO INVESTIGATE. It does not change",
    "what counts as success: the metric, the noise floor, and the thresholds you",
    "register are still yours to justify, and a threshold below the measured noise",
    "floor is invalid no matter who suggested it. If the guidance conflicts with",
    "the evidence in this packet, say so in your motivation rather than silently",
    "following it - the operator is one input, not the arbiter.",
  ].join("\n");
}
