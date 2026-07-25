/**
 * Durable `fact_pexels` image-prep queue.
 *
 * Registered on the shared async-jobs worker (lib/asyncJobs.ts), on its own
 * dedicated `"pexels"` lane (maxConcurrency 1). One job per fact: it runs the
 * LLM → Pexels pipeline (seedFactPexelsImagesOnce) and writes the photo
 * library + `pexels_status` back to the fact, surviving a process restart and
 * surfacing per-fact status in the moderation prep UI.
 *
 * Lifecycle of `facts.pexels_status`:
 *   "pending"  — set by the enqueuer; the job is queued or retrying ("working").
 *   "ok"       — set by seedFactPexelsImagesOnce when photos land.
 *   "failed"   — set by onAbandon after the queue exhausts its retries, OR by
 *                the bulk-backfill inactive-fact skip below (that enum has no
 *                dedicated skip state; the job's own structured `{skipped:
 *                true, reason: "not_active"}` result carries the real reason
 *                for consumers that read it, e.g. the CLI backfill scripts).
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
 *
 * PACING: the shared `"pexels"` lane is serialized (maxConcurrency 1), but
 * concurrency alone doesn't reproduce the 1-second Pexels rate-limit spacing
 * the old direct-call bulk routes had — a concurrency-1 lane still starts the
 * next job immediately after the previous one finishes. The handler sleeps 1s
 * after finishing, before returning, to restore that spacing (a harmless 1s
 * tail latency on `firstTimeStagingPrep.ts`'s single-fact enqueue too — already
 * best-effort/non-blocking).
 *
 * Known, deliberately deferred limitation (David, 2026-07-25 — same call as
 * `aiMemeBackfillJobs.ts`'s identical note): the pacing sleep above widens a
 * narrow race between this handler's `pexels_status` write and its
 * `async_jobs` row's finalization. If a second enqueue lands in that window,
 * `enqueueFactPexels`'s unconditional status write resets the fact to
 * "pending" and then dedupes onto this still-`processing` row — finalizing it
 * never repairs the fact's status, leaving it stuck at "pending". Closing this
 * needs `enqueueJob`'s dedupe-conflict handling to compose inside a
 * caller-managed transaction, which it doesn't today; the underlying
 * `pexelsImages` data is unaffected either way, only the status marker can go
 * stale. Tracked as the same class of gap as `aiMemeBackfillJobs.ts` (Codex
 * review, PR #256), not fixed here.
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

/** 1s spacing between jobs on the serialized "pexels" lane — see module docstring. */
const PEXELS_PACING_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FactPexelsJobPayload {
  factId: number;
  /**
   * Set only by bulk-backfill producers (the admin HTTP routes and the
   * standalone CLI scripts) — never by `firstTimeStagingPrep.ts`'s single-fact
   * enqueue. When set, the handler does an *additional* direct `isActive`
   * check before running the pipeline, skipping with a structured result if
   * the fact was deactivated while the job waited in the (now-serialized)
   * lane. `isStagingImagePrepActive`'s OR-with-review logic must stay
   * unchanged for staging-prep callers — a staging fact with an unresolved
   * review is legitimately not yet active.
   */
  bulkBackfill?: boolean;
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
export async function enqueueFactPexels(
  factId: number,
  opts?: { bulkBackfill?: boolean },
): Promise<EnqueueJobResult> {
  await db
    .update(factsTable)
    .set({ pexelsStatus: "pending" })
    .where(eq(factsTable.id, factId));
  return enqueueJob({
    queue: FACT_PEXELS_QUEUE,
    payload: { factId, ...(opts?.bulkBackfill ? { bulkBackfill: true } : {}) },
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
  bulkBackfill = false,
  deps: FactPexelsDeps = { seed: seedFactPexelsImagesOnce },
): Promise<HandlerResult> {
  const [factRow] = await db
    .select({ text: factsTable.text, isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!factRow) {
    return { ok: false, error: `fact ${factId} not found` };
  }

  // Bulk-backfill execution-time inactive recheck: an enqueue-time isActive
  // check alone misses a fact deactivated while its job waits in the
  // serialized lane. Not applied to staging-prep callers (bulkBackfill unset)
  // — `isStagingImagePrepActive` below is the correct guard for those.
  if (bulkBackfill && !factRow.isActive) {
    await db.update(factsTable).set({ pexelsStatus: "failed" }).where(eq(factsTable.id, factId));
    await sleep(PEXELS_PACING_MS);
    return { ok: true, result: { skipped: true, reason: "not_active" } };
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
    await sleep(PEXELS_PACING_MS);
    return { ok: false, error: msg };
  }

  await sleep(PEXELS_PACING_MS);
  return { ok: true };
}

export const factPexelsJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { factId, bulkBackfill } = (payload ?? {}) as FactPexelsJobPayload;
    if (typeof factId !== "number") {
      return { ok: false, error: "fact_pexels payload missing factId" };
    }
    return runFactPexelsJob(factId, bulkBackfill === true);
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
  registerJobHandler(FACT_PEXELS_QUEUE, factPexelsJobHandler, { lane: "pexels" });
}
