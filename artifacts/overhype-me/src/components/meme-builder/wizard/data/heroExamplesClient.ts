/**
 * Typed client for GET /api/hero-examples.
 *
 * Returns active rows per artifact type, server-ordered by sort_order then
 * id. The wizard randomizes which one it shows on top of this.
 */

export interface HeroExampleDTO {
  id: number;
  artifactType: "image" | "video";
  assetUrl: string;
  posterUrl: string | null;
  captionLabel: string;
}

export interface HeroExamplesResponse {
  image: HeroExampleDTO[];
  video: HeroExampleDTO[];
}

export async function fetchHeroExamples(
  signal?: AbortSignal,
): Promise<HeroExamplesResponse> {
  const res = await fetch("/api/hero-examples", {
    credentials: "include",
    signal,
  });
  if (!res.ok) {
    throw new Error(`hero-examples: ${res.status}`);
  }
  const body = (await res.json()) as Partial<HeroExamplesResponse>;
  return {
    image: Array.isArray(body.image) ? body.image : [],
    video: Array.isArray(body.video) ? body.video : [],
  };
}
