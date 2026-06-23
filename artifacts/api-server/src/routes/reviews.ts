import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  pendingReviewsTable, factsTable, usersTable, activityFeedTable,
  hashtagsTable, factHashtagsTable,
} from "@workspace/db/schema";
import { eq, desc, sql, and, count, inArray } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { embedFactAsync } from "../lib/embeddings";
import { renderCanonical } from "../lib/renderCanonical";
import { logActivity } from "../lib/activity";
import { sendEmail, buildReviewApprovedEmail, buildReviewRejectedEmail } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { notifyAdmins } from "../lib/adminNotify";
import { runFactImagePipeline } from "../lib/factImagePipeline";
import { createFactSubmitRateLimiter, FACT_SUBMIT_PENDING_CAP } from "../lib/rateLimit";
import { validateTemplate } from "../lib/templateGrammar";
import { computeSplitTokenIndex } from "../lib/splitTokenIndex";
import {
  validateEnrichment,
  type FactEnrichment,
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
} from "@workspace/api-zod";
import { materializeFromBaseline } from "../lib/factEnrichment";
import { enqueueJob } from "../lib/asyncJobs";
import {
  assertFactPassesCanonicalRenderPreflight,
  type RenderPreflightResult,
} from "../lib/imagePrompt/renderPreflight";
import { logger } from "../lib/logger";

// Re-export the plan-generator test seam (owned by the shared preview helper)
// so the approval render-preflight can be stubbed in tests that import it here.
export { __setPlanGeneratorForTest } from "../lib/imagePrompt/preview";

const requireFactSubmitRateLimit = createFactSubmitRateLimiter();

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
  isDuplicate: z.boolean().optional(),
  hashtags: z.array(z.string()).max(10).optional(),
  reason: z.enum(["duplicate", "spam", "offensive"]).optional(),
});

router.post("/facts/submit-review", requireAuth, requireFactSubmitRateLimit, async (req: AuthenticatedRequest, res: Response) => {
  // Bypass matrix — mirrors the tokenize-fact gate.
  // Admin and legendary members may skip captcha/onboarding; all others must have completed onboarding.
  // Membership/admin/captcha state on `req.user` is rebuilt fresh from the DB
  // on every authenticated request by authMiddleware.
  const isAdmin = !!req.user.isRealAdmin;
  const isLegendary = req.user.membershipTier === "legendary";
  const isCaptchaVerified = !!req.user.captchaVerified;

  if (!isAdmin && !isLegendary && !isCaptchaVerified) {
    res.status(403).json({
      error: "You must complete onboarding before submitting facts.",
      code: "ONBOARDING_REQUIRED",
    });
    return;
  }

  const parsed = SubmitReviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { text, matchingFactId, matchingSimilarity = 0, isDuplicate = false, hashtags = [], reason } = parsed.data;

  const grammarResult = validateTemplate(text);
  if (!grammarResult.valid) {
    res.status(422).json({
      error: `Template grammar validation failed: ${grammarResult.error}`,
    });
    return;
  }

  // COST GATE: a new submission is cheap human-triage only. We do NOT enqueue
  // enrichment, Pexels, embedding, or any other paid/external work here — those
  // start only when a moderator provisionally approves the fact (which creates
  // an inactive staging fact). So enrichment is left null and the row enters the
  // lifecycle at `triage_pending`. (Pre-submit tokenize/duplicate-check on the
  // form are a separate, deliberate product decision and are unaffected.)
  //
  // The unresolved-pending cap + insert run in one transaction guarded by a
  // per-user advisory lock, so concurrent submits can't race past the cap.
  let review: typeof pendingReviewsTable.$inferSelect | undefined;
  let capExceeded = false;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fact_submit:${req.user.id}`}))`);
    const [{ value: unresolved }] = await tx
      .select({ value: count() })
      .from(pendingReviewsTable)
      .where(
        and(
          eq(pendingReviewsTable.submittedById, req.user.id),
          inArray(pendingReviewsTable.workflowStage, [...UNRESOLVED_SUBMISSION_STAGE_VALUES]),
        ),
      );
    if (unresolved >= FACT_SUBMIT_PENDING_CAP) {
      capExceeded = true;
      return;
    }
    [review] = await tx.insert(pendingReviewsTable).values({
      submittedText: text,
      submittedById: req.user.id,
      matchingFactId,
      matchingSimilarity,
      hashtags,
      status: "pending",
      workflowStage: "triage_pending",
      reason: reason ?? null,
      enrichment: null,
      enrichmentStatus: null,
    }).returning();
  });

  if (capExceeded || !review) {
    res.status(429).json({
      error: `You have too many submissions awaiting review (max ${FACT_SUBMIT_PENDING_CAP}). Please wait for some to be processed.`,
      code: "PENDING_CAP_REACHED",
    });
    return;
  }

  void notifyAdmins({
    type: "fact_review",
    submitterName: req.user.displayName ?? req.user.email ?? "Unknown",
    itemText: text,
    reviewUrl: `${getSiteBaseUrl()}/admin/reviews`,
  });

  const isDuplicateFlagged = !!matchingFactId && isDuplicate;
  await logActivity({
    userId: req.user.id,
    actionType: "review_submitted",
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
      ? db.select({ id: usersTable.id, email: usersTable.email, displayName: usersTable.displayName })
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
      ? db.select({ id: usersTable.id, email: usersTable.email, displayName: usersTable.displayName })
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
const RejectBody = z.object({
  adminNote: z.string().max(500).optional(),
  rejectionReason: z.enum(["duplicate", "spam", "offensive", "lame"]),
});
const ApproveVariantBody = z.object({
  parentFactId: z.number().int().positive(),
  adminNote: z.string().max(500).optional(),
});

/**
 * Resolve the enrichment to persist on approval. Prefers the admin's edited
 * `enrichment` from the request body (validated); falls back to the stored
 * pending-review enrichment.
 *
 * **Hard approval gate:** approval requires a valid enrichment. The
 * renderability check (a NON-PERSISTENT render preflight over the real
 * runtime path) runs separately in the route handler AFTER this and BEFORE any
 * state mutation — see `runApprovalRenderPreflight`.
 */
function resolveApprovalEnrichment(
  body: unknown,
  storedEnrichment: unknown,
): { ok: true; enrichment: FactEnrichment } | { ok: false; error: string } {
  const provided = (body as { enrichment?: unknown } | null | undefined)?.enrichment;
  let resolved: FactEnrichment | null = null;
  if (provided !== undefined && provided !== null) {
    const result = validateEnrichment(provided);
    if (!result.ok) return { ok: false, error: `Invalid enrichment: ${result.error}` };
    resolved = result.data;
  } else if (storedEnrichment) {
    const result = validateEnrichment(storedEnrichment);
    if (result.ok) resolved = result.data;
  }
  if (!resolved) {
    return {
      ok: false,
      error: "A valid enrichment is required before approval. Re-run classification or fill it in manually.",
    };
  }
  return { ok: true, enrichment: resolved };
}

/**
 * Run the canonical render preflight and, on failure, write the mapped HTTP
 * status + error onto `res`. Returns true when the caller should HALT (the
 * response has already been sent); false when the preflight passed and approval
 * may proceed. The preflight persists nothing, so review state is untouched on
 * every failure path.
 *
 * HTTP mapping:
 *  - unrenderable (content-specific "poor" rating) → 400 (actionable message).
 *  - preflight_failed + retryable (timeout/transient) → 503 ("retry").
 *  - preflight_failed + non-retryable (planner/compiler threw) → 422 (+ server log).
 */
async function runApprovalRenderPreflight(
  factText: string,
  enrichment: FactEnrichment,
  res: Response,
): Promise<boolean> {
  let result: RenderPreflightResult;
  try {
    result = await assertFactPassesCanonicalRenderPreflight(factText, enrichment);
  } catch (err) {
    // Defensive: the helper is designed never to throw, but if it does, treat
    // it as a non-retryable preflight failure rather than crashing approval.
    logger.error({ err }, "[reviews] render preflight threw unexpectedly");
    res.status(422).json({ error: "Render check failed — the image pipeline could not validate this fact." });
    return true;
  }
  if (result.ok) return false;
  if (result.kind === "unrenderable") {
    res.status(400).json({ error: result.message });
    return true;
  }
  if (result.retryable) {
    res.status(503).json({ error: "Render check failed; please retry approval shortly." });
    return true;
  }
  logger.error({ detail: result.detail }, "[reviews] render preflight failed (non-retryable)");
  res.status(422).json({ error: "Render check failed — the image pipeline could not validate this fact." });
  return true;
}

/** Attach hashtags to a fact, upserting into the hashtags master + join table. */
async function attachHashtags(factId: number, tags: string[]): Promise<void> {
  for (const tag of tags) {
    const name = tag.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!name) continue;
    let [ht] = await db.select().from(hashtagsTable).where(eq(hashtagsTable.name, name)).limit(1);
    if (!ht) { [ht] = await db.insert(hashtagsTable).values({ name }).returning(); }
    const [joined] = await db.insert(factHashtagsTable).values({ factId, hashtagId: ht.id }).onConflictDoNothing().returning();
    if (joined) {
      await db.update(hashtagsTable).set({ factCount: sql`${hashtagsTable.factCount} + 1` }).where(eq(hashtagsTable.id, ht.id));
    }
  }
}

router.post("/admin/reviews/:id/approve-variant", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = ApproveVariantBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "parentFactId is required" }); return; }
  const { parentFactId, adminNote = null } = bodyParsed.data;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.status !== "pending") { res.status(409).json({ error: `Review already ${review.status}` }); return; }

  // Verify the parent fact exists and is active
  const [parentFact] = await db.select({ id: factsTable.id })
    .from(factsTable)
    .where(and(eq(factsTable.id, parentFactId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!parentFact) { res.status(404).json({ error: `Fact #${parentFactId} not found or inactive` }); return; }

  const enrichmentResult = resolveApprovalEnrichment(req.body, review.enrichment);
  if (!enrichmentResult.ok) {
    res.status(400).json({ error: enrichmentResult.error });
    return;
  }
  const enrichment = enrichmentResult.enrichment;

  // Renderability gate — run the real runtime pipeline once over a neutral
  // canonical subject BEFORE any state mutation. The review is untouched on
  // every failure path (the preflight persists nothing).
  if (await runApprovalRenderPreflight(review.submittedText, enrichment, res)) return;

  // Populate the immutable AI baseline + (empty) override layers on the new fact
  // so the override system has a baseline from day one; the visual override is
  // split out of the baseline to keep enrichment_ai_derived pure.
  const enrichmentCols = enrichment ? materializeFromBaseline(enrichment).columns : {};

  const hasPronounsFlag = /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/.test(review.submittedText);
  const canonicalText = renderCanonical(review.submittedText);
  const [fact] = await db.insert(factsTable).values({
    text: review.submittedText,
    submittedById: review.submittedById ?? undefined,
    hasPronouns: hasPronounsFlag,
    canonicalText,
    isActive: true,
    parentId: parentFactId,
    splitTokenIndex: computeSplitTokenIndex(review.submittedText),
    ...enrichmentCols,
  }).returning();

  // Attach hashtags — the admin's curated enrichment tags when present,
  // otherwise the submitter's manual custom tags.
  const tags = enrichment?.suggestedHashtags ?? (review.hashtags as string[] | null) ?? [];
  await attachHashtags(fact.id, tags);

  await db.update(pendingReviewsTable).set({
    status: "approved",
    reviewedById: req.user.id,
    approvedFactId: fact.id,
    adminNote,
    reviewedAt: new Date(),
    ...(enrichment ? { enrichment, enrichmentStatus: "ok" } : {}),
  }).where(eq(pendingReviewsTable.id, id));

  void embedFactAsync(fact.id, fact.text, canonicalText);

  if (review.submittedById) {
    const [submitter] = await db.select({ email: usersTable.email, displayName: usersTable.displayName })
      .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1);

    await logActivity({
      userId: review.submittedById,
      actionType: "review_approved",
      message: `Your submitted fact was approved as a variant of fact #${parentFactId} and added to the database!`,
      metadata: { reviewId: id, factId: fact.id, parentFactId, adminNote },
    });

    if (submitter?.email) {
      const emailContent = buildReviewApprovedEmail({
        username: submitter.displayName ?? "there",
        submittedText: review.submittedText,
        factId: fact.id,
        adminNote,
      });
      void sendEmail({ to: submitter.email, ...emailContent });
    }
  }

  res.json({ success: true, factId: fact.id, parentFactId });
});

router.post("/admin/reviews/:id/approve", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = ReviewDecisionBody.safeParse(req.body);
  const adminNote = bodyParsed.success ? (bodyParsed.data.adminNote ?? null) : null;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.status !== "pending") { res.status(409).json({ error: `Review already ${review.status}` }); return; }

  const enrichmentResult = resolveApprovalEnrichment(req.body, review.enrichment);
  if (!enrichmentResult.ok) {
    res.status(400).json({ error: enrichmentResult.error });
    return;
  }
  const enrichment = enrichmentResult.enrichment;

  // Renderability gate — run the real runtime pipeline once over a neutral
  // canonical subject BEFORE any state mutation. The review is untouched on
  // every failure path (the preflight persists nothing).
  if (await runApprovalRenderPreflight(review.submittedText, enrichment, res)) return;

  // Populate the immutable AI baseline + (empty) override layers on the new fact
  // so the override system has a baseline from day one; the visual override is
  // split out of the baseline to keep enrichment_ai_derived pure.
  const enrichmentCols = enrichment ? materializeFromBaseline(enrichment).columns : {};

  // Insert the fact into the main table, detecting pronoun tokens from the template
  const hasPronounsFlag = /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/.test(review.submittedText);
  const canonicalText = renderCanonical(review.submittedText);
  const [fact] = await db.insert(factsTable).values({
    text: review.submittedText,
    submittedById: review.submittedById ?? undefined,
    hasPronouns: hasPronounsFlag,
    canonicalText,
    isActive: true,
    splitTokenIndex: computeSplitTokenIndex(review.submittedText),
    ...enrichmentCols,
  }).returning();

  // Attach hashtags — the admin's curated enrichment tags when present,
  // otherwise the submitter's manual custom tags.
  const tags = enrichment?.suggestedHashtags ?? (review.hashtags as string[] | null) ?? [];
  await attachHashtags(fact.id, tags);

  // Mark review as approved
  await db.update(pendingReviewsTable).set({
    status: "approved",
    reviewedById: req.user.id,
    approvedFactId: fact.id,
    adminNote,
    reviewedAt: new Date(),
    ...(enrichment ? { enrichment, enrichmentStatus: "ok" } : {}),
  }).where(eq(pendingReviewsTable.id, id));

  // Embed the new fact in the background using canonical text for cleaner duplicate matching
  void embedFactAsync(fact.id, fact.text, canonicalText);

  // Seed Pexels stock photos now that the fact is approved (the stock picker is
  // live for every user tier). AI meme backgrounds are NOT pre-generated here:
  // they're only reachable by Legendary users in the video surfaces and are
  // generated on demand by POST /memes/ai/:factId/generate. Admins can still
  // bulk-seed them via POST /admin/facts/backfill-ai-memes.
  void runFactImagePipeline(fact.id, fact.text);

  // Notify submitter
  if (review.submittedById) {
    const [submitter] = await db.select({ email: usersTable.email, displayName: usersTable.displayName })
      .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1);

    await logActivity({
      userId: review.submittedById,
      actionType: "review_approved",
      message: `Your submitted fact was approved by an admin and added to the database!`,
      metadata: { reviewId: id, factId: fact.id, adminNote },
    });

    if (submitter?.email) {
      const emailContent = buildReviewApprovedEmail({
        username: submitter.displayName ?? "there",
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

router.post("/admin/reviews/:id/reject", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = RejectBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid rejection reason. Must be one of: duplicate, spam, offensive, lame.", details: bodyParsed.error.flatten() });
    return;
  }
  const { adminNote = null, rejectionReason } = bodyParsed.data;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.status !== "pending") { res.status(409).json({ error: `Review already ${review.status}` }); return; }

  await db.update(pendingReviewsTable).set({
    status: "rejected",
    reviewedById: req.user.id,
    adminNote,
    reason: rejectionReason,
    reviewedAt: new Date(),
  }).where(eq(pendingReviewsTable.id, id));

  if (review.submittedById) {
    const [submitter] = await db.select({ email: usersTable.email, displayName: usersTable.displayName })
      .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1);

    await logActivity({
      userId: review.submittedById,
      actionType: "review_rejected",
      message: `Your submitted fact was reviewed and could not be added to the database.`,
      metadata: { reviewId: id, rejectionReason, adminNote },
    });

    if (submitter?.email) {
      const emailContent = buildReviewRejectedEmail({
        username: submitter.displayName ?? "there",
        submittedText: review.submittedText,
        adminNote,
        rejectionReason,
      });
      void sendEmail({ to: submitter.email, ...emailContent });
    }
  }

  res.json({ success: true });
});

// ─── Consolidated draft autosave: note / rejection reason / enrichment (admin) ─
//
// One endpoint, any subset of fields. The review form autosaves through the
// universal `useFormDraft` helper and sends only the fields the admin actually
// changed. Each field is validated independently; the enrichment blob is stored
// AS-IS — a partial or invalid draft is allowed here. Validity is enforced later
// at approval (see resolveApprovalEnrichment), not on every keystroke. This is a
// pending review (a draft), so there are no projection columns to protect, unlike
// a live fact.
const ReviewDraftBody = z.object({
  note: z.string().max(500).optional(),
  reason: z.enum(["duplicate", "spam", "offensive", "lame", ""]).optional(),
  enrichment: z.unknown().optional(),
});

router.patch("/admin/reviews/:id", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = ReviewDraftBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid draft payload" }); return; }

  const [review] = await db.select({ id: pendingReviewsTable.id }).from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  const raw = (req.body ?? {}) as Record<string, unknown>;
  const updates: {
    adminNote?: string | null;
    reason?: "duplicate" | "spam" | "offensive" | "lame" | null;
    enrichment?: FactEnrichment | null;
    enrichmentStatus?: string | null;
  } = {};
  if (body.data.note !== undefined) updates.adminNote = body.data.note || null;
  if (body.data.reason !== undefined) {
    updates.reason = (body.data.reason || null) as "duplicate" | "spam" | "offensive" | "lame" | null;
  }
  if ("enrichment" in raw) {
    const e = body.data.enrichment;
    updates.enrichment = (e ?? null) as FactEnrichment | null;
    // "ok" just means "a stored blob exists" (not pending/failed) — it is NOT a
    // validity claim; the approval gate validates the blob independently.
    updates.enrichmentStatus = e ? "ok" : null;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(pendingReviewsTable).set(updates).where(eq(pendingReviewsTable.id, id));
  }

  res.json({ success: true });
});

// ─── Enrichment: re-run classification (admin) ────────────────────────────────

router.post("/admin/reviews/:id/enrich", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [review] = await db.select({ id: pendingReviewsTable.id, submittedText: pendingReviewsTable.submittedText })
    .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  await db.update(pendingReviewsTable).set({ enrichmentStatus: "pending" }).where(eq(pendingReviewsTable.id, id));
  await enqueueJob({
    queue: "enrichment",
    payload: { reviewId: review.id },
    dedupeKey: `enrichment:${review.id}`,
  });

  res.json({ success: true, enrichmentStatus: "pending" });
});

// ─── Activity Feed ────────────────────────────────────────────────────────────

router.get("/activity-feed", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/activity-feed/mark-read", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  await db.update(activityFeedTable)
    .set({ read: true })
    .where(and(eq(activityFeedTable.userId, req.user.id), eq(activityFeedTable.read, false)));
  res.json({ success: true });
});


export default router;
