/**
 * Pexels API client for fetching royalty-free stock photos.
 *
 * Requires PEXELS_API_KEY environment variable.
 * Get a free key at https://www.pexels.com/api/
 *
 * Free tier: 200 requests/hour, 20,000/month.
 * License: Pexels license — free to use in projects/apps, attribution
 * not required (we surface photographer credit in the UI as good practice).
 */

import { logger } from "./logger";

const PEXELS_BASE = "https://api.pexels.com/v1";

// Used only by getRandomStockPhoto for the generic gender fallback
const MAX_PAGE = 40;

const GENDER_QUERIES: Record<"man" | "woman" | "person", string> = {
  man: "man portrait professional",
  woman: "woman portrait professional",
  person: "person portrait professional",
};

// ── Types ─────────────────────────────────────────────────────────────────────

/** Thrown by getRandomStockPhoto on 429. */
export class PexelsRateLimitError extends Error {
  constructor() {
    super("Pexels rate limit reached. Try again shortly.");
    this.name = "PexelsRateLimitError";
  }
}

/** All resolution URLs Pexels provides for a photo. */
export interface PexelsPhotoSrc {
  original: string;
  large2x: string;
  large: string;
  medium: string;
  small: string;
  portrait: string;
  landscape: string;
  tiny: string;
}

/**
 * Stored photo entry. `url` = src.large for backward compat with legacy data.
 * `src`, `photographer`, `photographer_url` present on all new entries.
 */
export interface PexelsPhotoEntry {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
  src?: PexelsPhotoSrc;
}

/** Rich photo returned by getPhotoById / getRandomStockPhoto. */
export interface PexelsPhoto {
  id: number;
  photographerName: string;
  photographerUrl: string;
  /** ~940px wide — large enough for the meme canvas. */
  photoUrl: string;
}

interface PexelsApiPhoto {
  id: number;
  photographer: string;
  photographer_url: string;
  src: PexelsPhotoSrc;
}

interface PexelsSearchResponse {
  photos: PexelsApiPhoto[];
  total_results: number;
}

// ── searchPhotos ──────────────────────────────────────────────────────────────

/**
 * Search Pexels for up to `count` photos (max 80 — Pexels' per_page limit).
 * Always fetches page 1 for stable, deterministic seeding.
 * Stores the full src object so callers can serve any resolution without
 * additional API calls or reconstructing CDN URLs.
 *
 * Returns [] on any error — callers handle degradation gracefully.
 */
export async function searchPhotos(query: string, count: number = 80): Promise<PexelsPhotoEntry[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return [];

  const url = new URL(`${PEXELS_BASE}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("per_page", String(Math.min(count, 80)));
  url.searchParams.set("page", "1");

  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      logger.error("[pexels] 401 Unauthorized — check PEXELS_API_KEY secret.");
      return [];
    }
    if (!response.ok) {
      logger.warn({ query, status: response.status }, "[pexels] searchPhotos failed");
      return [];
    }

    const data = (await response.json()) as PexelsSearchResponse;
    return data.photos.slice(0, count).map((p) => ({
      id: p.id,
      url: p.src.large,
      photographer: p.photographer,
      photographer_url: p.photographer_url,
      src: p.src,
    }));
  } catch (err) {
    logger.warn({ err, query }, "[pexels] searchPhotos error");
    return [];
  }
}

// ── getPhotoById ──────────────────────────────────────────────────────────────

/**
 * Fetch a single photo by its Pexels ID.
 * Useful when re-rendering a meme from a stored recipe.
 */
export async function getPhotoById(photoId: number): Promise<PexelsPhoto> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) throw new Error("PEXELS_API_KEY is not configured.");

  const response = await fetch(`${PEXELS_BASE}/photos/${photoId}`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 401) throw new Error("Invalid PEXELS_API_KEY.");
  if (response.status === 404) throw new Error(`Pexels photo ${photoId} not found.`);
  if (!response.ok) throw new Error(`Pexels API error: ${response.status}`);

  const photo = (await response.json()) as PexelsApiPhoto;
  return {
    id: photo.id,
    photographerName: photo.photographer,
    photographerUrl: photo.photographer_url,
    photoUrl: photo.src.large,
  };
}

// ── getRandomStockPhoto ───────────────────────────────────────────────────────

/**
 * Fetch one random stock photo for the given gender.
 * Used as a fallback when a fact has no stored images yet.
 * Throws PexelsRateLimitError on 429.
 */
export async function getRandomStockPhoto(
  gender: "man" | "woman" | "person",
): Promise<PexelsPhoto> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) throw new Error("PEXELS_API_KEY is not configured.");

  const query = GENDER_QUERIES[gender];
  const page = Math.floor(Math.random() * MAX_PAGE) + 1;

  const url = new URL(`${PEXELS_BASE}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("size", "medium");
  url.searchParams.set("per_page", "15");
  url.searchParams.set("page", String(page));

  const response = await fetch(url.toString(), {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 401) {
    logger.error("[pexels] 401 Unauthorized — check PEXELS_API_KEY secret.");
    throw new Error("Image service is currently unavailable.");
  }
  if (response.status === 429) throw new PexelsRateLimitError();
  if (!response.ok) throw new Error(`Pexels API error: ${response.status}`);

  const data = (await response.json()) as PexelsSearchResponse;
  if (!data.photos?.length) return getRandomStockPhoto(gender);

  const photo = data.photos[Math.floor(Math.random() * data.photos.length)]!;
  return {
    id: photo.id,
    photographerName: photo.photographer,
    photographerUrl: photo.photographer_url,
    photoUrl: photo.src.large,
  };
}
