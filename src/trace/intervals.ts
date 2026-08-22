/**
 * Honest time accounting.
 *
 * This is the mechanism behind the product's central claim, so it is enforced
 * by construction rather than by convention:
 *
 *  - A `resource_id` names one serial timeline (e.g. "campaign", "supervisor",
 *    "worker:<attemptId>"). Within one resource, intervals are half-open
 *    [start, end) and CANNOT overlap: opening a new interval closes the
 *    previous one at the same instant.
 *  - Gaps are never dropped. `decompose` fills every unaccounted millisecond
 *    with `unknown`, so the categories always sum to the observed span exactly.
 *
 * The claim card reads the "campaign" resource, which is serial in v0.
 */

import { randomUUID } from "node:crypto";
import type { IntervalCategory, Store } from "../store/store.js";

export interface OpenIntervalInput {
  campaignId: string;
  resourceId: string;
  category: IntervalCategory;
  attemptId?: string | null;
  atMs?: number;
  metadata?: Record<string, unknown>;
}

export interface Decomposition {
  resourceId: string;
  spanMs: number;
  byCategory: Record<string, number>;
  /** Always true: enforced by construction and asserted here. */
  exact: boolean;
}

export class IntervalRecorder {
  constructor(private readonly store: Store) {}

  /** Close whatever is open on this resource, then open the new category. */
  open(input: OpenIntervalInput): string {
    const at = input.atMs ?? Date.now();
    const id = randomUUID();
    this.store.db
      .prepare(
        `UPDATE intervals SET ended_ms = ?
         WHERE campaign_id = ? AND resource_id = ? AND ended_ms IS NULL AND started_ms <= ?`,
      )
      .run(at, input.campaignId, input.resourceId, at);
    this.store.db
      .prepare(
        `INSERT INTO intervals (interval_id, campaign_id, attempt_id, resource_id,
           category, started_ms, ended_ms, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        input.campaignId,
        input.attemptId ?? null,
        input.resourceId,
        input.category,
        at,
        JSON.stringify(input.metadata ?? {}),
      );
    return id;
  }

  /** Close the open interval on a resource without opening a successor. */
  closeResource(campaignId: string, resourceId: string, atMs = Date.now()): void {
    this.store.db
      .prepare(
        `UPDATE intervals SET ended_ms = ?
         WHERE campaign_id = ? AND resource_id = ? AND ended_ms IS NULL AND started_ms <= ?`,
      )
      .run(atMs, campaignId, resourceId, atMs);
  }

  /** Detect any overlap on a resource. Should always be empty; used as a test oracle. */
  findOverlaps(campaignId: string, resourceId: string): Array<{ a: string; b: string }> {
    const rows = this.store.db
      .prepare(
        `SELECT interval_id, started_ms, ended_ms FROM intervals
         WHERE campaign_id = ? AND resource_id = ? ORDER BY started_ms ASC, rowid ASC`,
      )
      .all(campaignId, resourceId) as Array<{
      interval_id: string;
      started_ms: number;
      ended_ms: number | null;
    }>;

    const out: Array<{ a: string; b: string }> = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      const prevEnd = prev.ended_ms ?? Number.POSITIVE_INFINITY;
      if (cur.started_ms < prevEnd) out.push({ a: prev.interval_id, b: cur.interval_id });
    }
    return out;
  }

  /**
   * Category totals over [spanStartMs, spanEndMs). Every unaccounted
   * millisecond becomes `unknown`, so the result sums to the span exactly.
   */
  decompose(
    campaignId: string,
    resourceId: string,
    spanStartMs: number,
    spanEndMs: number,
  ): Decomposition {
    const spanMs = Math.max(0, spanEndMs - spanStartMs);
    const rows = this.store.db
      .prepare(
        `SELECT category, started_ms, ended_ms FROM intervals
         WHERE campaign_id = ? AND resource_id = ? ORDER BY started_ms ASC, rowid ASC`,
      )
      .all(campaignId, resourceId) as Array<{
      category: IntervalCategory;
      started_ms: number;
      ended_ms: number | null;
    }>;

    const byCategory: Record<string, number> = {};
    let accounted = 0;
    let cursor = spanStartMs;

    for (const r of rows) {
      const start = Math.max(r.started_ms, spanStartMs);
      const end = Math.min(r.ended_ms ?? spanEndMs, spanEndMs);
      if (end <= start) continue;
      if (start > cursor) {
        const gap = start - cursor;
        byCategory.unknown = (byCategory.unknown ?? 0) + gap;
        accounted += gap;
      }
      const dur = end - Math.max(start, cursor);
      if (dur > 0) {
        byCategory[r.category] = (byCategory[r.category] ?? 0) + dur;
        accounted += dur;
      }
      cursor = Math.max(cursor, end);
    }

    if (cursor < spanEndMs) {
      const gap = spanEndMs - cursor;
      byCategory.unknown = (byCategory.unknown ?? 0) + gap;
      accounted += gap;
    }

    return { resourceId, spanMs, byCategory, exact: accounted === spanMs };
  }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(rem).padStart(2, "0")}s`;
  return `${rem}s`;
}
