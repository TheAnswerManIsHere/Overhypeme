/**
 * Pexels API client for fetching royalty-free stock photos.
 *
 * Requires PEXELS_API_KEY environment variable.
 * Get a free key at https://www.pexels.com/api/
 *
 * Free tier: 200 requests/hour, 20,000/month.
 * License: Pexels license — free to use in projects/apps, no attribution required
 * (though we surface photographer credit in the UI as good practice).
 */

const PEXELS_BASE = "https://api.pexels.com/v1";

const GENDER_QUERIES: Record<"man" | "woman" | "person", string> = {
  man: "man portrait professional",
  woman: "woman portrait professional",
  person: "person portrait professional",
};

// Spread page selection across a wide range for variety.
const MAX_PAGE = 12;

export interface PexelsPhoto {
  id: number;
  photographerName: string;
  photographerUrl: string;
  /** ~940px wide — large enough for the 800×420 meme canvas. */
  photoUrl: string;
}

interface PexelsApiPhoto {
  id: number;
  photographer: string;
  photographer_url: string;
  src: {
    large2x: string;
    large: string;
    medium: string;
  };
}

interface PexelsSearchResponse {
  photos: PexelsApiPhoto[];
  total_results: number;
}

/**
 * Fetch a single photo by its Pexels ID.
 * Used when regenerating a meme from a stored recipe — more stable than
 * relying on the CDN URL remaining valid long-term.
 */
export async function getPhotoById(photoId: number): Promise<PexelsPhoto> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "PEXELS_API_KEY is not configured. Add it to your Replit secrets.",
    );
  }

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

/**
 * Search Pexels by keyword and return the top N photo IDs.
 * Used by factImagePipeline to pre-populate fact image libraries.
 * Returns an empty array (not throws) on any error — callers handle degradation.
 */
export interface PexelsPhotoEntry {
  id: number;
  url: string;
}

export async function searchPhotoIds(query: string, count: number = 5): Promise<number[]> {
  return (await searchPhotos(query, count)).map(p => p.id);
}

export async function searchPhotos(query: string, count: number = 5, page?: number): Promise<PexelsPhotoEntry[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return [];

  const resolvedPage = page ?? (Math.floor(Math.random() * MAX_PAGE) + 1);

  const url = new URL(`${PEXELS_BASE}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("per_page", String(Math.min(count, 80)));
  url.searchParams.set("page", String(resolvedPage));

  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[pexels] searchPhotos("${query}") failed with status ${response.status}`);
      return [];
    }

    const data = (await response.json()) as PexelsSearchResponse;
    return data.photos.slice(0, count).map((p) => ({ id: p.id, url: p.src.large }));
  } catch (err) {
    console.warn(`[pexels] searchPhotos("${query}") error:`, err);
    return [];
  }
}

export async function getRandomStockPhoto(
  gender: "man" | "woman" | "person",
): Promise<PexelsPhoto> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "PEXELS_API_KEY is not configured. Add it to your Replit secrets.",
    );
  }

  const query = GENDER_QUERIES[gender];
  const page = Math.floor(Math.random() * MAX_PAGE) + 1;

  const url = new URL(`${PEXELS_BASE}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("size", "medium"); // at least 1280×960
  url.searchParams.set("per_page", "15");
  url.searchParams.set("page", String(page));

  const response = await fetch(url.toString(), {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 401) {
    throw new Error("Invalid PEXELS_API_KEY — check your Replit secrets.");
  }
  if (response.status === 429) {
    throw new Error("Pexels API rate limit hit. Try again shortly.");
  }
  if (!response.ok) {
    throw new Error(`Pexels API error: ${response.status}`);
  }

  const data = (await response.json()) as PexelsSearchResponse;

  if (!data.photos?.length) {
    // Retry with page 1 if random page had no results
    return getRandomStockPhoto(gender);
  }

  const photo =
    data.photos[Math.floor(Math.random() * data.photos.length)]!;

  return {
    id: photo.id,
    photographerName: photo.photographer,
    photographerUrl: photo.photographer_url,
    photoUrl: photo.src.large, // 940px wide
  };
}
