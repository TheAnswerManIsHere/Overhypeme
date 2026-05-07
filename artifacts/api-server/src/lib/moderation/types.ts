/**
 * Common types used across the three moderation layers.
 *
 *   Layer 1: Arachnid Shield (CSAM hash matching) on every face-source upload.
 *   Layer 2: fal.ai built-in safety (`safety_tolerance` request, `has_nsfw_concepts` response).
 *   Layer 3: fal-ai/imageutils/nsfw classifier on every generated/composited image.
 *
 * The `Reject` flow is a one-way door: bytes go to the restricted prefix
 * via `quarantine.quarantineImage`, an audit row is written, and the user
 * gets a generic 422. Per spec, error responses MUST NOT leak which check
 * fired.
 */

import type { QuarantineSource } from "@workspace/db/schema";

export interface ModerationContext {
  userId?: string | null;
  /** Optional fact id when the moderation runs as part of meme/AI generation. */
  factId?: number | null;
  /** Optional meme id once the row exists (Layer 3 reject path may not have one yet). */
  memeId?: number | null;
  /** Free-form trace string surfaced into log lines. */
  trace?: string;
}

export interface ScanEvidence {
  source: QuarantineSource;
  /** Vendor classification label (Arachnid: `csam`, `harmful-abusive-material`, `no-known-match`). */
  classification?: string | null;
  matchType?: string | null;
  /** Probability 0..1 from a fal.ai classifier. */
  classifierScore?: number | null;
  classifierModel?: string | null;
  raw?: unknown;
}

export class ModerationRejectedError extends Error {
  constructor(
    public readonly reason: "arachnid" | "fal_safety" | "classifier",
    public readonly publicMessage: string,
    public readonly evidence?: ScanEvidence,
  ) {
    super(`Moderation rejected: ${reason}`);
    this.name = "ModerationRejectedError";
  }
}

/** Generic message we surface to clients regardless of which check fired. */
export const GENERIC_REJECT_MESSAGE = "This image cannot be uploaded.";
