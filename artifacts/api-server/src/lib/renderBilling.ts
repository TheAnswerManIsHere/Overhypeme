/**
 * @purpose Fill what fal billed for each gag render's requests, hourly, from fal's Billing Events API, so a render's history shows its real cost without calling fal when viewed.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_RENDER_HISTORY.md D5 (Issue #1304; David, 2026-11-25:
 * "The cost should be an easy lookup from the fal.ai API endpoint, no?").
 * Reuses the engine comparison's billing reader (lib/comparison/billedCost.ts)
 * and its read-only key, `FAL_BILLING_API_KEY`; there is no second fal client.
 *
 * Each run takes a batch of review-render requests that reached fal (a vendor
 * request id) and have no bill yet, never-checked first, then the least
 * recently checked. They are looked up in windows of at most 90 days, fal's
 * limit for one query, which is a query limit, not a retention limit: age
 * alone never marks a bill unavailable (Astra C5). A request found in a
 * window gets `billed_usd` (its events summed) and `billing_checked_at`; one
 * not found gets `billing_checked_at` only ("no bill found yet"), and is
 * looked up again by later runs. A window whose lookup fails changes nothing,
 * so "not checked" and "checked, no bill" stay distinct.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, imageGenerationRequestsTable } from "@workspace/db";
import { falBillingFetcher, falBillingKey, sumBilledByRequest, type BillingFetcher } from "./comparison/billedCost";
import { logger } from "./logger";

/** Requests looked up in one run. */
const BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Requests whose creation dates span at most this share one lookup... */
const WINDOW_SPAN_MS = 88 * DAY_MS;
/** ...which reaches this far past the last of them, since fal posts a bill a little after the picture: 90 days in all, fal's limit. */
const WINDOW_TAIL_MS = 2 * DAY_MS;
const WINDOW_HEAD_MS = 60 * 60 * 1000;

export interface RenderBillingCounts {
  /** Requests looked up this run. */
  checked: number;
  /** Requests a bill was found for. */
  filled: number;
  /** Requests fal had no bill for yet. */
  noBill: number;
  /** Lookups (windows) made, and how many failed. */
  windows: number;
  failedWindows: number;
}

/** Whether the billing-read key is set; without it nothing is read and history says so. */
export function billingKeySet(): boolean {
  return falBillingKey() != null;
}

/** Group requests (oldest first) into lookups of at most 90 days each. */
export function billingWindows<T extends { createdAt: Date }>(rows: T[], now: Date): { start: Date; end: Date; rows: T[] }[] {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out: { start: Date; end: Date; rows: T[] }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.createdAt.getTime() - last.rows[0]!.createdAt.getTime() <= WINDOW_SPAN_MS) last.rows.push(r);
    else out.push({ start: new Date(0), end: new Date(0), rows: [r] });
  }
  for (const w of out) {
    w.start = new Date(w.rows[0]!.createdAt.getTime() - WINDOW_HEAD_MS);
    w.end = new Date(Math.min(w.rows[w.rows.length - 1]!.createdAt.getTime() + WINDOW_TAIL_MS, now.getTime()));
  }
  return out;
}

/**
 * One run. `fetchEvents` defaults to fal's API with the billing-read key;
 * without a key the run does nothing. Throws when any lookup failed, after
 * recording the others, so the scheduler retries soon and the health check
 * sees it.
 */
export async function runRenderBillingFill(opts: { fetchEvents?: BillingFetcher; now?: Date; batch?: number } = {}): Promise<RenderBillingCounts> {
  const counts: RenderBillingCounts = { checked: 0, filled: 0, noBill: 0, windows: 0, failedWindows: 0 };
  const apiKey = falBillingKey();
  const fetchEvents = opts.fetchEvents ?? (apiKey ? falBillingFetcher(apiKey) : null);
  if (!fetchEvents) return counts;
  const now = opts.now ?? new Date();
  const t = imageGenerationRequestsTable;
  const rows = await db.select({ id: t.id, vendorRequestId: t.vendorRequestId, createdAt: t.createdAt })
    .from(t)
    .where(and(isNull(t.billedUsd), isNotNull(t.vendorRequestId), eq(t.producer, "review_render")))
    .orderBy(sql`${t.billingCheckedAt} ASC NULLS FIRST`, asc(t.createdAt))
    .limit(opts.batch ?? BATCH);
  for (const w of billingWindows(rows, now)) {
    counts.windows++;
    let events;
    try {
      events = await fetchEvents(w.start.toISOString(), w.end.toISOString());
    } catch (err) {
      counts.failedWindows++;
      logger.warn({ err: (err as Error).message, start: w.start, end: w.end }, "[render-billing] fal's billing lookup failed; these requests stay as they were");
      continue;
    }
    const costOf = sumBilledByRequest(events);
    const found = w.rows.filter((r) => costOf.has(r.vendorRequestId!));
    const missing = w.rows.filter((r) => !costOf.has(r.vendorRequestId!));
    for (const r of found) {
      await db.update(t).set({ billedUsd: costOf.get(r.vendorRequestId!)!.toFixed(4), billingCheckedAt: now })
        .where(and(eq(t.id, r.id), isNull(t.billedUsd)));
    }
    if (missing.length) {
      await db.update(t).set({ billingCheckedAt: now }).where(and(inArray(t.id, missing.map((r) => r.id)), isNull(t.billedUsd)));
    }
    counts.checked += w.rows.length;
    counts.filled += found.length;
    counts.noBill += missing.length;
  }
  if (counts.checked > 0 || counts.failedWindows > 0) logger.info(counts, "[render-billing] run");
  if (counts.failedWindows > 0) throw new Error(`${counts.failedWindows} of ${counts.windows} billing lookups failed`);
  return counts;
}
