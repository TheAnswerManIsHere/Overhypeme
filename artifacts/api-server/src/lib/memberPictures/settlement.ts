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
import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { asyncJobsTable, db, imagePromptAttemptsTable, userAiImagesTable, type ImagePromptAttempt } from "@workspace/db";
import { pictureCreditState, returnPictureCredit } from "../credits/pictures";
import type { Executor } from "../visualConceptOwner";
import { logger } from "../logger";
import { IMAGE_GENERATION_QUEUE, IMAGE_PROMPT_QUEUE, imageJobDedupeKey, promptJobDedupeKey } from "../imagePromptAttempts";
import { STRANDED_ERROR_CODE } from "./failures";


/** What a member's picture row in My content records it as. */
export const MEMBER_PICTURE_IMAGE_TYPE = "member_picture";

/** A picture with no live job for this long, not delivered and not failed, is stranded. */
const STRANDED_AFTER_MS = 5 * 60_000;
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

type DeliveryOutcome = "delivered" | "already_delivered" | "returned";

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
 * returned, and one delivered. With `failWith`, a picture not yet written as
 * failed is written so first (a stranded one, or one past its deadline). True
 * when it returned a credit now.
 */
export async function returnUndeliveredPicture(attemptId: number, tx: Executor, failWith?: { code: string; message: string }): Promise<boolean> {
  const attempt = await lockAttempt(attemptId, tx);
  if (!attempt || !isMemberPicture(attempt)) return false;
  if (await isDelivered(attemptId, tx)) return false;
  if (failWith && !attempt.error) {
    await tx.update(imagePromptAttemptsTable)
      .set({ error: failWith.message, errorCode: failWith.code, updatedAt: new Date() })
      .where(eq(imagePromptAttemptsTable.id, attemptId));
  }
  return returnPictureCredit(attemptId, tx);
}

const LIVE_JOB_STATUSES = ["pending", "processing", "recovering"];
/**
 * A failed picture is normally returned in its failure's own transaction, so
 * the pass only ever finds recent ones unsettled (the hook was skipped, or the
 * process stopped between the two). It looks back this far, which bounds its
 * scan as history grows.
 */
const FAILED_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

interface SettlementPassResult { failedReturned: number; strandedReturned: number; deadlineReturned: number }

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
 *
 * The SQL below restates "spent, not returned, not delivered" to find
 * candidates; `returnUndeliveredPicture` decides under the lock.
 */
export async function runMemberPictureSettlementPass(now = Date.now(), limit = 200): Promise<SettlementPassResult> {
  const result: SettlementPassResult = { failedReturned: 0, strandedReturned: 0, deadlineReturned: 0 };
  const unsettled = sql`NOT EXISTS (SELECT 1 FROM credit_ledger c WHERE c.kind = 'picture_return' AND c.ref = 'picture:' || ${imagePromptAttemptsTable.id}::text)
    AND NOT EXISTS (SELECT 1 FROM user_ai_images u WHERE u.attempt_id = ${imagePromptAttemptsTable.id})
    AND EXISTS (SELECT 1 FROM credit_ledger s WHERE s.kind = 'picture_spend' AND s.ref = 'picture:' || ${imagePromptAttemptsTable.id}::text)`;

  const failed = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable)
    .where(and(
      isNotNull(imagePromptAttemptsTable.memberRequestId),
      isNotNull(imagePromptAttemptsTable.error),
      gt(imagePromptAttemptsTable.updatedAt, new Date(now - FAILED_LOOKBACK_MS)),
      unsettled,
    ))
    .limit(limit);
  for (const { id } of failed) {
    if (await db.transaction((tx) => returnUndeliveredPicture(id, tx))) result.failedReturned++;
  }

  const open = await db.select({ id: imagePromptAttemptsTable.id, createdAt: imagePromptAttemptsTable.createdAt })
    .from(imagePromptAttemptsTable)
    .where(and(
      isNotNull(imagePromptAttemptsTable.memberRequestId),
      isNull(imagePromptAttemptsTable.error),
      isNull(imagePromptAttemptsTable.generatedImageObjectPath),
      lt(imagePromptAttemptsTable.createdAt, new Date(now - STRANDED_AFTER_MS)),
      unsettled,
    ))
    .limit(limit);
  // One read of the live jobs for every candidate. The prompt stage chains the
  // image job in the same transaction that saves the prompt, so "no live job"
  // for both stages means nothing will ever finish the picture.
  const keys = open.flatMap((r) => [promptJobDedupeKey(r.id), imageJobDedupeKey(r.id)]);
  const live = new Set(keys.length === 0 ? [] : (await db.select({ key: asyncJobsTable.dedupeKey }).from(asyncJobsTable)
    .where(and(
      inArray(asyncJobsTable.queue, [IMAGE_PROMPT_QUEUE, IMAGE_GENERATION_QUEUE]),
      inArray(asyncJobsTable.dedupeKey, keys),
      inArray(asyncJobsTable.status, LIVE_JOB_STATUSES),
    ))).map((j) => j.key));
  for (const row of open) {
    const pastDeadline = row.createdAt.getTime() < now - PICTURE_DEADLINE_MS;
    if (!pastDeadline && (live.has(promptJobDedupeKey(row.id)) || live.has(imageJobDedupeKey(row.id)))) continue;
    const message = pastDeadline ? "This picture took too long to draw, so it was stopped." : "This picture stopped before it was drawn.";
    if (await db.transaction((tx) => returnUndeliveredPicture(row.id, tx, { code: STRANDED_ERROR_CODE, message }))) {
      if (pastDeadline) result.deadlineReturned++;
      else result.strandedReturned++;
    }
  }

  const total = result.failedReturned + result.strandedReturned + result.deadlineReturned;
  if (total > 0) logger.info(result, "[memberPictures] settlement pass returned credits");
  return result;
}
