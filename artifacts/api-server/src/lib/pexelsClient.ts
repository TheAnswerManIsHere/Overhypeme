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
