/**
 * Durable `fact_pexels` image-prep queue.
 *
 * Registered on the shared async-jobs worker (lib/asyncJobs.ts). One job per
 * fact: it runs the LLM → Pexels pipeline (seedFactPexelsImagesOnce) and writes
 * the photo library + `pexels_status` back to the fact, surviving a process
 * restart and surfacing per-fact status in the moderation prep UI.
 *
 * Lifecycle of `facts.pexels_status`:
 *   "pending"  — set by the enqueuer; the job is queued or retrying ("working").
 *   "ok"       — set by seedFactPexelsImagesOnce when photos land.
 *   "failed"   — set ONLY by onAbandon after the queue exhausts its retries, so
 *                "failed" stays distinct from a job that is still running.
 *
 * This queue is image-only and does NOT advance the moderation workflow stage —
 * enrichment is the gate that moves prep_pending → production_review. Pexels runs
 * alongside as tracked best-effort image seeding; a Pexels failure leaves the
 * fact in production_review with pexels_status="failed" (the moderator can retry
 * or approve without images), it never blocks the gate.
 *
 * COST GUARD: if the fact is a staging fact whose review has left prep_pending
 * (e.g. rejected mid-flight), the handler skips all paid OpenAI/Pexels calls and
 * retires the job as a successful no-op — mirroring the enrichment queue.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, type AsyncJobRow } from "@workspace/db/schema";
import { seedFactPexelsImagesOnce } from "./factImagePipeline";
import { isStagingImagePrepActive } from "./moderationStaging";
import {
  registerJobHandler,
  enqueueJob,
  type JobHandler,
  type HandlerResult,
  type EnqueueJobResult,
} from "./asyncJobs";
import { logger } from "./logger";

export const FACT_PEXELS_QUEUE = "fact_pexels";

export interface FactPexelsJobPayload {
  factId: number;
}

/** Stable dedupe key so a re-enqueue can't double-run image prep for one fact. */
export function factPexelsDedupeKey(factId: number): string {
  return `fact_pexels:fact:${factId}`;
}

/**
 * Enqueue durable image prep for a fact and mark it "pending" so the UI shows
 * "working" immediately. Deduped on the in-flight job. Setting the status and
 * enqueuing are best-effort independent of each other: the status write is what
 * the UI polls, the job is what does the work.
 */
export async function enqueueFactPexels(factId: number): Promise<EnqueueJobResult> {
  await db
    .update(factsTable)
    .set({ pexelsStatus: "pending" })
    .where(eq(factsTable.id, factId));
  return enqueueJob({
    queue: FACT_PEXELS_QUEUE,
    payload: { factId },
    dedupeKey: factPexelsDedupeKey(factId),
  });
}

/**
 * Dependency seam for the handler: image seeding is a network call (OpenAI +
 * Pexels), so tests inject a deterministic stub to exercise the
 * cost-guard / success / retryable-failure branches.
 */
export interface FactPexelsDeps {
  seed: typeof seedFactPexelsImagesOnce;
}

/** Core handler logic, extracted so tests can inject `deps.seed`. */
export async function runFactPexelsJob(
  factId: number,
  deps: FactPexelsDeps = { seed: seedFactPexelsImagesOnce },
): Promise<HandlerResult> {
  const [factRow] = await db
    .select({ text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!factRow) {
    return { ok: false, error: `fact ${factId} not found` };
  }

  // COST GUARD: skip paid work if this staging fact's review has been resolved
  // (approved or rejected). Still run when the review is in production_review
  // (moderator still deciding) so images can land before the approval click.
  // Successful no-op so the job retires; leave pexels_status as-is.
  if (!(await isStagingImagePrepActive(factId))) {
    return { ok: true };
  }

  try {
    await deps.seed(factId, factRow.text);
  } catch (err) {
    // Retryable failure: the worker reschedules with backoff and the fact
    // stays "pending" (still running), NOT "failed" — that's reserved for
    // onAbandon once retries are exhausted.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  return { ok: true };
}

export const factPexelsJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { factId } = (payload ?? {}) as FactPexelsJobPayload;
    if (typeof factId !== "number") {
      return { ok: false, error: "fact_pexels payload missing factId" };
    }
    return runFactPexelsJob(factId);
  },

  // Retries exhausted: mark the fact "failed" so the moderation UI shows image
  // prep as terminally failed (distinct from "still running"). Does not touch
  // the workflow stage — Pexels never gates production review.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId } = (row.payload ?? {}) as FactPexelsJobPayload;
    if (typeof factId !== "number") return;
    await db
      .update(factsTable)
      .set({ pexelsStatus: "failed" })
      .where(eq(factsTable.id, factId));
    logger.warn({ factId, jobId: row.id }, "[fact_pexels] image prep abandoned after retries");
  },
};

export function registerFactPexelsJobHandler(): void {
  registerJobHandler(FACT_PEXELS_QUEUE, factPexelsJobHandler);
}
