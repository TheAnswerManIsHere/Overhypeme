/**
 * Image trimming utilities for the facts API response.
 *
 * Strips the bulky `src` multi-resolution object from Pexels entries and
 * caps the number of entries per gender variant sent to the client.
 * The database continues to store full data; trimming is applied at response
 * time only.
 */

import type { FactPexelsImages } from "./factImagePipeline";
import type { AiMemeImages } from "./aiMemePipeline";

/** Trimmed Pexels entry — only the fields the frontend needs. */
export interface TrimmedPexelsPhotoEntry {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
}

export interface TrimmedFactPexelsImages {
  fact_type: "action" | "abstract";
  male: TrimmedPexelsPhotoEntry[];
  female: TrimmedPexelsPhotoEntry[];
  neutral: TrimmedPexelsPhotoEntry[];
  keywords?: {
    male: string;
    female: string;
    neutral: string;
  };
}

function trimPexelsEntry(entry: { id: number; url: string; photographer?: string; photographer_url?: string; src?: unknown }): TrimmedPexelsPhotoEntry {
  return {
    id: entry.id,
    url: entry.url,
    ...(entry.photographer !== undefined ? { photographer: entry.photographer } : {}),
    ...(entry.photographer_url !== undefined ? { photographer_url: entry.photographer_url } : {}),
  };
}

/** Maximum images per gender variant that can be served regardless of admin config. */
const MAX_CAP = 20;

/**
 * Sanitizes an admin-supplied cap value.
 * Clamps to [0, MAX_CAP] so negative or unreasonably large values cannot
 * partially defeat payload control.
 */
function sanitizeCap(raw: number): number {
  return Math.max(0, Math.min(Math.trunc(raw), MAX_CAP));
}

/**
 * Returns a trimmed copy of a FactPexelsImages object:
 * - Each gender variant is sliced to `cap` entries
 * - The `src` multi-resolution object is stripped from every entry
 */
export function trimPexelsImages(
  images: FactPexelsImages | null | undefined,
  cap: number,
): TrimmedFactPexelsImages | null {
  if (!images) return null;
  const n = sanitizeCap(cap);
  return {
    fact_type: images.fact_type,
    male: images.male.slice(0, n).map(trimPexelsEntry),
    female: images.female.slice(0, n).map(trimPexelsEntry),
    neutral: images.neutral.slice(0, n).map(trimPexelsEntry),
    ...(images.keywords ? { keywords: images.keywords } : {}),
  };
}

/**
 * Returns a trimmed copy of an AiMemeImages object:
 * - Each gender variant is sliced to `cap` paths
 */
export function trimAiMemeImages(
  images: AiMemeImages | null | undefined,
  cap: number,
): AiMemeImages | null {
  if (!images) return null;
  const n = sanitizeCap(cap);
  return {
    male: images.male.slice(0, n),
    female: images.female.slice(0, n),
    neutral: images.neutral.slice(0, n),
  };
}
