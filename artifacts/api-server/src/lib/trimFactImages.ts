/**
 * Image trimming utilities for the facts API response.
 *
 * Caps the number of AI-meme image paths per gender variant sent to the
 * client. The database continues to store full data; trimming is applied at
 * response time only. (A Pexels stock-photo trimmer lived here until launch
 * Phase 4, removal 6 deleted stock photos.)
 */

import type { AiMemeImages } from "./aiMemePipeline";

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
