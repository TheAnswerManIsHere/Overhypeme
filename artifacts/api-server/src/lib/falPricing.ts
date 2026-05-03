/**
 * fal.ai Pricing Cache Service
 *
 * Fetches and caches pricing data from fal.ai's pricing API.
 * The cache is warm from server startup and refreshed on an hourly interval.
 * getCachedPrice() only does an on-demand fetch as a fallback when the cache is stale.
 *
 * Price changes are logged at WARN level for auditability.
 */

import { db } from "@workspace/db";
import { falPricingCacheTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

const FAL_PRICING_API = "https://api.fal.ai/v1/models/pricing";
const CACHE_STALE_MS = 60 * 60 * 1000; // 1 hour

function getFalApiKey(): string | undefined {
  return process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
}

interface FalPricingEntry {
  endpoint_id: string;
  unit_price: number;
  unit: string;
  currency?: string;
}

async function fetchPricingFromApi(endpointId: string): Promise<FalPricingEntry | null> {
  const apiKey = getFalApiKey();
  if (!apiKey) {
    logger.warn("[falPricing] No FAL API key found — skipping pricing fetch");
    return null;
  }

  const url = `${FAL_PRICING_API}?endpoint_id=${encodeURIComponent(endpointId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      logger.warn({ status: res.status, endpointId }, "[falPricing] Pricing API returned non-OK");
      return null;
    }

    const body = await res.json() as unknown;

    // Handle various response envelope shapes from fal.ai
    let entries: FalPricingEntry[] = [];
    if (body && typeof body === "object" && "prices" in body && Array.isArray((body as { prices: unknown }).prices)) {
      // { prices: [...], next_cursor, has_more }  — actual fal.ai shape
      entries = (body as { prices: FalPricingEntry[] }).prices;
    } else if (body && typeof body === "object" && "data" in body && Array.isArray((body as { data: unknown }).data)) {
      entries = (body as { data: FalPricingEntry[] }).data;
    } else if (Array.isArray(body)) {
      entries = body as FalPricingEntry[];
    } else if (body && typeof body === "object" && "endpoint_id" in body) {
      entries = [body as FalPricingEntry];
    } else if (body && typeof body === "object" && "unit_price" in body) {
      entries = [{ ...(body as Omit<FalPricingEntry, "endpoint_id">), endpoint_id: endpointId }];
    }

    const match = entries.find(e => e.endpoint_id === endpointId) ?? entries[0];
    if (!match) {
      logger.warn({ endpointId, body: JSON.stringify(body).slice(0, 500) }, "[falPricing] No pricing entry found in API response");
      return null;
    }
    return match;
  } catch (err) {
    logger.warn({ err, endpointId }, "[falPricing] Failed to fetch pricing");
    return null;
  }
}

/**
 * Refresh the pricing cache for the given endpoint IDs.
 * Upserts each result into fal_pricing_cache.
 * Logs a warning if any price has changed since the last fetch.
 */
export async function refreshPricingCache(endpointIds: string[]): Promise<void> {
  for (const endpointId of endpointIds) {
    const entry = await fetchPricingFromApi(endpointId);
    if (!entry) continue;

    const newUnitPrice = String(entry.unit_price);
    const newUnit = entry.unit ?? "unknown";
    const newCurrency = entry.currency ?? "USD";
    const now = new Date();

    // Check for price changes before upsert
    try {
      const [existing] = await db
        .select({ unitPrice: falPricingCacheTable.unitPrice })
        .from(falPricingCacheTable)
        .where(eq(falPricingCacheTable.endpointId, endpointId))
        .limit(1);

      if (existing && parseFloat(existing.unitPrice) !== parseFloat(newUnitPrice)) {
        logger.warn(
          { endpointId, oldPrice: existing.unitPrice, newPrice: newUnitPrice, currency: newCurrency, unit: newUnit },
          "[falPricing] PRICE CHANGE DETECTED",
        );
      }

      await db
        .insert(falPricingCacheTable)
        .values({
          endpointId,
          unitPrice: newUnitPrice,
          unit: newUnit,
          currency: newCurrency,
          fetchedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: falPricingCacheTable.endpointId,
          set: {
            unitPrice: sql`EXCLUDED.unit_price`,
            unit: sql`EXCLUDED.unit`,
            currency: sql`EXCLUDED.currency`,
            fetchedAt: sql`EXCLUDED.fetched_at`,
            updatedAt: sql`now()`,
          },
        });

      logger.info(
        { endpointId, unitPrice: newUnitPrice, currency: newCurrency, unit: newUnit },
        "[falPricing] Cached pricing",
      );
    } catch (err) {
      logger.warn({ err, endpointId }, "[falPricing] Failed to upsert pricing cache");
    }
  }
}

export interface CachedPrice {
  unitPrice: number;
  unit: string;
  fetchedAt: Date;
}

/**
 * Returns the cached price for a given endpoint.
 * If the cache is stale (>1h) or empty, refreshes from the fal.ai API first.
 * Throws if no pricing is available after a refresh attempt.
 */
export async function getCachedPrice(endpointId: string): Promise<CachedPrice> {
  const [row] = await db
    .select()
    .from(falPricingCacheTable)
    .where(eq(falPricingCacheTable.endpointId, endpointId))
    .limit(1);

  const isStale = !row || (Date.now() - row.fetchedAt.getTime() > CACHE_STALE_MS);

  if (isStale) {
    await refreshPricingCache([endpointId]);
    const [fresh] = await db
      .select()
      .from(falPricingCacheTable)
      .where(eq(falPricingCacheTable.endpointId, endpointId))
      .limit(1);

    if (!fresh) {
      throw new Error(`No pricing available for fal.ai endpoint "${endpointId}". Cannot proceed without a known cost.`);
    }
    return {
      unitPrice: parseFloat(fresh.unitPrice),
      unit: fresh.unit,
      fetchedAt: fresh.fetchedAt,
    };
  }

  return {
    unitPrice: parseFloat(row.unitPrice),
    unit: row.unit,
    fetchedAt: row.fetchedAt,
  };
}
