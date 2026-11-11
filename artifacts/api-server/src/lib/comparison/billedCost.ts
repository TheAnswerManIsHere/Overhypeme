/**
 * What fal actually charged for each engine-comparison picture (David,
 * 2026-11-11: "Please backfill all the generations with the actual costs. I
 * want to know for real what GPT Image is costing.").
 *
 * fal bills a token-priced request after it finishes and exposes the result,
 * per request id, through its Billing Events API. That API needs a key with
 * billing read access, which the rendering key does not have, so it is read
 * with a second, read-only key in `FAL_BILLING_API_KEY`. With no such key this
 * does nothing, and the results page shows list prices only.
 *
 * Fills only cells whose bill is still empty, so it is safe to run repeatedly:
 * from `scripts/comparison-backfill-cost.ts`, and each time the results are
 * loaded, since fal can record a bill a little after the picture comes back.
 */
import { db } from "@workspace/db";
import { comparisonCellsTable, comparisonPanelsTable } from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { logger } from "../logger.js";

const FAL_BILLING_EVENTS_API = "https://api.fal.ai/v1/models/billing-events";
/** fal caps one query's window at 90 days. */
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 50;

export interface BillingEvent { request_id: string; cost_total: number }
export type BillingFetcher = (startIso: string, endIso: string) => Promise<BillingEvent[]>;

export function parseBillingEvents(raw: unknown): { events: BillingEvent[]; nextCursor: string | null } {
  const body = raw as { billing_events?: unknown; next_cursor?: unknown };
  if (!body || !Array.isArray(body.billing_events)) throw new Error("fal billing response has no billing_events array");
  const events = body.billing_events.map((e, i) => {
    const ev = e as Partial<BillingEvent>;
    if (typeof ev.request_id !== "string" || !ev.request_id || typeof ev.cost_total !== "number" || !Number.isFinite(ev.cost_total) || ev.cost_total < 0) {
      throw new Error(`fal billing event ${i} is malformed`);
    }
    return { request_id: ev.request_id, cost_total: ev.cost_total };
  });
  return { events, nextCursor: typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null };
}

/** Reads every billing event in a window with the billing-read key. */
export function falBillingFetcher(apiKey: string): BillingFetcher {
  return async (startIso, endIso) => {
    const all: BillingEvent[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(FAL_BILLING_EVENTS_API);
      url.searchParams.set("start", startIso);
      url.searchParams.set("end", endIso);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, { headers: { Authorization: `Key ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`fal billing events answered HTTP ${res.status}`);
      const { events, nextCursor } = parseBillingEvents(await res.json());
      all.push(...events);
      if (!nextCursor) return all;
      cursor = nextCursor;
    }
    throw new Error("fal billing events did not finish paging");
  };
}

export interface BilledCostCounts { waiting: number; filled: number; notYetBilled: number }

/**
 * Fill `billed_usd` on cells that reached fal and have no bill yet, in the
 * given sets (all sets when omitted). One request can carry several billing
 * events; they are summed. Writes only when `apply`.
 */
export async function syncBilledCosts(fetchEvents: BillingFetcher, opts: { setIds?: number[]; apply: boolean; now?: Date }): Promise<BilledCostCounts> {
  const cells = await db.select({ id: comparisonCellsTable.id, falRequestId: comparisonCellsTable.falRequestId, submittedAt: comparisonCellsTable.submittedAt, createdAt: comparisonCellsTable.createdAt })
    .from(comparisonCellsTable)
    .innerJoin(comparisonPanelsTable, eq(comparisonPanelsTable.id, comparisonCellsTable.panelId))
    .where(and(
      isNotNull(comparisonCellsTable.falRequestId),
      isNull(comparisonCellsTable.billedUsd),
      inArray(comparisonCellsTable.state, ["rendered", "failed"]),
      opts.setIds ? inArray(comparisonPanelsTable.setId, opts.setIds) : undefined,
    ));
  if (cells.length === 0) return { waiting: 0, filled: 0, notYetBilled: 0 };

  const now = opts.now ?? new Date();
  const earliest = Math.min(...cells.map((c) => (c.submittedAt ?? c.createdAt).getTime()));
  // A day of margin before the first request; never further back than fal's window allows.
  const start = new Date(Math.max(earliest - 24 * 60 * 60 * 1000, now.getTime() - MAX_WINDOW_MS + 60_000));
  const events = await fetchEvents(start.toISOString(), now.toISOString());
  const costOf = new Map<string, number>();
  for (const e of events) costOf.set(e.request_id, (costOf.get(e.request_id) ?? 0) + e.cost_total);

  let filled = 0;
  for (const c of cells) {
    const cost = costOf.get(c.falRequestId!);
    if (cost === undefined) continue;
    filled += 1;
    if (opts.apply) {
      await db.update(comparisonCellsTable).set({ billedUsd: cost.toFixed(6) })
        .where(and(eq(comparisonCellsTable.id, c.id), isNull(comparisonCellsTable.billedUsd), eq(comparisonCellsTable.falRequestId, c.falRequestId!)));
    }
  }
  return { waiting: cells.length, filled, notYetBilled: cells.length - filled };
}

/**
 * Best effort, for the results page: read any bills still missing for these
 * sets. Never throws and never blocks the results on fal being unreachable.
 */
export async function refreshBilledCosts(setIds: number[]): Promise<void> {
  const apiKey = process.env.FAL_BILLING_API_KEY?.trim();
  if (!apiKey) return;
  try {
    await syncBilledCosts(falBillingFetcher(apiKey), { setIds, apply: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[comparison] could not read fal's bills; showing list prices");
  }
}
