/**
 * Cost Computation Helpers
 *
 * Computes billing units and estimated USD cost for fal.ai generation jobs.
 * Never hardcodes prices — all unit prices come from the CachedPrice input.
 */

import type { CachedPrice } from "./falPricing";

// ─── Image size name → pixel dimensions ────────────────────────────────────────

const IMAGE_SIZE_MAP: Record<string, { width: number; height: number }> = {
  square_hd:       { width: 1024, height: 1024 },
  square:          { width: 512,  height: 512  },
  portrait_4_3:    { width: 768,  height: 1024 },
  portrait_16_9:   { width: 576,  height: 1024 },
  landscape_4_3:   { width: 1024, height: 768  },
  landscape_16_9:  { width: 1024, height: 576  },
};

/** Resolve fal.ai image_size name to pixel dimensions. Falls back to 1024×1024. */
export function resolveImageSizePx(imageSize: string): { width: number; height: number } {
  return IMAGE_SIZE_MAP[imageSize] ?? { width: 1024, height: 1024 };
}

// ─── Cost result ───────────────────────────────────────────────────────────────

export interface CostResult {
  billingUnits: number;
  costUsd: number;
}

// ─── Image cost ─────────────────────────────────────────────────────────────────

export interface ImageParams {
  widthPx: number;
  heightPx: number;
  count: number;
}

/**
 * Compute image generation cost.
 *
 * Handles two fal.ai pricing unit types:
 *  - "image": billingUnits = count, costUsd = count × unitPrice
 *  - "megapixel": billingUnits = (widthPx × heightPx × count) / 1_000_000, costUsd = billingUnits × unitPrice
 */
export function computeImageCost(params: ImageParams, cachedPrice: CachedPrice): CostResult {
  const { widthPx, heightPx, count } = params;
  if (cachedPrice.unit === "megapixel") {
    const billingUnits = (widthPx * heightPx * count) / 1_000_000;
    return { billingUnits, costUsd: billingUnits * cachedPrice.unitPrice };
  }
  // Default: per-image pricing
  return { billingUnits: count, costUsd: count * cachedPrice.unitPrice };
}
