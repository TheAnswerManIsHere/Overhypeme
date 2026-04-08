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

// ─── Aspect ratio + resolution → pixel dimensions ──────────────────────────────

const ASPECT_RATIO_AT_720P: Record<string, { width: number; height: number }> = {
  "16:9":  { width: 1280, height: 720  },
  "9:16":  { width: 720,  height: 1280 },
  "1:1":   { width: 720,  height: 720  },
  "4:3":   { width: 960,  height: 720  },
  "3:4":   { width: 720,  height: 960  },
  "3:2":   { width: 1080, height: 720  },
  "2:3":   { width: 720,  height: 1080 },
  "21:9":  { width: 1680, height: 720  },
};

/**
 * Resolve video dimensions from aspect ratio + resolution string.
 * Falls back to 720p 16:9 (1280×720) if unknown.
 */
export function resolveVideoDimensions(
  aspectRatio: string,
  resolution: string,
): { width: number; height: number } {
  const base = ASPECT_RATIO_AT_720P[aspectRatio] ?? { width: 1280, height: 720 };
  if (resolution === "480p") {
    // Scale down proportionally from 720p base
    const scale = 480 / 720;
    return {
      width: Math.round(base.width * scale),
      height: Math.round(base.height * scale),
    };
  }
  return base; // 720p
}

// ─── Video cost ─────────────────────────────────────────────────────────────────

export interface VideoParams {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
}

export interface CostResult {
  billingUnits: number;
  costUsd: number;
}

/**
 * Compute video generation cost.
 *
 * Formula (per fal.ai video token pricing):
 *   tokens = (width × height × fps × durationSeconds) / 1024
 *   costUsd = (tokens / 1_000_000) × unitPrice
 *
 * unitPrice from the pricing cache is per 1M video tokens.
 */
export function computeVideoCost(params: VideoParams, cachedPrice: CachedPrice): CostResult {
  const { width, height, fps, durationSeconds } = params;
  const tokens = (width * height * fps * durationSeconds) / 1024;
  const costUsd = (tokens / 1_000_000) * cachedPrice.unitPrice;
  return { billingUnits: tokens, costUsd };
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
