/**
 * Async-job handler for the `fact_send_back` queue — the bulk-initiation half
 * of the stale-fact refresh feature (PR4). Fans `sendFactBackToReview` out
 * across many facts. A guard rejection (fact not active / already in review)
 * is a terminal SKIP, not a retryable failure — that is what makes re-running
 * a batch idempotent. Any other error is retried by the async-jobs worker
 * like any other job.
 */

import type { TaxonomyHealthSkipReason } from "@workspace/api-zod";
import { registerJobHandler, enqueueJob, type JobHandler, type HandlerResult } from "./asyncJobs";
import { sendFactBackToReview, SendBackToReviewError, type SendBackToReviewErrorCode } from "./sendBackToReview";
import { findInFlightRefreshCandidate } from "./enrichmentVersioning";
import { logger } from "./logger";

export const FACT_SEND_BACK_QUEUE = "fact_send_back";

export interface FactSendBackPayload {
  factId: number;
  /** Admin who triggered the bulk run — recorded on the candidate row. */
  adminId?: string | null;
}

/**
 * Maps a `SendBackToReviewError` guard code to the shared skip vocabulary.
 * Shared with `pickSendBackTargets` (the bulk-endpoint target picker) so a
 * pre-skip (picker) and a race-condition skip (handler) always render
 * identical copy. `FACT_NOT_FOUND` is not a guard skip — the picker only ever
 * targets facts it just loaded, so a fact vanishing in between is an
 * unexpected condition, handled as a retryable failure below.
 */
export function sendBackGuardToSkip(
  code: SendBackToReviewErrorCode,
): { reason: TaxonomyHealthSkipReason; message: string } | null {
  switch (code) {
    case "NOT_ACTIVE":
      return { reason: "not_active", message: "Only active facts can be sent back." };
    case "REFRESH_ALREADY_IN_PROGRESS":
      return { reason: "already_in_review", message: "Refresh already in review." };
    case "FACT_NOT_FOUND":
      return null;
  }
}

export const factSendBackHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const p = payload as FactSendBackPayload;
    if (typeof p?.factId !== "number") {
      return { ok: false, error: "fact_send_back: payload missing factId" };
    }
    try {
      const result = await sendFactBackToReview({ factId: p.factId, adminId: p.adminId ?? null });
      return {
        ok: true,
        result: { reviewId: result.reviewId, candidateVersionId: result.candidateVersionId, versionNo: result.versionNo },
      };
    } catch (err) {
      if (err instanceof SendBackToReviewError) {
        if (err.code === "REFRESH_ALREADY_IN_PROGRESS") {
          return await recoverInFlightRefresh(p.factId, err);
        }
        const skip = sendBackGuardToSkip(err.code);
        if (skip) return { ok: true, result: { skipped: true, reason: skip.reason } };
        return { ok: false, error: err.message }; // FACT_NOT_FOUND — retry
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, factId: p.factId }, "[fact_send_back] unexpected error");
      return { ok: false, error: message };
    }
  },
};

/**
 * `REFRESH_ALREADY_IN_PROGRESS` recovery. `sendFactBackToReview` commits the
 * candidate + review row, then enqueues the candidate enrichment job in a
 * SEPARATE step after commit. If that post-commit enqueue fails (crash,
 * transient outage), the refresh cycle exists but no enrichment job does —
 * stranded at `prep_pending` forever. Simply retiring this as "already in
 * review" would mask that. So before skipping, defensively re-enqueue the
 * candidate enrichment job — idempotent, since the enrichment handler no-ops
 * once the candidate/review has moved past `prep_pending`, and the dedupe key
 * attaches to any already-live job.
 *
 * `err.existing` is OPTIONAL: the unique-violation recovery path inside
 * `sendFactBackToReview` can throw this same code with `existing` undefined if
 * the winning candidate vanished between the conflict and the post-conflict
 * lookup. In that case, do one fresh lookup rather than assume a value.
 */
export async function recoverInFlightRefresh(factId: number, err: SendBackToReviewError): Promise<HandlerResult> {
  let candidateVersionId = err.existing?.candidateVersionId;
  if (candidateVersionId == null) {
    const existing = await findInFlightRefreshCandidate(factId);
    candidateVersionId = existing?.candidateVersionId;
  }
  if (candidateVersionId == null) {
    // Could not resolve the in-flight candidate at all — don't mask a possible
    // strand as a clean skip. Retry the outer job instead.
    return { ok: false, error: "Refresh already in progress but candidateVersionId could not be resolved" };
  }
  try {
    await enqueueJob({
      queue: "enrichment",
      payload: { factId, versionId: candidateVersionId },
      dedupeKey: `enrichment:version:${candidateVersionId}`,
    });
    logger.info(
      { factId, candidateVersionId },
      "[fact_send_back] re-enqueued candidate enrichment for in-flight refresh",
    );
  } catch (enqueueErr) {
    logger.warn(
      { err: enqueueErr, factId, candidateVersionId },
      "[fact_send_back] strand-recovery enqueue failed",
    );
    return { ok: false, error: "Could not confirm the in-flight refresh has a queued enrichment job." };
  }
  return { ok: true, result: { skipped: true, reason: sendBackGuardToSkip("REFRESH_ALREADY_IN_PROGRESS")!.reason } };
}

export function registerFactSendBackHandler(): void {
  // `fast` lane: pure-DB admin action (no model/image wait) — must stay
  // near-instant regardless of bulk/render backlog.
  registerJobHandler(FACT_SEND_BACK_QUEUE, factSendBackHandler, { lane: "fast" });
}
