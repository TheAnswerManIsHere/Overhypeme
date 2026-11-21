import { can, principalFromRequest } from "../lib/featureAccess";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { db } from "@workspace/db";
import {
  pendingReviewsTable, factReadingsTable, factsTable, usersTable, activityFeedTable,
  hashtagsTable, factHashtagsTable, imagePromptAttemptsTable, factGagsTable,
} from "@workspace/db/schema";
import { eq, desc, sql, and, or, ilike, count, inArray } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { embedFactAsync } from "../lib/embeddings";
import { renderCanonical } from "../lib/renderCanonical";
import { logActivity } from "../lib/activity";
import { likeContains } from "../lib/sqlLike";
import { sendEmail, buildReviewApprovedEmail, buildReviewRejectedEmail } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { notifyAdmins } from "../lib/adminNotify";
import { createFactSubmitRateLimiter, createRateLimiter, FACT_SUBMIT_PENDING_CAP, RATE_WINDOW_MS } from "../lib/rateLimit";
import { checkReviewDuplicate, duplicateView, duplicateViews, needsDuplicateCheck, type DuplicateDetector } from "../lib/duplicateVerdict";
import { normalizeFactTemplateForPendingReview } from "../lib/normalizeFactTemplateForStorage";
import {
  validateEnrichment,
  validateGagRenderInput,
  type VisualPromptStrategyOverride,
  type ReviewWorkflowStage,
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  canProvisionallyApprove,
  canApproveGags,
  canApproveReading,
  canRetryReading,
  canSendBackToGags,
  canEditApprovedNote,
  canProductionApprove,
  canReject,
  approveReadingSchema,
  REJECTION_REASON_VALUES,
  type RejectionReason,
  SUBMISSION_TEXT_MAX_CHARS,
  SUBMISSION_TEXT_MIN_CHARS,
  REFERENCE_IDENTITY_TYPES,
  renderScenarioKeySchema,
  sanitizeCandidateSceneText,
  humorNoteSaveSchema,
  isUnresolvedSubmissionStage,
  CANDIDATE_SCENE_MAX_CHARS,
} from "@workspace/api-zod";
import { sanitizeHashtagsForPersistence, resolveFinalApprovalTags } from "../lib/hashtags";
import { resolveReviewCycleEnrichment, resolveSavedCoreSceneForReview, createTriageReview } from "../lib/moderationStaging";
import { prepareFirstTimeStagingPrep, ensureFirstTimeStagingPrepJobs } from "../lib/firstTimeStagingPrep";
import {
  activateFact,
  recordFirstApproval,
  ConceptMissingError,
  ActivationConflictError,
} from "../lib/factActivation";
import { checkGoLive, describeGoLive, GoLiveError, type GoLiveCheck } from "../lib/gags/goLive";
import { publishDraft } from "../lib/gags/publish";
import { enqueueVisualConceptsForReview, buildVisualConceptsResponse } from "../lib/visualConceptJobs";
import { enqueueGagPrefill, fillState } from "../lib/gags/prefill";
import { loadGags } from "../lib/gags/resolver";
import {
  buildAndEnqueueImagePromptAttempt,
  buildRenderStatusPayload,
  type RenderControlsWithRefs,
} from "../lib/imagePromptAttempts";
import { resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput";
import { RenderStyleRefusedError } from "../lib/imagePrompt/styleResolution";
import { validateVisualStrategyOverridePersistence } from "../lib/imagePrompt/promptBudget";
import {
  getScenarioAttemptDiagnostics,
  reviewRenderStates,
  enqueueReviewIterationRenders,
  syntheticAnalysisForReference,
} from "../lib/reviewRenderScenarios";
import { resolveDefaultReferenceUrl, ReferenceAssetUnavailableError } from "../lib/defaultReferenceResolver";
import { referenceAssetHealth } from "../lib/defaultReferenceResolver";
import { logger } from "../lib/logger";
import { editTriageWording, WordingError } from "../lib/reviewWording";
import { lockFactRow, lockReviewAt, ReviewMovedError, reviewMovedBody, sendIfReviewMoved } from "../lib/reviewLocks";
import { latestReading, readingView, startReading } from "../lib/readingJobs";
import { checkDuplicateInternal } from "./ai";
import { recordAdminAction } from "../lib/adminActions";

// Re-export the plan-generator test seam (owned by the shared preview helper).
// Approval no longer runs any synchronous planner call — its renderability
// signal comes entirely from the Step-2 required-render gate — so this exists
// only to let a regression test assert the visual planner is NOT invoked on the
// approve path.

const requireFactSubmitRateLimit = createFactSubmitRateLimiter();
// Each on-demand duplicate check may spend an embedding and an AI call.
const requireDuplicateCheckRateLimit = createRateLimiter("admin-duplicate-check", 60, RATE_WINDOW_MS);

const router: IRouter = Router();

// Streams ephemeral moderation render images to admins. These objects are
// uploaded with no ACL (and are intentionally not mirrored anywhere), so the
// user-facing /storage/objects route would 403 them — admins read them here,
// authorized by requireAdmin + the attempt's reviewAudit.
const reviewRenderObjectStorage = new ObjectStorageService();

function requireAuth(req: Request, res: Response, next: () => void): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

// ─── Submit for Review ────────────────────────────────────────────────────────

// The duplicate verdict is the server's own check of the saved wording (plan
// PLAN_DUPLICATE_VERDICT.md): match fields an older tab still sends are unknown
// keys, which the schema strips rather than refuses.
const SubmitReviewBody = z.object({
  text: z.string().min(SUBMISSION_TEXT_MIN_CHARS).max(SUBMISSION_TEXT_MAX_CHARS),
  hashtags: z.array(z.string()).max(10).optional(),
  reason: z.enum(["duplicate", "spam", "offensive"]).optional(),
});

router.post("/facts/submit-review", requireAuth, requireFactSubmitRateLimit, async (req: AuthenticatedRequest, res: Response) => {
  // Bypass matrix — mirrors the tokenize-fact gate.
  // Admin and legendary members may skip captcha/onboarding; all others must have completed onboarding.
  // Membership/admin/captcha state on `req.user` is rebuilt fresh from the DB
  // on every authenticated request by authMiddleware.
  // Mirrors the tokenize-fact gate in ai.ts: the entitlement half resolves
  // through the grid, the onboarding half stays an identity prerequisite.
  const hasBypassEntitlement = await can(principalFromRequest(req), "fact_submit_captcha_bypass");
  // `captcha_verified` is no longer read (launch Phase 5, plan S23).
  const isOnboarded = !!req.user.onboardingCompleted;

  if (!hasBypassEntitlement && !isOnboarded) {
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
  const { text: rawText, hashtags: rawHashtags = [], reason } = parsed.data;
  // Run the full deterministic grammar cleanup at ingress: a submission that
  // bypassed the tokenize route (API clients, stale front-ends) may still
  // carry a {NAME}-subject pair, an unexpanded {Subj}'s contraction, or a
  // missed person-subject verb the route would have repaired.
  const normalized = normalizeFactTemplateForPendingReview(rawText);
  if (!normalized.valid) {
    res.status(422).json({
      error: `Template grammar validation failed: ${normalized.grammarResult.error}`,
    });
    return;
  }
  const text = normalized.text;
  // Normalize submitter tags at ingress so `pending_reviews.hashtags` always
  // holds clean values (the Zod schema only caps count; API clients can send
  // arbitrary strings). Same sanitizer used at approval, so storage never drifts.
  const hashtags = sanitizeHashtagsForPersistence(rawHashtags, { limit: 10 });

  // COST GATE: a new submission is cheap human-triage only. We do NOT enqueue
  // enrichment, embedding, or any other paid/external work here — those
  // start only when a moderator provisionally approves the fact (which creates
  // an inactive staging fact). So enrichment is left null and the row enters the
  // lifecycle at `triage`. (Pre-submit tokenize/duplicate-check on the
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
    review = await createTriageReview(tx, {
      submittedText: text,
      submittedById: req.user.id,
      hashtags,
      reason: reason ?? null,
    });
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
    submitterId: req.user.id,
    submitterEmail: req.user.email,
    itemText: text,
    reviewUrl: `${getSiteBaseUrl()}/admin/reviews`,
  });

  await logActivity({
    userId: req.user.id,
    actionType: "review_submitted",
    message: `You submitted a fact for admin review. You'll be notified when it's approved or declined.`,
    metadata: { reviewId: review.id, text: text.slice(0, 120) },
  });

  // The duplicate check of the saved wording, after the commit: the submitter
  // never waits on it, and it writes only while the wording is unchanged.
  // It is tracked only while it runs (a test awaits it), and leaves the set
  // when it settles.
  const submittedId = review.id;
  const check: Promise<void> = checkReviewDuplicate(submittedId, detectorFor(req))
    .then(() => undefined, (err) => { logger.error({ err, reviewId: submittedId }, "[duplicate] the post-submit check failed"); })
    .finally(() => { pendingSubmitChecks.delete(check); });
  pendingSubmitChecks.add(check);

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

  // Optional search: case-insensitive substring of the submitted wording, plus an
  // exact review-number match when the query is digits ("6891" or "#6891").
  // LIKE wildcards in the query are escaped so they match literally.
  const q = String(req.query["q"] ?? "").trim().slice(0, 200);
  const idMatch = /^#?(\d{1,9})$/.exec(q);
  const searchClause = q === ""
    ? undefined
    : or(
        ilike(pendingReviewsTable.submittedText, likeContains(q)),
        idMatch ? eq(pendingReviewsTable.id, parseInt(idMatch[1]!, 10)) : undefined,
      );
  const statusClause = status === "all" ? undefined : eq(pendingReviewsTable.status, status);
  const whereClause = and(statusClause, searchClause);

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
  // Staging facts carry the LIVE prep status (enrichment)
  // that the two-gate moderation UI shows per row — pull a lightweight slice.
  const stagingIds = [...new Set(reviews.map((r) => r.stagingFactId).filter(Boolean))] as number[];

  const [submitters, matchingFacts, stagingFacts] = await Promise.all([
    submitterIds.length
      ? db.select({ id: usersTable.id, email: usersTable.email, displayName: usersTable.displayName })
          .from(usersTable).where(and(sql`id = ANY(ARRAY[${sql.join(submitterIds.map((id) => sql`${id}`), sql`, `)}]::varchar[])`, eq(usersTable.isActive, true)))
      : Promise.resolve([]),
    matchingIds.length
      ? db.select({ id: factsTable.id, text: factsTable.text })
          .from(factsTable).where(and(sql`id = ANY(ARRAY[${sql.join(matchingIds.map((id) => sql`${id}`), sql`, `)}]::integer[])`, eq(factsTable.isActive, true)))
      : Promise.resolve([]),
    stagingIds.length
      ? db.select({ id: factsTable.id, enrichmentStatus: factsTable.enrichmentStatus, visualConceptStatus: factsTable.visualConceptStatus, isActive: factsTable.isActive })
          .from(factsTable).where(inArray(factsTable.id, stagingIds))
      : Promise.resolve([]),
  ]);

  const submitterMap = Object.fromEntries(submitters.map((u) => [u.id, u]));
  const factMap = Object.fromEntries(matchingFacts.map((f) => [f.id, f]));
  const stagingMap = Object.fromEntries(stagingFacts.map((f) => [f.id, f]));

  // Per-row coarse render state (Step 3), so the queue can show "Rendering…" /
  // "Renders ready" / "Renders need attention" and keep polling while renders run
  // — the render analogue of the enrichment prep status (rule 8). Only
  // meaningful at Test Renders, where renders exist. `rendersRunning` is kept
  // as the back-compat boolean, derived from the same aggregate.
  const productionReviewIds = reviews
    .filter((r) => r.workflowStage === "test_renders")
    .map((r) => r.id);
  // The latest reading run per staging fact, for rows at the Reading step.
  const readingFactIds = reviews.filter((r) => r.workflowStage === "reading" && r.stagingFactId != null).map((r) => r.stagingFactId!);
  const [renderStates, duplicates, readingRows] = await Promise.all([
    reviewRenderStates(productionReviewIds),
    duplicateViews(reviews),
    readingFactIds.length
      ? db.selectDistinctOn([factReadingsTable.factId], { factId: factReadingsTable.factId, status: factReadingsTable.status })
          .from(factReadingsTable)
          .where(inArray(factReadingsTable.factId, readingFactIds))
          .orderBy(factReadingsTable.factId, desc(factReadingsTable.id))
      : Promise.resolve([]),
  ]);
  const readingStatus = new Map(readingRows.map((r) => [r.factId, r.status]));

  const enriched = reviews.map((r) => {
    const renderReviewState = r.workflowStage === "test_renders"
      ? renderStates.get(r.id) ?? "not_started"
      : null;
    return {
      ...r,
      createdAt: r.createdAt.toISOString(),
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      submitter: r.submittedById ? submitterMap[r.submittedById] ?? null : null,
      matchingFact: r.matchingFactId ? factMap[r.matchingFactId] ?? null : null,
      duplicate: duplicates.get(r.id)!,
      stagingFact: r.stagingFactId ? stagingMap[r.stagingFactId] ?? null : null,
      rendersRunning: renderReviewState === "running",
      renderReviewState,
      readingStatus: r.workflowStage === "reading" && r.stagingFactId != null ? readingStatus.get(r.stagingFactId) ?? null : null,
    };
  });

  res.json({ reviews: enriched, total, page, limit });
});

// ─── Get single review (admin) ────────────────────────────────────────────────

router.get("/admin/reviews/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  const [submitter, matchingFact, stagingFact, duplicate, latestRun] = await Promise.all([
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
    // The staging fact holds the effective enrichment the moderator tunes during
    // production review, plus the live enrichment prep status.
    review.stagingFactId != null
      ? db.select({
          id: factsTable.id,
          isActive: factsTable.isActive,
          enrichment: factsTable.enrichment,
          enrichmentStatus: factsTable.enrichmentStatus,
          visualConceptStatus: factsTable.visualConceptStatus,
          visualConceptCandidates: factsTable.visualConceptCandidates,
          humorNote: factsTable.humorNote,
          humorNoteReadingId: factsTable.humorNoteReadingId,
          humorNoteApprovedBy: factsTable.humorNoteApprovedBy,
          humorNoteApprovedAt: factsTable.humorNoteApprovedAt,
        })
          .from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1)
          .then((r) => r[0] ?? null)
      : null,
    duplicateView(review),
    review.stagingFactId != null ? latestReading(review.stagingFactId) : null,
  ]);
  const reading = stagingFact ? readingView(latestRun, stagingFact) : null;

  // Slice 2A: normalized candidate Visual concepts with a SERVER-computed
  // `current` flag (stored reviewId/inputHash vs. the review's
  // live state) so the FE never recomputes hashes.
  const visualConcepts = stagingFact
    ? await buildVisualConceptsResponse({
        id: review.id,
        visualConceptStatus: stagingFact.visualConceptStatus ?? null,
        visualConceptCandidates: stagingFact.visualConceptCandidates,
        humorNote: stagingFact.humorNote,
        humorNoteApprovedBy: stagingFact.humorNoteApprovedBy,
        humorNoteApprovedAt: stagingFact.humorNoteApprovedAt,
      })
    : { status: null, candidates: [], current: false };

  res.json({
    ...review,
    createdAt: review.createdAt.toISOString(),
    reviewedAt: review.reviewedAt?.toISOString() ?? null,
    submitter,
    matchingFact: matchingFact
      ? { ...matchingFact, createdAt: matchingFact.createdAt.toISOString() }
      : null,
    duplicate,
    stagingFact,
    visualConcepts,
    reading,
  });
});

// ─── Approve Review (admin) ───────────────────────────────────────────────────

// `hashtags` carries the moderator's curated FINAL discovery-tag list. When
// present it is authoritative for the approved fact (sanitized server-side);
// when absent we fall back to the submitter's tags. Either way a fact can't be
// approved with an empty final list (see approveForProduction).
const ReviewDecisionBody = z.object({
  adminNote: z.string().max(500).optional(),
  hashtags: z.array(z.string()).max(50).optional(),
});
// rejectionReason is required: it judges whether the FACT belongs in the
// database. adminNote is optional and reaches the submitter's email.
const RejectBody = z.object({
  adminNote: z.string().max(500).optional(),
  rejectionReason: z.enum(REJECTION_REASON_VALUES),
});

/** A drizzle executor — either the root `db` or an open transaction `tx`. */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Attach hashtags to a fact, upserting into the hashtags master + join table.
 * Takes the executor so the caller can run it INSIDE the approval transaction —
 * a fact is required to have tags, so activation + tag attachment must succeed or
 * fail together (never a live, untagged fact). Routes its input through the shared
 * sanitizer so it can never drift from the canonical normalization (callers
 * already sanitize; the high cap here only re-asserts and de-dupes).
 */
async function attachHashtags(tx: DbExecutor, factId: number, tags: string[]): Promise<void> {
  for (const name of sanitizeHashtagsForPersistence(tags, { limit: 50 })) {
    let [ht] = await tx.select().from(hashtagsTable).where(eq(hashtagsTable.name, name)).limit(1);
    if (!ht) { [ht] = await tx.insert(hashtagsTable).values({ name }).returning(); }
    const [joined] = await tx.insert(factHashtagsTable).values({ factId, hashtagId: ht.id }).onConflictDoNothing().returning();
    if (joined) {
      await tx.update(hashtagsTable).set({ factCount: sql`${hashtagsTable.factCount} + 1` }).where(eq(hashtagsTable.id, ht.id));
    }
  }
}

/**
 * The final gate — activate a prepared staging fact for production.
 *
 * The staging fact exists (created at provisional approval). This handler gates
 * on the approved gags and the final hashtags, then, under the lock rule (the
 * review first, then the fact: lib/reviewLocks.ts), flips the fact active and
 * marks the review approved. The taxonomy is not a gate: a fact goes live with
 * its taxonomy absent or failed (Issue #1018, increment 1.2c-ii). Embedding and
 * the submitter's notification happen once, after commit.
 *
 * Idempotent: a re-call on an already-approved review returns the existing fact
 * without re-activating, re-embedding, or re-notifying. A review that moved
 * (another moderator rejected or approved it first) is refused with
 * REVIEW_MOVED.
 */
/** The go-live rule's refusal: what is missing, in words and per gag. */
function refuseGoLive(res: Response, check: GoLiveCheck): void {
  res.status(409).json({ error: describeGoLive(check), code: "CONCEPT_MISSING", gaps: check.gaps, gagCount: check.gagCount });
}

async function approveForProduction(
  req: AuthenticatedRequest,
  res: Response,
  opts: { reviewId: number; adminNote: string | null; hashtags?: string[] },
): Promise<void> {
  const { reviewId, adminNote } = opts;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  // Idempotency gate FIRST: already live → return the existing fact, no side effects.
  if (review.workflowStage === "approved" && review.approvedFactId != null) {
    res.json({ success: true, factId: review.approvedFactId, alreadyApproved: true });
    return;
  }
  if (!canProductionApprove(review.workflowStage as ReviewWorkflowStage, review.status)) {
    res.status(409).json(reviewMovedBody(new ReviewMovedError(review.workflowStage, review.status)));
    return;
  }
  if (review.stagingFactId == null) {
    res.status(409).json({ error: "No staging fact for this review — provisionally approve it first." });
    return;
  }

  const [stagingFact] = await db.select().from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1);
  if (!stagingFact) { res.status(409).json({ error: "Staging fact missing for this review." }); return; }

  // Legacy clients sent an enrichment blob on every approve. It is ignored.
  if ((req.body as { enrichment?: unknown } | null | undefined)?.enrichment != null) {
    logger.warn(
      { reviewId, adminUserId: req.user.id, stagingFactId: review.stagingFactId, ignoredLegacyEnrichmentBody: true },
      "[moderation] client sent legacy enrichment body on approval — ignored",
    );
  }

  // The taxonomy, when there is a valid one, is stored data: its suggested
  // hashtags are a fallback for the final list and it is kept as the review's
  // audit snapshot. Its absence or failure blocks nothing.
  const classification = validateEnrichment(stagingFact.enrichment);
  const enrichment = classification.ok ? classification.data : null;

  // The go-live rule (blocking; plan PLAN_FACT_LIFECYCLE_REBUILD.md, oracle
  // item 12) is checked only inside the approving transaction, after the
  // review's lock: publishDraft refuses a draft that fails it, and
  // activateFact checks the published set it produced. A check before the
  // lock would read a review a concurrent Reject is moving, and answer
  // "a gag is missing" where the truth is "the review moved".

  // Final discovery tags. The moderator's curated list from the approve body is
  // authoritative; absent that, fall back to the submitter's tags (else the
  // taxonomy's suggestions). Computed BEFORE any mutation so the required-hashtags
  // gate can reject cleanly: a fact is never approved with an empty tag list.
  const finalTags = resolveFinalApprovalTags(opts.hashtags, review.hashtags as unknown[] | null, enrichment?.suggestedHashtags);
  if (finalTags.length === 0) {
    res.status(400).json({
      error: "A fact can't be approved without at least one hashtag. Add a hashtag and try again.",
      code: "HASHTAGS_REQUIRED",
    });
    return;
  }

  const canonicalText = stagingFact.canonicalText ?? renderCanonical(stagingFact.text);

  // The activation stays a compare-and-set: activate ONLY while the fact is
  // still inactive AND its text is still the wording read above (belt and
  // braces: facts_text_is_locked), and approve the review ONLY while it is
  // still this Test Renders cycle, re-read under its lock.
  const validatedText = stagingFact.text;
  try {
    await db.transaction(async (tx) => {
      const locked = await lockReviewAt(tx, reviewId, canProductionApprove);
      if (!locked || locked.stagingFactId !== stagingFact.id) throw new ReviewMovedError(locked?.workflowStage ?? "gone", locked?.status ?? "gone");
      // The draft becomes the published set: locks the fact (after the review,
      // the lock rule's order) and its gags, re-checks the go-live rule on the
      // draft, and refuses with GoLiveError, changing nothing, if it fails.
      await lockFactRow(tx, stagingFact.id);
      await publishDraft(tx, stagingFact.id, req.user.id);
      // Sole activation chokepoint: checks the published set and does the
      // compare-and-set flip. Throws ConceptMissingError /
      // ActivationConflictError — never activates on failure.
      await activateFact(tx, { factId: stagingFact.id, expectedText: validatedText });
      await recordFirstApproval(tx, stagingFact.id, req.user.id);

      await tx.update(pendingReviewsTable).set({
        status: "approved",
        workflowStage: "approved",
        reviewedById: req.user.id,
        approvedFactId: stagingFact.id,
        adminNote,
        reviewedAt: new Date(),
        // AUDIT SNAPSHOT ONLY: the taxonomy as it stood at approval, when it
        // was valid. Never read back as editable state.
        enrichment,
        enrichmentStatus: stagingFact.enrichmentStatus,
      }).where(eq(pendingReviewsTable.id, reviewId));

      // The moderator-curated list resolved + gated (non-empty) above.
      await attachHashtags(tx, stagingFact.id, finalTags);
      await recordAdminAction({ factId: stagingFact.id, reviewId }, req.user.id, "approve_for_production", { hashtags: finalTags, adminNote }, tx);
    });
  } catch (err) {
    if (err instanceof ReviewMovedError) {
      logger.warn({ reviewId, factId: stagingFact.id, stage: err.stage }, "[moderation] approval refused: the review moved");
      res.status(409).json(reviewMovedBody(err));
      return;
    }
    if (err instanceof ActivationConflictError) {
      logger.warn({ reviewId, factId: stagingFact.id }, "[moderation] approval aborted: fact text changed during approval");
      res.status(409).json({ error: "The fact's text changed while you were approving it. Re-review the current wording, then approve again.", code: "FACT_TEXT_CHANGED_DURING_APPROVAL" });
      return;
    }
    if (err instanceof GoLiveError || err instanceof ConceptMissingError) {
      logger.warn({ reviewId, factId: stagingFact.id }, "[moderation] approval aborted: the go-live rule failed in the approving transaction");
      refuseGoLive(res, err instanceof GoLiveError ? err.check : await checkGoLive(stagingFact.id, "draft"));
      return;
    }
    throw err;
  }

  // Post-commit side effects, once. Embed for duplicate/related surfacing.
  void embedFactAsync(stagingFact.id, stagingFact.text, canonicalText);

  if (review.submittedById) {
    const [submitter] = await db.select({ email: usersTable.email, displayName: usersTable.displayName })
      .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1);

    await logActivity({
      userId: review.submittedById,
      actionType: "review_approved",
      message: `Your submitted fact was approved by an admin and added to the database!`,
      metadata: { reviewId, factId: stagingFact.id, adminNote },
    });

    if (submitter?.email) {
      const emailContent = buildReviewApprovedEmail({
        username: submitter.displayName ?? "there",
        submittedText: stagingFact.text,
        factId: stagingFact.id,
        adminNote,
      });
      void sendEmail({ to: submitter.email, ...emailContent });
    }
  }

  res.json({ success: true, factId: stagingFact.id, hashtags: finalTags });
}

router.post("/admin/reviews/:id/approve-for-production", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const bodyParsed = ReviewDecisionBody.safeParse(req.body);
  const adminNote = bodyParsed.success ? (bodyParsed.data.adminNote ?? null) : null;
  const hashtags = bodyParsed.success ? bodyParsed.data.hashtags : undefined;
  await approveForProduction(req, res, { reviewId: id, adminNote, hashtags });
});

// Back-compat alias: the legacy "approve" now means "approve for production" and
// can ONLY act on a fully-prepped review (Test Renders) — it can never
// shortcut a triage review straight to active.
router.post("/admin/reviews/:id/approve", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const bodyParsed = ReviewDecisionBody.safeParse(req.body);
  const adminNote = bodyParsed.success ? (bodyParsed.data.adminNote ?? null) : null;
  const hashtags = bodyParsed.success ? bodyParsed.data.hashtags : undefined;
  await approveForProduction(req, res, { reviewId: id, adminNote, hashtags });
});

// ─── Provisional approval (admin) — Triage → Reading ──────────────────────────
//
// "This fact is worth implementing." Creates the inactive staging fact, moves
// the review to Reading with its reading run (research, then a draft humor
// note), and starts the taxonomy run beside it. This is the ONLY place prep
// spend begins.

const ProvisionalApproveBody = z.object({
  adminNote: z.string().max(500).optional(),
});

router.post("/admin/reviews/:id/provisional-approve", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = ProvisionalApproveBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid input", details: bodyParsed.error.flatten() }); return; }
  const { adminNote = null } = bodyParsed.data;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  // Create the staging fact, move the review to Reading and start its reading
  // run, in one transaction under the review's lock (lib/reviewLocks.ts): a
  // triage wording edit takes the same lock, so the fact is created with the
  // wording as it stands at acceptance, and an edit racing this one either
  // lands before it or is refused (plan PLAN_THREE_GAGS.md, increment 3).
  let stagingFactId = 0;
  try {
    await db.transaction(async (tx) => {
      const locked = await lockReviewAt(tx, review.id, canProvisionallyApprove);
      if (!locked) throw new ReviewMovedError("gone", "gone");
      const { factId } = await prepareFirstTimeStagingPrep(tx, {
        review: { id: review.id, submittedText: locked.submittedText, submittedById: review.submittedById, submitterDeletedAt: review.submitterDeletedAt, stagingFactId: locked.stagingFactId },
        reviewedById: req.user.id,
        adminNote,
      });
      stagingFactId = factId;
      await recordAdminAction({ factId, reviewId: review.id }, req.user.id, "provisional_approval", { adminNote }, tx);
    });
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }

  // The taxonomy run (deduped): stored data beside moderation; it never moves
  // the review and blocks nothing.
  const prepDispatch = await ensureFirstTimeStagingPrepJobs(stagingFactId);

  logger.info({ reviewId: id, stagingFactId, adminId: req.user.id }, "[moderation] provisional approval started the reading");

  res.json({ success: true, stagingFactId, workflowStage: "reading", prepDispatch });
});

// ─── The Reading step: Try again, and Approve the humor note ──────────────────
// Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1B (Issue #1018, increment
// 1.2c-ii).

// POST /admin/reviews/:id/reading/retry — start another reading run. Offered
// while the latest run failed, or when none was ever started (a review the
// stage cutover moved into Reading). Refused while a run is in flight.
router.post("/admin/reviews/:id/reading/retry", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const outcome = await db.transaction(async (tx) => {
      const review = await lockReviewAt(tx, id, canRetryReading);
      if (!review || review.stagingFactId == null) return { kind: "not_found" as const };
      const latest = await latestReading(review.stagingFactId, tx);
      if (latest?.status === "pending") return { kind: "running" as const };
      const { readingId } = await startReading(tx, { factId: review.stagingFactId, reviewId: id, requestedBy: req.user.id });
      await recordAdminAction({ reviewId: id, factId: review.stagingFactId }, req.user.id, "reading_requested", { readingId, after: latest?.status ?? "none" }, tx);
      return { kind: "started" as const, readingId };
    });
    if (outcome.kind === "not_found") { res.status(404).json({ error: "Review not found" }); return; }
    if (outcome.kind === "running") {
      res.status(409).json({ error: "The reading is still being written. Wait for it to finish.", code: "READING_PENDING" });
      return;
    }
    res.status(202).json({ success: true, readingId: outcome.readingId });
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }
});

// POST /admin/reviews/:id/approve-reading — Reading → Gags. The moderator's
// note (the draft, edited or not) becomes the fact's approved humor note,
// recorded with the run it was written from. Ideas were written from the
// draft as soon as it existed; when the approved note differs from it, or no
// ideas exist yet, they are written again, so Gags never offers ideas written
// for another reading of the joke.
router.post("/admin/reviews/:id/approve-reading", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = approveReadingSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid humor note" }); return; }
  const { text, readingId } = parsed.data;
  try {
    const outcome = await db.transaction(async (tx) => {
      const review = await lockReviewAt(tx, id, canApproveReading);
      if (!review || review.stagingFactId == null) return { kind: "not_found" as const };
      const factId = review.stagingFactId;
      const latest = await latestReading(factId, tx);
      if (!latest || latest.status !== "ok") return { kind: "no_reading" as const };
      if (latest.id !== readingId) return { kind: "newer_reading" as const };
      await lockFactRow(tx, factId);
      const approvedAt = new Date();
      await tx.update(factsTable)
        .set({ humorNote: text, humorNoteApprovedBy: req.user.id, humorNoteApprovedAt: approvedAt, humorNoteReadingId: readingId })
        .where(eq(factsTable.id, factId));
      await tx.update(pendingReviewsTable).set({ workflowStage: "gags" }).where(eq(pendingReviewsTable.id, id));
      const edited = text !== (latest.draftNote ?? "").trim();
      await recordAdminAction({ reviewId: id, factId }, req.user.id, "reading_approval", { readingId, text, edited }, tx);
      // Ideas from the approved note when they were written from another, or
      // never written (or failed): in this commit, so Gags opens on them working.
      const [fact] = await tx
        .select({ status: factsTable.visualConceptStatus, candidates: factsTable.visualConceptCandidates })
        .from(factsTable).where(eq(factsTable.id, factId)).limit(1);
      const usedNote = ((fact?.candidates as { humorNoteUsed?: string | null } | null)?.humorNoteUsed ?? "").trim();
      const rewrite = fact?.status !== "pending" && (fact?.status !== "ok" || usedNote !== text);
      if (rewrite) await enqueueVisualConceptsForReview({ reviewId: id, factId }, tx);
      // Gag 1 from the first idea (Issue #1018, increment 1.3b): now, when the
      // ideas already stand; ideas still being written ask for it themselves.
      else await enqueueGagPrefill({ reviewId: id, factId, adminId: req.user.id }, tx);
      return { kind: "approved" as const, approvedAt, ideasRewritten: rewrite };
    });
    if (outcome.kind === "not_found") { res.status(404).json({ error: "Review not found" }); return; }
    if (outcome.kind === "no_reading") {
      res.status(409).json({ error: "There is no finished reading to approve yet.", code: "READING_NOT_READY" });
      return;
    }
    if (outcome.kind === "newer_reading") {
      res.status(409).json({ error: "A newer reading replaced the one on your screen. Reload the review and check it.", code: "READING_REPLACED" });
      return;
    }
    res.json({ success: true, workflowStage: "gags", humorNote: { text, readingId, approvedBy: req.user.id, approvedAt: outcome.approvedAt.toISOString() }, ideasRewritten: outcome.ideasRewritten });
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }
});

// ─── The wording: edited at triage ───────────────────────
// Plan docs/plans/PLAN_THREE_GAGS.md, increment 3 (lib/reviewWording.ts).

const WordingBody = z.object({ text: z.string() });

/**
 * The duplicate detector every trigger uses: after a submission, a triage
 * wording edit, and triage's on-demand check. A test sets its own on its app
 * (`app.locals.duplicateDetector`): the test runner shares one process between
 * test files, so a module-level stub would be overwritten by another file.
 */
function detectorFor(req: Request): DuplicateDetector {
  return (req.app.locals["duplicateDetector"] as DuplicateDetector | undefined) ?? checkDuplicateInternal;
}
/** Post-submit checks still running; a test awaits them. */
const pendingSubmitChecks = new Set<Promise<void>>();
export async function __settleSubmitDuplicateChecksForTest(): Promise<void> {
  // Each check removes itself when it settles; this also waits for checks that
  // start while it is waiting.
  while (pendingSubmitChecks.size) await Promise.all([...pendingSubmitChecks]);
}

function sendWordingError(res: Response, err: unknown): boolean {
  if (err instanceof WordingError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

router.post("/admin/reviews/:id/wording", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = WordingBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "The wording is required." }); return; }
  try {
    const review = await editTriageWording(id, body.data.text, req.user.id, detectorFor(req));
    await recordAdminAction({ reviewId: id, factId: review.stagingFactId }, req.user.id, "wording_edit", { text: review.submittedText, original: review.submittedTextOriginal });
    // The new wording's verdict, so the screen redraws its duplicate line.
    res.json({
      success: true,
      submittedText: review.submittedText,
      submittedTextOriginal: review.submittedTextOriginal,
      duplicate: await duplicateView(review),
    });
  } catch (err) {
    if (!sendWordingError(res, err)) throw err;
  }
});

// Triage's on-demand duplicate check (plan PLAN_DUPLICATE_VERDICT.md; David,
// Q1: a review with no usable verdict is checked the first time it is opened).
// Runs only when the review is at triage and its verdict is missing, stale or
// "unavailable"; otherwise it returns the stored verdict without spending. The
// response carries the wording the verdict belongs to, so the screen can drop
// a result a newer wording has superseded.
router.post("/admin/reviews/:id/duplicate-check", requireAdmin, requireDuplicateCheckRateLimit, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  const view = await duplicateView(review);
  if (!needsDuplicateCheck(review, view)) { res.json({ submittedText: review.submittedText, duplicate: view }); return; }
  const current = (await checkReviewDuplicate(id, detectorFor(req))) ?? review;
  await recordAdminAction({ reviewId: id, factId: current.stagingFactId }, (req as AuthenticatedRequest).user?.id, "duplicate_check", { outcome: current.duplicateOutcome ?? null });
  res.json({ submittedText: current.submittedText, duplicate: await duplicateView(current) });
});

// ─── Reject Review (admin) ────────────────────────────────────────────────────

router.post("/admin/reviews/:id/reject", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = RejectBody.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    res.status(400).json({ error: `A rejection reason is required. Must be one of: ${REJECTION_REASON_VALUES.join(", ")}.`, details: bodyParsed.error.flatten() });
    return;
  }
  const { adminNote = null, rejectionReason } = bodyParsed.data;

  // Reject from any step before the fact goes live (plan
  // PLAN_FACT_LIFECYCLE_REBUILD.md, oracle item 13), under the lock rule
  // (lib/reviewLocks.ts): the review, then its staging fact, then the gags.
  // Every other transition takes the review first too, so a Reject racing an
  // approval serialises on the review row and the second is told the review
  // moved.
  let outcome;
  try {
    outcome = await db.transaction(async (tx) => {
    const review = await lockReviewAt(tx, id, canReject);
    if (!review) return { kind: "not_found" as const };
    const atTriage = review.workflowStage === "triage";
    const now = new Date();
    await tx.update(pendingReviewsTable).set({
      status: "rejected",
      workflowStage: "rejected",
      reviewedById: req.user.id,
      adminNote,
      reason: rejectionReason,
      reviewedAt: now,
      ...(atTriage ? {} : { productionRejectedAt: now, productionRejectedById: req.user.id, productionRejectionNote: adminNote }),
    }).where(eq(pendingReviewsTable.id, id));
    let gagsDiscarded = 0;
    if (review.stagingFactId != null) {
      // The submission's gags and their renders are discarded (1D): its
      // staging fact was never approved and stays inactive, so nothing of it
      // reaches members or the Facts page. The fact row is locked before its
      // gags, the order every gag action takes (gagStore.ts), so a gag being
      // added commits first and is deleted here, and one arriving after is
      // refused because the review is no longer open. A render still running
      // stores its picture on its attempt, attached to no gag: no screen lists
      // or picks it, like the renders that finished before the rejection.
      await lockFactRow(tx, review.stagingFactId);
      await tx.update(factsTable)
        .set({ enrichmentStatus: sql`CASE WHEN ${factsTable.enrichmentStatus} = 'pending' THEN NULL ELSE ${factsTable.enrichmentStatus} END` })
        .where(eq(factsTable.id, review.stagingFactId));
      const removed = await tx.delete(factGagsTable).where(eq(factGagsTable.factId, review.stagingFactId)).returning({ id: factGagsTable.id });
      gagsDiscarded = removed.length;
    }
    await recordAdminAction({ reviewId: id, factId: review.stagingFactId }, req.user.id, "reject", { reason: rejectionReason, adminNote, stage: review.workflowStage, gagsDiscarded }, tx);
    return { kind: "rejected" as const, review };
    });
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }

  if (outcome.kind === "not_found") { res.status(404).json({ error: "Review not found" }); return; }
  const review = outcome.review;

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

// ─── Approve the gags: Gags → Test Renders ────────────────────────────────────
//
// Gates on the SAVED gag (persisted scene) + generated Visual Ideas — NOT the
// AI candidate cards or an unsaved browser draft. Each precondition returns a
// distinct code. The advance is made under the review's lock (the lock rule,
// lib/reviewLocks.ts), so two concurrent approvals, or an approval racing a
// Reject, produce exactly one transition; the other is told the review moved.
router.post("/admin/reviews/:id/approve-visual-concept", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  if (!canApproveGags(review.workflowStage as ReviewWorkflowStage, review.status)) {
    res.status(409).json(reviewMovedBody(new ReviewMovedError(review.workflowStage, review.status)));
    return;
  }
  if (review.stagingFactId == null) {
    res.status(409).json({ error: "No staging fact for this review.", code: "NO_STAGING_FACT" });
    return;
  }

  // Saved-gag gate (distinct codes: NO_STAGING_FACT / CONCEPT_MISSING): reads
  // the *persisted* gag, never the idea cards or a browser-only draft.
  const saved = await resolveSavedCoreSceneForReview(review);
  if (!saved.ok) { res.status(saved.status).json({ error: saved.error, code: saved.code }); return; }

  // Ideas-generated gate — Visual Ideas are a BLOCKING prep artifact. A pending
  // job = "still generating"; failed/never-run = "not generated".
  const [conceptFact] = await db
    .select({ visualConceptStatus: factsTable.visualConceptStatus })
    .from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1);
  const conceptStatus = conceptFact?.visualConceptStatus ?? null;
  if (conceptStatus === "pending") {
    res.status(409).json({ error: "The gag ideas are still being written. Wait for them to finish, then approve.", code: "IDEAS_PENDING" });
    return;
  }
  if (conceptStatus !== "ok") {
    res.status(409).json({ error: "The gag ideas were never written (or failed). Regenerate them before approving the gags.", code: "IDEAS_NOT_GENERATED" });
    return;
  }
  // A fill from the gag ideas still running (lib/gags/prefill.ts): approving
  // now would carry the gag it is about to replace into Test Renders (Codex
  // 4649903956, PR #1136). Read from the fill's job, so it ends when the job does.
  if ((await fillState(review.stagingFactId, review, await loadGags(review.stagingFactId))) === "filling") {
    res.status(409).json({ error: "The gags are still being filled from the gag ideas. Wait for it to finish, then approve.", code: "GAGS_FILLING" });
    return;
  }

  const stagingFactId = review.stagingFactId;
  try {
    await db.transaction(async (tx) => {
      if (!(await lockReviewAt(tx, id, canApproveGags))) throw new ReviewMovedError("gone", "gone");
      await tx.update(pendingReviewsTable).set({ workflowStage: "test_renders" }).where(eq(pendingReviewsTable.id, id));
      await recordAdminAction({ reviewId: id, factId: stagingFactId }, req.user.id, "gag_approval", {}, tx);
    });
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }

  // Post-commit — ONLY because THIS request made the transition: draw the
  // iteration render (one male render) of each new or changed gag that lacks
  // one for its content. Existing renders are kept and reused; an unchanged
  // gag gets nothing (plan PLAN_GAG_EXAMPLES.md, section C).
  let renderPrepareJobId: number | undefined;
  try {
    const enq = await enqueueReviewIterationRenders(id, req.user.id);
    renderPrepareJobId = enq.jobId;
  } catch (err) {
    logger.error({ err, reviewId: id }, "[moderation] failed to enqueue iteration renders (stage advance kept)");
  }
  logger.info({ reviewId: id, renderPrepareJobId, adminUserId: req.user.id }, "[moderation] gags approved, iteration renders enqueued");

  res.json({
    success: true,
    workflowStage: "test_renders",
    ...(renderPrepareJobId != null ? { renderPrepareJobId } : {}),
  });
});

// ─── Back to gags: Test Renders → Gags ────────────────────────────────────────
//
// Renders already drawn stay on the review: re-approval draws only gags whose
// content has no render yet, and reuses the rest (plan PLAN_GAG_EXAMPLES.md).
router.post("/admin/reviews/:id/back-to-visual-concept", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const moved = await db.transaction(async (tx) => {
      const review = await lockReviewAt(tx, id, canSendBackToGags);
      if (!review) return false;
      await tx.update(pendingReviewsTable).set({ workflowStage: "gags" }).where(eq(pendingReviewsTable.id, id));
      await recordAdminAction({ reviewId: id, factId: review.stagingFactId }, req.user.id, "back_to_gags", {}, tx);
      // Ideas written from a note changed on Test Renders replace untouched
      // pre-filled gags only on Gags (lib/gags/prefill.ts): ask now.
      if (review.stagingFactId != null) await enqueueGagPrefill({ reviewId: id, factId: review.stagingFactId, adminId: req.user.id }, tx);
      return true;
    });
    if (!moved) { res.status(404).json({ error: "Review not found" }); return; }
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }
  logger.info({ reviewId: id, adminUserId: req.user.id }, "[moderation] review sent back to Gags");
  res.json({ success: true, workflowStage: "gags" });
});

// ─── Consolidated draft autosave: note / rejection reason (admin) ─────────────
//
// One endpoint, any subset of fields. The review form autosaves through the
// universal `useFormDraft` helper and sends only the fields the admin actually
// changed. Enrichment is NOT a review-draft field: after provisional approval
// the staging fact (facts.enrichment + its baseline/override layers) is the only
// enrichment truth, edited via the fact override endpoints. A legacy client
// still sending `enrichment` is tolerated (schema accepts it, handler ignores it
// with a warn) so mid-deploy autosaves don't 400 — the field is never written.
const ReviewDraftBody = z.object({
  note: z.string().max(500).optional(),
  reason: z.enum([...REJECTION_REASON_VALUES, ""]).optional(),
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
    reason?: RejectionReason | null;
  } = {};
  if (body.data.note !== undefined) updates.adminNote = body.data.note || null;
  if (body.data.reason !== undefined) {
    updates.reason = body.data.reason || null;
  }
  // Review-blob enrichment drafts are RETIRED: after provisional approval the
  // staging fact (facts.enrichment + its baseline/override layers) is the only
  // enrichment truth, edited via the fact override endpoints. A legacy client
  // still sending `enrichment` here gets note/reason saved and the field
  // ignored — never written to pending_reviews.
  if ("enrichment" in raw) {
    logger.warn(
      { reviewId: id, ignoredLegacyEnrichmentDraft: true },
      "[moderation] client sent legacy enrichment on the review draft autosave — ignored (staging fact is authoritative)",
    );
  }

  if (Object.keys(updates).length > 0) {
    await db.update(pendingReviewsTable).set(updates).where(eq(pendingReviewsTable.id, id));
  }

  res.json({ success: true });
});

// ─── Moderation render-review tools (Test Renders) ─────────────────────────────
//
// The surface a moderator uses to vet a fact's imagery before approval:
//   POST /admin/reviews/:id/render               render the AI background (t2i)
//   GET  /admin/reviews/:id/renders/:renderJobId admin-gated poll for that render
//
// Renders go through the SAME attempt pipeline production uses, but
// are EPHEMERAL: the attempt row is kept for audit while the image is NOT mirrored
// into the fact's shared production set (renderControls.mirrorToLegacyStorage:false).

const RenderReviewBody = z.object({
  /**
   * The fixed reference photo to render from (compiler review, Phase 2: every
   * picture starts from a photo). David's by default; his wife's, the pet's or
   * the object's on request.
   */
  referenceIdentityType: z.enum(REFERENCE_IDENTITY_TYPES).optional(),
  lookStyleId: z.string().max(200).nullish(),
  renderControls: z
    .object({
      aspectRatio: z.enum(["landscape", "square", "portrait"]).optional(),
      contentMode: z.enum(["sfw", "suggestive", "spicy"]).optional(),
      negativeSpacePreference: z.enum(["top", "bottom", "left", "right", "auto", "none"]).optional(),
    })
    .strict()
    .optional(),
  identityPolicyOverrides: z.object({ preservePhysique: z.boolean() }).partial().strict().optional(),
  previewName: z.string().max(120).optional(),
  previewPronouns: z.string().max(40).optional(),
});

// POST /admin/reviews/:id/render — a moderation test render of the staging
// fact from one fixed reference photo, with an optional look, using the SAME
// assembly the prompt preview uses; returns a renderJobId the admin poll route
// tracks. Ephemeral: nothing mirrors onto the fact. The engine follows the
// look (no look: GPT Image 2.6; a look: Nano Banana 2.1).
router.post("/admin/reviews/:id/render", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = RenderReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid render controls", details: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  const referenceIdentityType = body.referenceIdentityType ?? "male";

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.workflowStage !== "test_renders") {
    res.status(409).json({ error: `Cannot render from stage ${review.workflowStage}. Approve the gags first.` });
    return;
  }
  if (review.stagingFactId == null) {
    res.status(409).json({ error: "No staging fact for this review." });
    return;
  }

  // Resolve the render input through the review-cycle resolver: the staging
  // fact's primary working gag (the taxonomy is not a render input).
  const cycle = await resolveReviewCycleEnrichment(review);
  if (!cycle) { res.status(409).json({ error: "Staging fact missing for this review." }); return; }

  const ev = validateGagRenderInput(cycle.rawRenderInput);
  if (!ev.ok) { res.status(400).json({ error: "gag_invalid", details: ev.error }); return; }

  let reference;
  try {
    reference = await resolveDefaultReferenceUrl(referenceIdentityType);
  } catch (err) {
    if (err instanceof ReferenceAssetUnavailableError) {
      res.status(409).json({ error: "reference_asset_unavailable", message: err.detail });
      return;
    }
    throw err;
  }

  // Shared deterministic assembly — identical to the prompt-preview factId path.
  const analysis = syntheticAnalysisForReference(referenceIdentityType);
  let resolved;
  try {
    resolved = await resolveRenderReviewInput(cycle.text, ev.data, {
      subjectRenderMode: analysis.suggestedRenderMode,
      sourceImageAnalysis: analysis,
      referenceImageUrl: reference.url,
      referenceIdentityType,
      lookStyleId: body.lookStyleId ?? null,
      renderControls: {
        aspectRatio: body.renderControls?.aspectRatio,
        contentMode: body.renderControls?.contentMode,
        negativeSpacePreference: body.renderControls?.negativeSpacePreference,
      },
      identityPolicyOverrides: body.identityPolicyOverrides,
      previewName: body.previewName,
      previewPronouns: body.previewPronouns,
    });
  } catch (err) {
    if (err instanceof RenderStyleRefusedError) {
      res.status(400).json({ error: err.code, message: err.message, styleId: err.styleId, reason: err.reason });
      return;
    }
    throw err;
  }

  // Only server-written internal fields reach renderControls — the client cannot
  // inject arbitrary keys (the resolver rebuilt renderControls from validated input).
  const renderControls: RenderControlsWithRefs = {
    ...resolved.renderControls,
    mirrorToLegacyStorage: false,
    reviewRenderSubject: { name: resolved.renderedSubject.name, pronouns: resolved.renderedSubject.pronouns },
    reviewAudit: { reviewId: id, adminUserId: req.user.id, ...(cycle.gagId != null ? { gagId: cycle.gagId } : {}) },
  };

  const { renderJobId, attemptId } = await buildAndEnqueueImagePromptAttempt({
    factId: review.stagingFactId,
    userId: null, // not user-owned — provenance lives in reviewAudit / requestId
    // The review's primary gag, the one the render input above carries.
    gagId: cycle.gagId,
    enrichment: ev.data,
    renderedFactText: resolved.renderedFactText,
    analysis: resolved.analysis,
    subjectRenderMode: resolved.subjectRenderMode,
    userSelectedSubjectRenderMode: resolved.userSelectedSubjectRenderMode,
    identityPolicy: resolved.identityPolicy,
    renderControls,
    requestId: `admin-review:${id}:${req.user.id}:${randomUUID()}`,
  });

  logger.info(
    { reviewId: id, stagingFactId: review.stagingFactId, adminId: req.user.id, attemptId, renderJobId, referenceIdentityType },
    "[moderation] review render enqueued",
  );
  await recordAdminAction({ reviewId: id, factId: review.stagingFactId }, req.user.id, "test_renders_requested", { attemptId, referenceIdentityType, lookStyleId: body.lookStyleId ?? null });
  res.status(202).json({ renderJobId, attemptId });
});

// GET /admin/reviews/:id/renders/:renderJobId — admin-gated poll for a review
// render. A review attempt is userId:null, so the public /memes/ai/renders route
// would expose its unpublished prompt/result to anyone holding the UUID; this
// route requires admin AND that the attempt's reviewAudit matches :id.
router.get("/admin/reviews/:id/renders/:renderJobId", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const renderJobId = String(req.params["renderJobId"] ?? "");
  if (!renderJobId) { res.status(400).json({ error: "renderJobId required" }); return; }

  const [attempt] = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(eq(imagePromptAttemptsTable.renderJobId, renderJobId))
    .limit(1);
  if (!attempt) { res.status(404).json({ error: "render_not_found" }); return; }

  const reviewAudit = (attempt.renderControls as RenderControlsWithRefs | null)?.reviewAudit;
  if (!reviewAudit || reviewAudit.reviewId !== id) {
    // Not a render belonging to this review — 404 rather than leak its existence.
    res.status(404).json({ error: "render_not_found" });
    return;
  }

  res.json(buildRenderStatusPayload(attempt));
});

// GET /admin/reviews/:id/renders/:renderJobId/image — stream the ephemeral
// render's image bytes for admins. The object has no ACL (and the user-facing
// /storage/objects route would 403 it), so we authorize via requireAdmin + the
// attempt's reviewAudit and stream it directly. Not cached/stored.
router.get("/admin/reviews/:id/renders/:renderJobId/image", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const renderJobId = String(req.params["renderJobId"] ?? "");
  if (!renderJobId) { res.status(400).json({ error: "renderJobId required" }); return; }

  const [attempt] = await db
    .select({ renderControls: imagePromptAttemptsTable.renderControls, generatedImageObjectPath: imagePromptAttemptsTable.generatedImageObjectPath })
    .from(imagePromptAttemptsTable)
    .where(eq(imagePromptAttemptsTable.renderJobId, renderJobId))
    .limit(1);
  if (!attempt) { res.status(404).json({ error: "render_not_found" }); return; }
  const reviewAudit = (attempt.renderControls as RenderControlsWithRefs | null)?.reviewAudit;
  if (!reviewAudit || reviewAudit.reviewId !== id) { res.status(404).json({ error: "render_not_found" }); return; }
  if (!attempt.generatedImageObjectPath) { res.status(404).json({ error: "image_not_ready" }); return; }

  try {
    const file = await reviewRenderObjectStorage.getObjectEntityFile(attempt.generatedImageObjectPath);
    const response = await reviewRenderObjectStorage.downloadObject(file, 0);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "cache-control") res.setHeader(key, value);
    });
    res.setHeader("Cache-Control", "private, no-store");
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "image_not_found" }); return; }
    logger.error({ err, reviewId: id, renderJobId }, "[moderation] render image stream failed");
    res.status(500).json({ error: "image_stream_failed" });
  }
});

// POST /admin/reviews/:id/visual-concepts/regenerate — re-draft the 3 candidate
// Visual concepts (Slice 2A). The body may carry the moderator's UNSAVED draft so
// the server can offer it as "here's my direction — propose DISTINCT alternatives"
// context (the server can't see local drafts otherwise). The draft is NOT
// persisted by regeneration; a blank/invalid draft → fresh ideas.
const RegenerateVisualConceptsBody = z.object({
  coreSceneDraft: z.string().max(CANDIDATE_SCENE_MAX_CHARS).nullish(),
  /** The draft's bubbles (plan PLAN_GAG_GENERATOR.md: a draft's payoff can be in its bubble). */
  bubblesDraft: z.array(z.object({ type: z.enum(["speech", "thought"]), entity: z.string().max(60), text: z.string().max(200) })).max(4).nullish(),
});

router.post("/admin/reviews/:id/visual-concepts/regenerate", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = RegenerateVisualConceptsBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() }); return; }

  const [review] = await db
    .select({
      workflowStage: pendingReviewsTable.workflowStage,
      stagingFactId: pendingReviewsTable.stagingFactId,
    })
    .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  // Regeneration is the Gags step's retry path; Visual Ideas are a Gags
  // artifact, so it only runs while the review sits at Gags.
  if (review.workflowStage !== "gags") {
    res.status(409).json({ error: `Cannot regenerate visual ideas from stage ${review.workflowStage}. Only available on the Gags step.`, code: "REVIEW_MOVED", workflowStage: review.workflowStage });
    return;
  }
  if (review.stagingFactId == null) { res.status(409).json({ error: "Review has no staging fact." }); return; }

  // Canonicalize + token-validate the draft with the SAME rules a stored
  // candidate uses. Only offer it as distinct-alt context when non-empty AND
  // valid; an invalid-token draft is silently ignored (best-effort context, not
  // a hard input) so regeneration still produces fresh ideas.
  let draft: string | null = null;
  const rawDraft = parsed.data.coreSceneDraft?.trim() ?? "";
  if (rawDraft) {
    const sanitized = sanitizeCandidateSceneText(rawDraft);
    if (sanitized.tokenValid) draft = sanitized.text;
  }
  const draftBubbles = draft
    ? (parsed.data.bubblesDraft ?? []).filter((b) => b.text.trim() && b.entity.trim()).map((b) => ({ type: b.type, entity: b.entity.trim(), text: b.text.trim() }))
    : null;

  // Under the lock rule (lib/reviewLocks.ts): the review, re-checked at Gags,
  // then the fact the claim writes.
  const stagingFactId = review.stagingFactId;
  try {
    const outcome = await db.transaction(async (tx) => {
      if (!(await lockReviewAt(tx, id, canApproveGags))) throw new ReviewMovedError("gone", "gone");
      await lockFactRow(tx, stagingFactId);
      // Refused while ideas are still being written, read under the fact's
      // lock: each request is its own generation, so two quick requests would
      // otherwise both start one (two paid runs, Fable, PR #1041 round 1).
      const [conceptFact] = await tx
        .select({ visualConceptStatus: factsTable.visualConceptStatus })
        .from(factsTable).where(eq(factsTable.id, stagingFactId)).limit(1);
      if (conceptFact?.visualConceptStatus === "pending") return "ideas_pending" as const;
      await enqueueVisualConceptsForReview({
        reviewId: id,
        factId: stagingFactId,
        moderatorDraftScene: draft,
        moderatorDraftBubbles: draftBubbles,
      }, tx);
      await recordAdminAction({ reviewId: id, factId: stagingFactId }, req.user.id, "gag_ideas_requested", { withDraft: draft != null }, tx);
      return "queued" as const;
    });
    if (outcome === "ideas_pending") {
      res.status(409).json({
        error: "The gag ideas are still being written. Wait for them to finish, then regenerate.",
        code: "IDEAS_PENDING",
      });
      return;
    }
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }
  logger.info({ reviewId: id, hasDraft: draft != null, adminId: req.user.id }, "[moderation] visual concepts regenerate");
  res.status(202).json({ success: true, visualConceptStatus: "pending" });
});

// PUT /admin/reviews/:id/humor-note — a moderator corrects the fact's approved
// humor note on the Gags or Test Renders step (it is first approved at the
// Reading step: approve-reading). Generation, the reading job and the taxonomy
// never write it. The moderator and the time are recorded. A changed note
// writes fresh ideas at once (plan item 7).
router.put("/admin/reviews/:id/humor-note", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = humorNoteSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid humor note" }); return; }

  const approvedAt = new Date();
  try {
    const saved = await db.transaction(async (tx) => {
      // The lock rule (lib/reviewLocks.ts): the review, then the fact.
      const review = await lockReviewAt(tx, id, canEditApprovedNote);
      if (!review || review.stagingFactId == null) return { kind: "not_found" as const };
      const factId = review.stagingFactId;
      await lockFactRow(tx, factId);
      const [before] = await tx.select({ humorNote: factsTable.humorNote }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
      const rows = await tx
        .update(factsTable)
        .set({ humorNote: parsed.data.text, humorNoteApprovedBy: req.user.id, humorNoteApprovedAt: approvedAt })
        .where(eq(factsTable.id, factId))
        .returning({ humorNote: factsTable.humorNote });
      if (rows.length === 0) return { kind: "not_found" as const };
      await recordAdminAction({ reviewId: id, factId }, req.user.id, "humor_note_save", { text: parsed.data.text }, tx);
      // A changed note writes fresh ideas by itself (plan item 7; Issue #1018,
      // increment 1.3b), in this commit. When they land, gags still exactly the
      // idea they were pre-filled from are replaced (lib/gags/prefill.ts). A
      // generation already running stops owning the fact and writes nothing.
      const changed = (before?.humorNote ?? "").trim() !== rows[0]!.humorNote?.trim();
      if (changed) {
        await enqueueVisualConceptsForReview({ reviewId: id, factId }, tx);
        await recordAdminAction({ reviewId: id, factId }, req.user.id, "gag_ideas_requested", { withDraft: false, noteChanged: true }, tx);
      }
      return { kind: "saved" as const, text: rows[0]!.humorNote, factId, ideasRewritten: changed };
    });
    if (saved.kind === "not_found") { res.status(404).json({ error: "Review not found" }); return; }
    logger.info({ reviewId: id, factId: saved.factId, adminId: req.user.id }, "[moderation] humor note saved");
    res.json({ humorNote: { text: saved.text, approvedBy: req.user.id, approvedAt: approvedAt.toISOString() }, ideasRewritten: saved.ideasRewritten });
  } catch (err) {
    if (!sendIfReviewMoved(err, res)) throw err;
    return;
  }
});

// GET frozen diagnostics for ONE attempt (the prompt/plan that produced THIS
// image — distinct from RuntimePromptPreview's recompute-under-current-assumptions).
router.get("/admin/reviews/:id/render-scenarios/:scenarioKey/attempts/:attemptId", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  const attemptId = parseInt(String(req.params["attemptId"] ?? ""), 10);
  if (isNaN(id) || isNaN(attemptId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const keyParsed = renderScenarioKeySchema.safeParse(req.params["scenarioKey"]);
  if (!keyParsed.success) { res.status(400).json({ error: "Invalid scenario key" }); return; }

  const diag = await getScenarioAttemptDiagnostics(keyParsed.data, attemptId, { reviewId: id });
  if (!diag) { res.status(404).json({ error: "attempt_not_found" }); return; }
  res.json(diag);
});

// GET default-reference-asset readiness (which i2i scenarios can render).
router.get("/admin/render-references/health", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ assets: await referenceAssetHealth() });
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
