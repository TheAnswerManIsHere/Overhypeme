/**
 * @purpose A review's duplicate verdict: the server's check of its current wording, stored and shown at triage as a verdict.
 * @subsystem moderation
 *
 * A review's duplicate verdict (plan docs/plans/PLAN_DUPLICATE_VERDICT.md,
 * Issue #1003): the server's duplicate check of the review's CURRENT wording,
 * stored on the review and shown at triage as a verdict, never a percentage.
 *
 *   - checkReviewDuplicate: the one operation that writes a result. It checks
 *     the review's wording and writes only while that wording is unchanged and
 *     the review is still at triage, so a result always belongs to the wording
 *     beside it. Triggered after a submission commits, and on demand when triage
 *     opens a review with no usable result (David, Q1: on first open).
 *   - storedDuplicateColumns: the columns a result writes; a triage wording edit
 *     writes them with the new wording, under its lock.
 *   - duplicateViews: what a screen shows. A stored "duplicate" whose target no
 *     longer supports it (the pending review was edited or resolved, the fact was
 *     deleted or deactivated) reads "not_checked", and triage rechecks it.
 *
 * The detector is passed in rather than imported, so this module stays below
 * the routes and tests can supply one.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { duplicateMatchText } from "./duplicateText";
import { logger } from "./logger";

export type DuplicateOutcome = "duplicate" | "distinct" | "unavailable";

/** The detector's result, as routes/ai.ts checkDuplicateInternal returns it (the fields this module reads). */
export interface DetectorResult {
  outcome: DuplicateOutcome;
  confidence: number;
  matchingFactId?: number;
  matchingReviewId?: number;
}
export type DuplicateDetector = (text: string, opts: { excludeReviewId?: number }) => Promise<DetectorResult>;

/** What a screen shows: "not_checked" covers no result AND a stale "duplicate". */
export type DuplicateState = DuplicateOutcome | "not_checked";
export interface DuplicateView {
  state: DuplicateState;
  /** The matched fact on "duplicate"; the nearest fact on "distinct" / "unavailable", when it still exists. */
  fact: { id: number; text: string } | null;
  /** The matched pending review on "duplicate". */
  review: { id: number; text: string } | null;
}

type ReviewRow = typeof pendingReviewsTable.$inferSelect;

/** Whether a review's wording can still take a duplicate result: a submission at triage. */
export function isAtDuplicateTriage(review: Pick<ReviewRow, "status" | "workflowStage">): boolean {
  return review.status === "pending" && review.workflowStage === "triage_pending";
}

/** The columns a detector result writes onto its review. */
export function storedDuplicateColumns(result: DetectorResult, at: Date = new Date()) {
  return {
    duplicateOutcome: result.outcome,
    matchingFactId: result.matchingFactId ?? null,
    matchingReviewId: result.matchingReviewId ?? null,
    matchingSimilarity: Math.max(0, Math.min(100, Math.round(result.confidence ?? 0))),
    duplicateCheckedAt: at,
  };
}

/** Run the detector, turning a throw into "unavailable" (never "distinct"). */
export async function runDetector(detector: DuplicateDetector, text: string, reviewId: number): Promise<DetectorResult> {
  try {
    return await detector(text, { excludeReviewId: reviewId });
  } catch (err) {
    logger.error({ err, reviewId }, "[duplicate] the duplicate check failed");
    return { outcome: "unavailable", confidence: 0 };
  }
}

/**
 * Check a review's current wording and store the result. Writes nothing when the
 * review is not at triage, or when its wording changed while the check ran (the
 * newer wording's own check owns the result). Returns the review as it stands.
 */
export async function checkReviewDuplicate(reviewId: number, detector: DuplicateDetector): Promise<ReviewRow | null> {
  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);
  if (!review) return null;
  if (!isAtDuplicateTriage(review)) return review;
  const checkedText = review.submittedText;
  const result = await runDetector(detector, checkedText, reviewId);
  const [updated] = await db.update(pendingReviewsTable)
    .set(storedDuplicateColumns(result))
    .where(and(
      eq(pendingReviewsTable.id, reviewId),
      eq(pendingReviewsTable.submittedText, checkedText),
      eq(pendingReviewsTable.status, "pending"),
      eq(pendingReviewsTable.workflowStage, "triage_pending"),
    ))
    .returning();
  if (updated) return updated;
  const [current] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);
  return current ?? null;
}

/** Whether triage should (re)check this review on opening: no usable result for its wording. */
export function needsDuplicateCheck(review: Pick<ReviewRow, "status" | "workflowStage">, view: DuplicateView): boolean {
  return isAtDuplicateTriage(review) && (view.state === "not_checked" || view.state === "unavailable");
}

/**
 * The duplicate view of each review, with stale matches demoted to
 * "not_checked". A pending-review target supports its match only while it is
 * still pending and its wording still matches under duplicateMatchText — the
 * same predicate the exact pre-check uses. A fact target supports its match only
 * while it exists and is active.
 */
export async function duplicateViews(
  reviews: Array<Pick<ReviewRow, "id" | "duplicateOutcome" | "matchingFactId" | "matchingReviewId">>,
): Promise<Map<number, DuplicateView>> {
  const factIds = [...new Set(reviews.map((r) => r.matchingFactId).filter((id): id is number => id != null))];
  const pairIds = reviews.filter((r) => r.matchingReviewId != null).map((r) => r.id);

  const [facts, pairs] = await Promise.all([
    factIds.length
      ? db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable)
          .where(and(inArray(factsTable.id, factIds), eq(factsTable.isActive, true)))
      : Promise.resolve([] as Array<{ id: number; text: string }>),
    pairIds.length
      ? db.execute(sql`
          SELECT r.id AS source_id, t.id AS target_id, t.submitted_text AS target_text,
                 (t.status = 'pending' AND ${duplicateMatchText(sql`t.submitted_text`)} = ${duplicateMatchText(sql`r.submitted_text`)}) AS supports
          FROM pending_reviews r
          JOIN pending_reviews t ON t.id = r.matching_review_id
          WHERE r.id IN (${sql.join(pairIds.map((id) => sql`${id}`), sql`, `)})
        `).then((res) => res.rows as Array<{ source_id: number; target_id: number; target_text: string; supports: boolean }>)
      : Promise.resolve([] as Array<{ source_id: number; target_id: number; target_text: string; supports: boolean }>),
  ]);
  const factMap = new Map(facts.map((f) => [f.id, f]));
  const pairMap = new Map(pairs.map((p) => [Number(p.source_id), p]));

  const views = new Map<number, DuplicateView>();
  for (const r of reviews) {
    const fact = r.matchingFactId != null ? factMap.get(r.matchingFactId) ?? null : null;
    const outcome = r.duplicateOutcome as DuplicateOutcome | null;
    if (outcome == null) {
      views.set(r.id, { state: "not_checked", fact: null, review: null });
    } else if (outcome !== "duplicate") {
      views.set(r.id, { state: outcome, fact, review: null });
    } else if (r.matchingReviewId != null) {
      const pair = pairMap.get(r.id);
      views.set(r.id, pair?.supports
        ? { state: "duplicate", fact: null, review: { id: Number(pair.target_id), text: pair.target_text } }
        : { state: "not_checked", fact: null, review: null });
    } else {
      views.set(r.id, fact
        ? { state: "duplicate", fact, review: null }
        : { state: "not_checked", fact: null, review: null });
    }
  }
  return views;
}

export async function duplicateView(review: Pick<ReviewRow, "id" | "duplicateOutcome" | "matchingFactId" | "matchingReviewId">): Promise<DuplicateView> {
  return (await duplicateViews([review])).get(review.id)!;
}
