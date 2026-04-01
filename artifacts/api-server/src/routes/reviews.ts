import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  pendingReviewsTable, factsTable, usersTable, activityFeedTable,
  hashtagsTable, factHashtagsTable,
} from "@workspace/db/schema";
import { eq, desc, sql, and, count } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { embedFactAsync } from "../lib/embeddings";
import { renderCanonical } from "../lib/renderCanonical";
import { logActivity } from "../lib/activity";
import { sendEmail, buildReviewApprovedEmail, buildReviewRejectedEmail } from "../lib/email";

const router: IRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

// ─── Submit for Review ────────────────────────────────────────────────────────

const SubmitReviewBody = z.object({
  text: z.string().min(10).max(2000),
  matchingFactId: z.number().int().optional(),
  matchingSimilarity: z.number().int().min(0).max(100).optional(),
  hashtags: z.array(z.string()).max(10).optional(),
  reason: z.string().max(100).optional(),
});

router.post("/facts/submit-review", requireAuth, async (req: Request, res: Response) => {
  const parsed = SubmitReviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { text, matchingFactId, matchingSimilarity = 0, hashtags = [], reason } = parsed.data;

  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: text,
    submittedById: req.user.id,
    matchingFactId,
    matchingSimilarity,
    hashtags,
    status: "pending",
    reason: reason ?? null,
  }).returning();

  const isDuplicateFlagged = !!matchingFactId;
  await logActivity({
    userId: req.user.id,
    actionType: isDuplicateFlagged ? "review_submitted" : "fact_submitted",
    message: isDuplicateFlagged
      ? `You submitted a fact for admin review — flagged as a possible variant at ${matchingSimilarity}% similarity.`
      : `You submitted a fact for admin review. You'll be notified when it's approved or declined.`,
    metadata: { reviewId: review.id, matchingFactId, text: text.slice(0, 120) },
  });

  res.status(201).json({ success: true, reviewId: review.id });
});

// ─── Admin: count pending reviews (for badge display) ─────────────────────────
// IMPORTANT: this must be registered before /admin/reviews/:id

router.get("/admin/reviews/count", requireAdmin, async (_req: Request, res: Response) => {
  const [{ total }] = await db.select({ total: count() })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.status, "pending"));
  res.json({ total });
});

// ─── List Pending Reviews (admin) ─────────────────────────────────────────────

router.get("/admin/reviews", requireAdmin, async (req: Request, res: Response) => {
  const status = String(req.query["status"] ?? "pending") as "pending" | "approved" | "rejected" | "all";
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;

  const whereClause = status === "all" ? undefined : eq(pendingReviewsTable.status, status);

  const [reviews, [{ total }]] = await Promise.all([
    db.select().from(pendingReviewsTable)
      .where(whereClause)
      .orderBy(desc(pendingReviewsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(pendingReviewsTable).where(whereClause),
  ]);

  // Hydrate with submitter info and matching fact text
  const submitterIds = [...new Set(reviews.map((r) => r.submittedById).filter(Boolean))] as string[];
  const matchingIds = [...new Set(reviews.map((r) => r.matchingFactId).filter(Boolean))] as number[];

  const [submitters, matchingFacts] = await Promise.all([
    submitterIds.length
      ? db.select({ id: usersTable.id, username: usersTable.username, email: usersTable.email, firstName: usersTable.firstName })
          .from(usersTable).where(and(sql`id = ANY(ARRAY[${sql.join(submitterIds.map((id) => sql`${id}`), sql`, `)}]::varchar[])`, eq(usersTable.isActive, true)))
      : Promise.resolve([]),
    matchingIds.length
      ? db.select({ id: factsTable.id, text: factsTable.text })
          .from(factsTable).where(and(sql`id = ANY(ARRAY[${sql.join(matchingIds.map((id) => sql`${id}`), sql`, `)}]::integer[])`, eq(factsTable.isActive, true)))
      : Promise.resolve([]),
  ]);

  const submitterMap = Object.fromEntries(submitters.map((u) => [u.id, u]));
  const factMap = Object.fromEntries(matchingFacts.map((f) => [f.id, f]));

  const enriched = reviews.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    submitter: r.submittedById ? submitterMap[r.submittedById] ?? null : null,
    matchingFact: r.matchingFactId ? factMap[r.matchingFactId] ?? null : null,
  }));

  res.json({ reviews: enriched, total, page, limit });
});

// ─── Get single review (admin) ────────────────────────────────────────────────

router.get("/admin/reviews/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  const [submitter, matchingFact] = await Promise.all([
    review.submittedById
      ? db.select({ id: usersTable.id, username: usersTable.username, email: usersTable.email, firstName: usersTable.firstName })
          .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1)
          .then((r) => r[0] ?? null)
      : null,
    review.matchingFactId
      ? db.select({ id: factsTable.id, text: factsTable.text, score: factsTable.score, createdAt: factsTable.createdAt })
          .from(factsTable).where(and(eq(factsTable.id, review.matchingFactId), eq(factsTable.isActive, true))).limit(1)
          .then((r) => r[0] ?? null)
      : null,
  ]);

  res.json({
    ...review,
    createdAt: review.createdAt.toISOString(),
    reviewedAt: review.reviewedAt?.toISOString() ?? null,
    submitter,
    matchingFact: matchingFact
      ? { ...matchingFact, createdAt: matchingFact.createdAt.toISOString() }
      : null,
  });
});

// ─── Approve Review (admin) ───────────────────────────────────────────────────

const ReviewDecisionBody = z.object({ adminNote: z.string().max(500).optional() });

router.post("/admin/reviews/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = ReviewDecisionBody.safeParse(req.body);
  const adminNote = bodyParsed.success ? (bodyParsed.data.adminNote ?? null) : null;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.status !== "pending") { res.status(409).json({ error: `Review already ${review.status}` }); return; }

  // Insert the fact into the main table, detecting pronoun tokens from the template
  const hasPronounsFlag = /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/.test(review.submittedText);
  const canonicalText = renderCanonical(review.submittedText);
  const [fact] = await db.insert(factsTable).values({
    text: review.submittedText,
    submittedById: review.submittedById ?? undefined,
    hasPronouns: hasPronounsFlag,
    canonicalText,
    isActive: true,
  }).returning();

  // Attach hashtags
  const tags = (review.hashtags as string[] | null) ?? [];
  for (const tag of tags) {
    const name = tag.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!name) continue;
    let [ht] = await db.select().from(hashtagsTable).where(eq(hashtagsTable.name, name)).limit(1);
    if (!ht) {
      [ht] = await db.insert(hashtagsTable).values({ name }).returning();
    }
    const [joined] = await db.insert(factHashtagsTable).values({ factId: fact.id, hashtagId: ht.id }).onConflictDoNothing().returning();
    if (joined) {
      await db.update(hashtagsTable).set({ factCount: sql`${hashtagsTable.factCount} + 1` }).where(eq(hashtagsTable.id, ht.id));
    }
  }

  // Mark review as approved
  await db.update(pendingReviewsTable).set({
    status: "approved",
    reviewedById: req.user.id,
    approvedFactId: fact.id,
    adminNote,
    reviewedAt: new Date(),
  }).where(eq(pendingReviewsTable.id, id));

  // Embed the new fact in the background using canonical text for cleaner duplicate matching
  void embedFactAsync(fact.id, fact.text, canonicalText);

  // Notify submitter
  if (review.submittedById) {
    const [submitter] = await db.select({ email: usersTable.email, username: usersTable.username, firstName: usersTable.firstName })
      .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1);

    await logActivity({
      userId: review.submittedById,
      actionType: "review_approved",
      message: `Your submitted fact was approved by an admin and added to the database!`,
      metadata: { reviewId: id, factId: fact.id, adminNote },
    });

    if (submitter?.email) {
      const emailContent = buildReviewApprovedEmail({
        username: submitter.firstName ?? submitter.username ?? "there",
        submittedText: review.submittedText,
        factId: fact.id,
        adminNote,
      });
      void sendEmail({ to: submitter.email, ...emailContent });
    }
  }

  res.json({ success: true, factId: fact.id });
});

// ─── Reject Review (admin) ────────────────────────────────────────────────────

router.post("/admin/reviews/:id/reject", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = ReviewDecisionBody.safeParse(req.body);
  const adminNote = bodyParsed.success ? (bodyParsed.data.adminNote ?? null) : null;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.status !== "pending") { res.status(409).json({ error: `Review already ${review.status}` }); return; }

  await db.update(pendingReviewsTable).set({
    status: "rejected",
    reviewedById: req.user.id,
    adminNote,
    reviewedAt: new Date(),
  }).where(eq(pendingReviewsTable.id, id));

  if (review.submittedById) {
    const [submitter] = await db.select({ email: usersTable.email, username: usersTable.username, firstName: usersTable.firstName })
      .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1);

    await logActivity({
      userId: review.submittedById,
      actionType: "review_rejected",
      message: `Your submitted fact was reviewed and could not be added to the database.`,
      metadata: { reviewId: id, adminNote },
    });

    if (submitter?.email) {
      const emailContent = buildReviewRejectedEmail({
        username: submitter.firstName ?? submitter.username ?? "there",
        submittedText: review.submittedText,
        adminNote,
      });
      void sendEmail({ to: submitter.email, ...emailContent });
    }
  }

  res.json({ success: true });
});

// ─── Activity Feed ────────────────────────────────────────────────────────────

router.get("/activity-feed", requireAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;

  const [entries, [{ total }], [{ unread }]] = await Promise.all([
    db.select().from(activityFeedTable)
      .where(eq(activityFeedTable.userId, req.user.id))
      .orderBy(desc(activityFeedTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(activityFeedTable).where(eq(activityFeedTable.userId, req.user.id)),
    db.select({ unread: count() }).from(activityFeedTable)
      .where(and(eq(activityFeedTable.userId, req.user.id), eq(activityFeedTable.read, false))),
  ]);

  res.json({
    entries: entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    total,
    unread,
    page,
    limit,
  });
});

// Mark all activity entries as read
router.post("/activity-feed/mark-read", requireAuth, async (req: Request, res: Response) => {
  await db.update(activityFeedTable)
    .set({ read: true })
    .where(and(eq(activityFeedTable.userId, req.user.id), eq(activityFeedTable.read, false)));
  res.json({ success: true });
});


export default router;
