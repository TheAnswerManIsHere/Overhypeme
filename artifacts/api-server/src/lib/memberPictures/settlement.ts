/**
 * @purpose Every member's AI picture settles, delivered as the member's own or its credit returned, never both and never neither (launch Phase 7, increment 2; plan PLAN_PHASE7_IMAGE_OFFERING.md §2): the delivery the worker commits with the picture, the return written when a picture ends failed, and the repeated recovery pass that settles a failed, abandoned or stranded picture without depending on the queue's best-effort abandonment hook.
 * @subsystem visual-pipeline
 *
 * Delivering and returning are serialised on a lock of the picture's attempt
 * row (`SELECT … FOR UPDATE`), and each re-reads the other's mark under it:
 * a returned picture is never delivered, a delivered one never returned.
 * Migration 0173's triggers refuse either second write if this ever slips.
 *
 * The invariant the tests hold: no member picture ends failed with its spend
 * standing and no return, and none is delivered with a return.
 */
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { asyncJobsTable, db, imagePromptAttemptsTable, userAiImagesTable, type ImagePromptAttempt } from "@workspace/db";
import { pictureCreditState, returnPictureCredit } from "../credits/pictures";
import type { Executor } from "../visualConceptOwner";
import { logger } from "../logger";

/** What a member's picture row in My content records it as. */
export const MEMBER_PICTURE_IMAGE_TYPE = "member_picture";

/** The error code of a picture that the recovery pass found stranded. */
export const STRANDED_ERROR_CODE = "member_picture_stranded";
/** A picture with no live job for this long, not delivered and not failed, is stranded. */
export const STRANDED_AFTER_MS = 5 * 60_000;
/** A picture still undelivered this long after it was asked for is ended, whatever its jobs say. */
export const PICTURE_DEADLINE_MS = 2 * 60 * 60_000;

type LockedAttempt = Pick<ImagePromptAttempt, "id" | "userId" | "factId" | "gagId" | "memberRequestId" | "renderControls" | "generatedImageObjectPath" | "error">;

async function lockAttempt(attemptId: number, tx: Executor): Promise<LockedAttempt | null> {
  const [row] = await tx.select({
    id: imagePromptAttemptsTable.id,
    userId: imagePromptAttemptsTable.userId,
    factId: imagePromptAttemptsTable.factId,
    gagId: imagePromptAttemptsTable.gagId,
    memberRequestId: imagePromptAttemptsTable.memberRequestId,
    renderControls: imagePromptAttemptsTable.renderControls,
    generatedImageObjectPath: imagePromptAttemptsTable.generatedImageObjectPath,
    error: imagePromptAttemptsTable.error,
  }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attemptId)).for("update").limit(1);
  return row ?? null;
}

async function isDelivered(attemptId: number, tx: Executor): Promise<boolean> {
  const [row] = await tx.select({ id: userAiImagesTable.id }).from(userAiImagesTable).where(eq(userAiImagesTable.attemptId, attemptId)).limit(1);
  return !!row;
}

export function isMemberPicture(attempt: Pick<ImagePromptAttempt, "memberRequestId">): boolean {
  return attempt.memberRequestId != null;
}

export type DeliveryOutcome = "delivered" | "already_delivered" | "returned";

/**
 * Deliver a finished member picture as its owner's own, inside the worker's
 * completion transaction: the attempt's stored path and the `user_ai_images`
 * row commit together. A picture whose credit was already returned (the
 * recovery pass got there first) is not delivered and its path is not stored;
 * the caller writes nothing more. A failure here fails the whole transaction,
 * so the picture is retried (and collected, never paid for again) or, at the
 * end, failed and returned; it is never swallowed.
 */
export async function deliverMemberPicture(attemptId: number, storedPath: string, tx: Executor): Promise<DeliveryOutcome> {
  const attempt = await lockAttempt(attemptId, tx);
  if (!attempt || !attempt.userId) throw new Error(`member picture ${attemptId} has no owner to deliver to`);
  if (await isDelivered(attemptId, tx)) return "already_delivered";
  if ((await pictureCreditState(attemptId, tx)).returned) return "returned";
  await tx.update(imagePromptAttemptsTable)
    .set({ generatedImageObjectPath: storedPath, error: null, errorCode: null, updatedAt: new Date() })
    .where(eq(imagePromptAttemptsTable.id, attemptId));
  const rc = (attempt.renderControls ?? {}) as { styleId?: string | null };
  await tx.insert(userAiImagesTable).values({
    userId: attempt.userId,
    factId: attempt.factId,
    gender: "neutral",
    storagePath: storedPath,
    imageType: MEMBER_PICTURE_IMAGE_TYPE,
    attemptId,
    gagId: attempt.gagId ?? null,
    lookStyleId: rc.styleId ?? null,
  });
  return "delivered";
}

/**
 * Return a member picture's credit because it will not be delivered. Inside
 * the caller's transaction (the terminal failure's, or the recovery pass's
 * own). No-op for an attempt that is not a member's picture, one already
 * returned, and one delivered. True when it returned a credit now.
 */
export async function returnUndeliveredPicture(attemptId: number, tx: Executor): Promise<boolean> {
  const attempt = await lockAttempt(attemptId, tx);
  if (!attempt || !isMemberPicture(attempt)) return false;
  if (await isDelivered(attemptId, tx)) return false;
  return returnPictureCredit(attemptId, tx);
}

/**
 * End a member picture now and return its credit: written as failed with the
 * reason, in one transaction with the return. Used by the recovery pass for a
 * stranded picture and for one past its deadline. No-op once delivered.
 */
async function endAndReturn(attemptId: number, code: string, message: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const attempt = await lockAttempt(attemptId, tx);
    if (!attempt || !isMemberPicture(attempt) || (await isDelivered(attemptId, tx))) return false;
    if (!attempt.error) {
      await tx.update(imagePromptAttemptsTable)
        .set({ error: message, errorCode: code, updatedAt: new Date() })
        .where(eq(imagePromptAttemptsTable.id, attemptId));
    }
    return returnPictureCredit(attemptId, tx);
  });
}

const LIVE_JOB_STATUSES = ["pending", "processing", "recovering"];

export interface SettlementPassResult { failedReturned: number; strandedReturned: number; deadlineReturned: number }

/**
 * The recovery pass: settle every member picture that will not be delivered.
 * Safe to run any number of times and concurrently with the worker (each
 * picture is settled under its own lock, and a return is unique per picture).
 *
 *   - failed (its error written: a terminal failure, or the abandonment hook)
 *     and not delivered → its credit is returned;
 *   - stranded: no picture, no error, no live job for either stage, and older
 *     than STRANDED_AFTER_MS (a crash between a job failing and its hook, a job
 *     row lost) → failed and returned;
 *   - past PICTURE_DEADLINE_MS and still not delivered → failed and returned;
 *     a late completion then finds the return and delivers nothing.
 */
export async function runMemberPictureSettlementPass(now = Date.now(), limit = 200): Promise<SettlementPassResult> {
  const result: SettlementPassResult = { failedReturned: 0, strandedReturned: 0, deadlineReturned: 0 };
  const unsettled = sql`NOT EXISTS (SELECT 1 FROM credit_ledger c WHERE c.kind = 'picture_return' AND c.ref = 'picture:' || ${imagePromptAttemptsTable.id}::text)
    AND NOT EXISTS (SELECT 1 FROM user_ai_images u WHERE u.attempt_id = ${imagePromptAttemptsTable.id})
    AND EXISTS (SELECT 1 FROM credit_ledger s WHERE s.kind = 'picture_spend' AND s.ref = 'picture:' || ${imagePromptAttemptsTable.id}::text)`;

  const failed = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable)
    .where(and(isNotNull(imagePromptAttemptsTable.memberRequestId), isNotNull(imagePromptAttemptsTable.error), unsettled))
    .limit(limit);
  for (const { id } of failed) {
    if (await db.transaction((tx) => returnUndeliveredPicture(id, tx))) result.failedReturned++;
  }

  const open = await db.select({ id: imagePromptAttemptsTable.id, createdAt: imagePromptAttemptsTable.createdAt, updatedAt: imagePromptAttemptsTable.updatedAt })
    .from(imagePromptAttemptsTable)
    .where(and(
      isNotNull(imagePromptAttemptsTable.memberRequestId),
      isNull(imagePromptAttemptsTable.error),
      isNull(imagePromptAttemptsTable.generatedImageObjectPath),
      lt(imagePromptAttemptsTable.createdAt, new Date(now - STRANDED_AFTER_MS)),
      unsettled,
    ))
    .limit(limit);
  for (const row of open) {
    if (row.createdAt.getTime() < now - PICTURE_DEADLINE_MS) {
      if (await endAndReturn(row.id, STRANDED_ERROR_CODE, "This picture took too long to draw, so it was stopped.")) result.deadlineReturned++;
      continue;
    }
    const keys = [`image_prompt:attempt:${row.id}`, `image_generation:attempt:${row.id}`];
    const [live] = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
      .where(and(inArray(asyncJobsTable.dedupeKey, keys), or(...LIVE_JOB_STATUSES.map((s) => eq(asyncJobsTable.status, s)))))
      .limit(1);
    if (live) continue;
    // The prompt stage chains the image job in the same transaction that
    // saves the prompt, so "no live job" for both stages means nothing will
    // ever finish this picture.
    if (await endAndReturn(row.id, STRANDED_ERROR_CODE, "This picture stopped before it was drawn.")) result.strandedReturned++;
  }

  const total = result.failedReturned + result.strandedReturned + result.deadlineReturned;
  if (total > 0) logger.info(result, "[memberPictures] settlement pass returned credits");
  return result;
}
