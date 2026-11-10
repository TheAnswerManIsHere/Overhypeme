/**
 * Backfill the engine comparison's render times from fal's request history
 * (David, 2026-11-10: "Backfill them please."), for cells drawn before
 * migration 0128 recorded them. Matches by `fal_request_id` and fills only
 * cells whose times are empty, so a second run changes nothing and a cell the
 * app timed is never overwritten. Driven by
 * `scripts/comparison-backfill-timing.ts`.
 */
import { db } from "@workspace/db";
import { comparisonCellsTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export interface FalTiming { request_id: string; sent_at: string; ended_at: string }

export function parseTimings(raw: unknown): FalTiming[] {
  if (!Array.isArray(raw)) throw new Error("timing file must hold a JSON array");
  return raw.map((r, i) => {
    const t = r as Partial<FalTiming>;
    const ok = typeof t.request_id === "string" && t.request_id.length > 0
      && typeof t.sent_at === "string" && !Number.isNaN(Date.parse(t.sent_at))
      && typeof t.ended_at === "string" && !Number.isNaN(Date.parse(t.ended_at))
      && Date.parse(t.ended_at) >= Date.parse(t.sent_at);
    if (!ok) throw new Error(`timing row ${i} is malformed: ${JSON.stringify(r)}`);
    return t as FalTiming;
  });
}

/** Fill empty cell times from fal's; returns the counts. Writes only when `apply`. */
export async function backfillTimings(timings: FalTiming[], apply: boolean): Promise<{ filled: number; alreadyTimed: number; unmatched: number }> {
  let filled = 0;
  let alreadyTimed = 0;
  let unmatched = 0;
  for (const t of timings) {
    const [cell] = await db.select({ id: comparisonCellsTable.id, submittedAt: comparisonCellsTable.submittedAt })
      .from(comparisonCellsTable).where(eq(comparisonCellsTable.falRequestId, t.request_id));
    if (!cell) { unmatched += 1; continue; }
    if (cell.submittedAt) { alreadyTimed += 1; continue; }
    filled += 1;
    if (apply) {
      await db.update(comparisonCellsTable)
        .set({ submittedAt: new Date(t.sent_at), completedAt: new Date(t.ended_at) })
        .where(and(eq(comparisonCellsTable.id, cell.id), isNull(comparisonCellsTable.submittedAt)));
    }
  }
  return { filled, alreadyTimed, unmatched };
}

