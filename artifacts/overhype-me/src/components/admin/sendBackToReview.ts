/**
 * Shared client for the stale-fact-refresh "send back to review" action.
 *
 * Both the Facts editor (its modal, with the clear-overrides choice) and the
 * Taxonomy Health stale-for-reprocess list (a direct, inline send-back that
 * keeps overrides) call this, so the request shape + the 409 codes are defined
 * in exactly one place.
 *
 * POST /api/admin/facts/:id/send-back-to-review opens a fresh refresh cycle:
 * it seeds a candidate from the fact's current enrichment and re-runs
 * classification, leaving the live fact untouched until the candidate is
 * promoted from the Moderation queue.
 */

/** 409 codes the endpoint returns; surfaced verbatim so callers can special-case them. */
export type SendBackToReviewCode =
  | "NOT_ACTIVE"
  | "HAS_ACTIVE_VARIANTS"
  | "REFRESH_ALREADY_IN_PROGRESS";

export interface SendBackToReviewResult {
  success: boolean;
  /** The new refresh cycle's review id (present on success). */
  reviewId?: number;
  /** Human-readable error (present on failure). */
  error?: string;
  /** Machine code for a 409 conflict, when the server supplied one. */
  code?: SendBackToReviewCode | string;
}

/**
 * Fire the send-back. `clearOverrides` wipes the candidate's seeded manual
 * overrides (defaults false — the stale-for-reprocess list always keeps them).
 * Never throws for an HTTP error; a rejected/failed call resolves to
 * `{ success: false, error, code? }`. Only a network failure resolves to a
 * generic error result.
 */
export async function sendFactBackToReview(
  factId: number,
  opts: { clearOverrides?: boolean } = {},
): Promise<SendBackToReviewResult> {
  try {
    const res = await fetch(`/api/admin/facts/${factId}/send-back-to-review`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearOverrides: opts.clearOverrides ?? false }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      reviewId?: number;
      error?: string;
      code?: string;
    };
    if (res.ok) {
      return { success: true, reviewId: data.reviewId };
    }
    return {
      success: false,
      error: data.error ?? `Send back failed (${res.status})`,
      code: data.code,
    };
  } catch {
    return { success: false, error: "Network error — could not reach the server." };
  }
}
