/**
 * Client for the "resubmit for moderation" action — the reactivation-gap fix
 * (Codex round 7, PR #242 Phase 2 fact-lifecycle closure). Round 4 made
 * activation moderation-only, but nothing put a deactivated fact BACK through
 * moderation: send-back-to-review only works on an already-active fact. This
 * re-enters an INACTIVE fact at prep_pending, reusing its existing id/history.
 *
 * POST /api/admin/facts/:id/resubmit-for-moderation
 */

/** 409/404 codes the endpoint returns; surfaced verbatim so callers can special-case them. */
export type ResubmitForModerationCode = "FACT_NOT_FOUND" | "ALREADY_ACTIVE" | "REVIEW_ALREADY_IN_PROGRESS";

export interface ResubmitForModerationResult {
  success: boolean;
  /** The new review's id (present on success). */
  reviewId?: number;
  /** Human-readable error (present on failure). */
  error?: string;
  /** Machine code for a 404/409, when the server supplied one. */
  code?: ResubmitForModerationCode | string;
}

/**
 * Fire the resubmit. Never throws for an HTTP error; a rejected/failed call
 * resolves to `{ success: false, error, code? }`. Only a network failure
 * resolves to a generic error result.
 */
export async function resubmitFactForModeration(factId: number): Promise<ResubmitForModerationResult> {
  try {
    const res = await fetch(`/api/admin/facts/${factId}/resubmit-for-moderation`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
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
      error: data.error ?? `Resubmit failed (${res.status})`,
      code: data.code,
    };
  } catch {
    return { success: false, error: "Network error — could not reach the server." };
  }
}
