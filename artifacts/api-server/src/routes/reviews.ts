import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { db } from "@workspace/db";
import {
  pendingReviewsTable, factsTable, usersTable, activityFeedTable,
  hashtagsTable, factHashtagsTable, imagePromptAttemptsTable,
  factEnrichmentVersionsTable,
} from "@workspace/db/schema";
import { eq, desc, sql, and, count, inArray } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { embedFactAsync } from "../lib/embeddings";
import { renderCanonical } from "../lib/renderCanonical";
import { logActivity } from "../lib/activity";
import { sendEmail, buildReviewApprovedEmail, buildReviewRejectedEmail } from "../lib/email";
import { getSiteBaseUrl } from "../lib/siteUrl";
import { notifyAdmins } from "../lib/adminNotify";
import { createFactSubmitRateLimiter, FACT_SUBMIT_PENDING_CAP } from "../lib/rateLimit";
import { normalizeFactTemplateForPendingReview } from "../lib/normalizeFactTemplateForStorage";
import {
  validateEnrichment,
  type FactEnrichment,
  type ReviewWorkflowStage,
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  canProvisionallyApprove,
  canApproveVisualConcept,
  canProductionApprove,
  canReject,
  RENDER_SCENARIO_KEYS,
  renderScenarioKeySchema,
  visualRenderWaiverRequestSchema,
  type ProblematicScenarioStatus,
  type VisualRenderApprovalWaiver,
  sanitizeCandidateSceneText,
  CANDIDATE_SCENE_MAX_CHARS,
  evalWriteSchema,
  resolveEvalColumns,
  evalColumnUpdateIsEmpty,
} from "@workspace/api-zod";
import { sanitizeHashtagsForPersistence, resolveFinalApprovalTags } from "../lib/hashtags";
import { ensureStagingFact, resolveReviewCycleEnrichment, resolveSavedCoreSceneForReview } from "../lib/moderationStaging";
import {
  promoteCandidateEnrichmentVersion,
  PromoteCandidateError,
  loadCandidateEditingContext,
  CandidateEditError,
} from "../lib/enrichmentVersioning";
import {
  applyOverrideReset,
  applyOverrideUpsert,
  serializeResolved,
  stampOverrideProvenance,
  type VisualOverride,
} from "../lib/enrichmentOverrideLayers";
import { materializeEnrichment } from "../lib/factEnrichment";
import {
  isOverridablePath,
  overrideValuesEqual,
  pathToField,
  OVERRIDABLE_PATHS,
  OVERRIDABLE_PATH_KEYS,
  type OverridablePath,
} from "@workspace/api-zod";
import { enqueueJob } from "../lib/asyncJobs";
import { enqueueFactPexels } from "../lib/factPexelsJobs";
import { enqueueVisualConceptsForReview, buildVisualConceptsResponse } from "../lib/visualConceptJobs";
import {
  buildAndEnqueueImagePromptAttempt,
  buildRenderStatusPayload,
  type RenderControlsWithRefs,
} from "../lib/imagePromptAttempts";
import { resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput";
import {
  buildReviewScenarioGrid,
  runReviewScenarios,
  getScenarioAttemptDiagnostics,
  reviewRenderStates,
  enqueueForceReviewRenderPrepare,
} from "../lib/reviewRenderScenarios";
import { requiredScenarioProblems, REQUIRED_SCENARIO_POLICY_VERSION } from "../lib/factRenderScenarios";
import { referenceAssetHealth } from "../lib/defaultReferenceResolver";
import type { FactPexelsImages, PexelsPhotoEntry } from "../lib/factImagePipeline";
import { logger } from "../lib/logger";

// Re-export the plan-generator test seam (owned by the shared preview helper).
// Approval no longer runs any synchronous planner call — its renderability
// signal comes entirely from the Step-2 required-render gate — so this exists
// only to let a regression test assert the visual planner is NOT invoked on the
// approve path.
export { __setPlanGeneratorForTest } from "../lib/imagePrompt/preview";

const requireFactSubmitRateLimit = createFactSubmitRateLimiter();

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
  const { text: rawText, matchingFactId, matchingSimilarity = 0, isDuplicate = false, hashtags: rawHashtags = [], reason } = parsed.data;
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
    submitterId: req.user.id,
    submitterEmail: req.user.email,
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
  // Staging facts carry the LIVE prep status (enrichment + Pexels image prep)
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
      ? db.select({ id: factsTable.id, enrichmentStatus: factsTable.enrichmentStatus, pexelsStatus: factsTable.pexelsStatus, visualConceptStatus: factsTable.visualConceptStatus, isActive: factsTable.isActive })
          .from(factsTable).where(inArray(factsTable.id, stagingIds))
      : Promise.resolve([]),
  ]);

  const submitterMap = Object.fromEntries(submitters.map((u) => [u.id, u]));
  const factMap = Object.fromEntries(matchingFacts.map((f) => [f.id, f]));
  const stagingMap = Object.fromEntries(stagingFacts.map((f) => [f.id, f]));

  // Per-row coarse render state (Step 3), so the queue can show "Rendering…" /
  // "Renders ready" / "Renders need attention" and keep polling while renders run
  // — the render analogue of the enrichment/Pexels prep status (rule 8). Only
  // meaningful in production_review, where renders exist. `rendersRunning` is kept
  // as the back-compat boolean, derived from the same aggregate.
  const productionReviewIds = reviews
    .filter((r) => r.workflowStage === "production_review")
    .map((r) => r.id);
  const renderStates = await reviewRenderStates(productionReviewIds);

  const enriched = reviews.map((r) => {
    const renderReviewState = r.workflowStage === "production_review"
      ? renderStates.get(r.id) ?? "not_started"
      : null;
    return {
      ...r,
      createdAt: r.createdAt.toISOString(),
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      submitter: r.submittedById ? submitterMap[r.submittedById] ?? null : null,
      matchingFact: r.matchingFactId ? factMap[r.matchingFactId] ?? null : null,
      stagingFact: r.stagingFactId ? stagingMap[r.stagingFactId] ?? null : null,
      rendersRunning: renderReviewState === "running",
      renderReviewState,
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

  const [submitter, matchingFact, stagingFact] = await Promise.all([
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
    // production review, plus the live enrichment + Pexels image prep statuses.
    review.stagingFactId != null
      ? db.select({
          id: factsTable.id,
          isActive: factsTable.isActive,
          enrichment: factsTable.enrichment,
          enrichmentStatus: factsTable.enrichmentStatus,
          pexelsStatus: factsTable.pexelsStatus,
          visualConceptStatus: factsTable.visualConceptStatus,
          visualConceptCandidates: factsTable.visualConceptCandidates,
        })
          .from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1)
          .then((r) => r[0] ?? null)
      : null,
  ]);

  // Slice 2A: normalized candidate Visual concepts with a SERVER-computed
  // `current` flag (stored reviewId/candidateVersionId/inputHash vs. the review's
  // live state) so the FE never recomputes hashes.
  const visualConcepts = stagingFact
    ? await buildVisualConceptsResponse({
        id: review.id,
        candidateVersionId: review.candidateVersionId ?? null,
        visualConceptStatus: stagingFact.visualConceptStatus ?? null,
        visualConceptCandidates: stagingFact.visualConceptCandidates,
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
    stagingFact,
    visualConcepts,
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
const RejectBody = z.object({
  adminNote: z.string().max(500).optional(),
  rejectionReason: z.enum(["duplicate", "spam", "offensive", "lame"]),
});
const ApproveVariantBody = z.object({
  parentFactId: z.number().int().positive(),
  adminNote: z.string().max(500).optional(),
  hashtags: z.array(z.string()).max(50).optional(),
});

/**
 * Resolve the enrichment to ship on approval: the staging fact's stored
 * effective blob, validated. Client bodies are never consulted.
 *
 * **Hard approval gate:** approval requires a valid enrichment. Renderability is
 * gated separately by the Step-2 required-render check (`requiredScenarioProblems`
 * over the live scenario grid) in the route handler — the required test renders
 * must be fresh + successful (or explicitly waived). Approval makes NO
 * synchronous planner/compiler call of its own.
 */
function resolveApprovalEnrichment(
  storedEnrichment: unknown,
): { ok: true; enrichment: FactEnrichment } | { ok: false; error: string } {
  // The STAGING FACT's stored effective enrichment (AI baseline + tracked
  // per-field overrides + saved visual-strategy override, all materialized by
  // the override-model write paths) is the ONLY approval source. Client blobs
  // are never accepted — a whole-blob re-baseline here would wipe the override
  // map at the most dangerous moment (see the legacy-blob warn in the handler).
  if (storedEnrichment) {
    const result = validateEnrichment(storedEnrichment);
    if (result.ok) return { ok: true, enrichment: result.data };
  }
  return {
    ok: false,
    error: "A valid enrichment is required before approval. Re-run classification or fill it in manually.",
  };
}

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
 * Visual-render gate (admin-waivable), shared by first-time and refresh
 * approvals. Required Step-2 scenarios must each be a fresh successful render;
 * otherwise the moderator must explicitly waive the EXACT named problems. The
 * problem set is recomputed server-side so a stale client can't sneak an
 * approval past missing/failed/blocked/stale renders. The grid reads enrichment
 * through the review-cycle resolver, so a refresh cycle is gated on renders of
 * its CANDIDATE, a first-time cycle on the staging fact's stored blob.
 */
async function resolveVisualRenderGate(
  reviewId: number,
  body: unknown,
  adminUserId: string,
): Promise<
  | { ok: true; waiver: VisualRenderApprovalWaiver | null }
  | { ok: false; problems: ReturnType<typeof requiredScenarioProblems> }
> {
  const scenarioGrid = await buildReviewScenarioGrid(reviewId);
  const renderProblems = requiredScenarioProblems(
    scenarioGrid.cards.map((c) => ({ scenarioKey: c.key, status: c.status, stale: c.stale })),
  );
  if (renderProblems.length === 0) return { ok: true, waiver: null };
  const waiverReq = visualRenderWaiverRequestSchema.safeParse(body ?? {});
  const wantsWaive = waiverReq.success && waiverReq.data.waiveVisualRenderIssues === true;
  const named = new Set(waiverReq.success ? (waiverReq.data.waivedScenarioKeys ?? []) : []);
  const allNamed = renderProblems.every((p) => named.has(p.scenarioKey));
  if (!wantsWaive || !allNamed) return { ok: false, problems: renderProblems };
  return {
    ok: true,
    waiver: {
      waivedAt: new Date().toISOString(),
      waivedByAdminUserId: adminUserId,
      waivedScenarios: renderProblems.map((p) => ({
        scenarioKey: p.scenarioKey,
        statusAtWaiver: p.status as ProblematicScenarioStatus,
        latestAttemptId: scenarioGrid.cards.find((c) => c.key === p.scenarioKey)?.latestAttemptId ?? null,
      })),
      requiredScenarioPolicyVersion: REQUIRED_SCENARIO_POLICY_VERSION,
    },
  };
}

/**
 * Approve a REFRESH cycle (`candidateVersionId != null`): promote the candidate
 * enrichment version into `facts.*` and mark ONLY the review approved.
 *
 * Refresh approval is NOT first-time approval — the fact is already live, so
 * every first-time side effect is deliberately skipped: no `isActive` flip, no
 * submitter approval email, no "your fact was added" activity, no re-embed.
 * Hashtag policy for refresh cycles: the "must have hashtags" gate is bypassed,
 * no candidate/AI-suggested tags are attached, and existing `fact_hashtags` are
 * never removed or rewritten.
 *
 * The gate still runs, against the CANDIDATE (what promotion would publish):
 * the admin-waivable required-render gate (the scenario grid resolves a refresh
 * review to its candidate enrichment, so the required renders are validated
 * against the promoted blob). No synchronous render preflight.
 */
async function approveRefreshCandidateForProduction(
  req: AuthenticatedRequest,
  res: Response,
  opts: {
    review: typeof pendingReviewsTable.$inferSelect;
    stagingFact: typeof factsTable.$inferSelect;
    adminNote: string | null;
  },
): Promise<void> {
  const { review, stagingFact, adminNote } = opts;
  const candidateVersionId = review.candidateVersionId!;

  // Advisory pre-checks for clean errors; promoteCandidateEnrichmentVersion
  // re-verifies everything under row locks.
  const [candidate] = await db
    .select({
      id: factEnrichmentVersionsTable.id,
      factId: factEnrichmentVersionsTable.factId,
      status: factEnrichmentVersionsTable.status,
      enrichment: factEnrichmentVersionsTable.enrichment,
    })
    .from(factEnrichmentVersionsTable)
    .where(eq(factEnrichmentVersionsTable.id, candidateVersionId))
    .limit(1);
  if (!candidate || candidate.factId !== review.stagingFactId) {
    res.status(409).json({ error: "Refresh candidate missing for this review." });
    return;
  }
  if (candidate.status !== "candidate") {
    res.status(409).json({ error: `Refresh candidate is already ${candidate.status}.` });
    return;
  }
  // Advisory validity pre-check for a clean 400 (promoteCandidateEnrichmentVersion
  // re-verifies under row locks); the validated blob itself isn't needed here.
  const enrichmentResult = resolveApprovalEnrichment(candidate.enrichment);
  if (!enrichmentResult.ok) { res.status(400).json({ error: enrichmentResult.error }); return; }

  // Renderability gate over the CANDIDATE — promotion publishes it, so it (not
  // the currently-active enrichment) is what must render. The scenario grid
  // resolves a refresh review's enrichment to the candidate version, so this
  // gate's required renders are validated against exactly the blob being
  // promoted. That is the only renderability gate — no synchronous planner call.
  const gate = await resolveVisualRenderGate(review.id, req.body, req.user.id);
  if (!gate.ok) {
    res.status(409).json({ error: "visual_render_incomplete", problems: gate.problems });
    return;
  }

  try {
    // Promote + mark the review approved in ONE transaction. The review row gets
    // NO enrichment audit snapshot: for refresh cycles the candidate blob lives
    // ONLY in the version table (which is itself the audit trail).
    await db.transaction(async (tx) => {
      await promoteCandidateEnrichmentVersion(
        { reviewId: review.id, candidateVersionId, adminId: req.user.id },
        tx,
      );
      await tx.update(pendingReviewsTable).set({
        status: "approved",
        workflowStage: "production_approved",
        reviewedById: req.user.id,
        approvedFactId: stagingFact.id,
        adminNote,
        reviewedAt: new Date(),
        ...(gate.waiver ? { visualRenderApprovalWaiver: gate.waiver } : {}),
      }).where(eq(pendingReviewsTable.id, review.id));
    });
  } catch (err) {
    if (err instanceof PromoteCandidateError) {
      const status = err.code === "REFRESH_STALE_TEXT" ? 409 : err.code === "ENRICHMENT_INVALID" ? 400 : 409;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  // Admin-only audit trail; deliberately NOT submitter-facing activity.
  logger.info(
    { event: "fact_refresh_promoted", reviewId: review.id, factId: stagingFact.id, candidateVersionId, adminId: req.user.id },
    "[refresh] candidate enrichment promoted to active",
  );
  res.json({ success: true, factId: stagingFact.id, refreshPromoted: true });
}

/**
 * Second moderation gate — activate a prepared staging fact for production.
 *
 * The staging fact already exists (created at provisional approval) and already
 * carries its effective enrichment (written by the fact-backed enrichment job
 * and any moderator overrides). This handler validates that enrichment and
 * gates on the required test renders, then transactionally flips the fact active
 * and marks the review approved. Embedding + submitter notification happen once,
 * after commit.
 *
 * Idempotent: a re-call on an already-approved review returns the existing fact
 * without re-activating, re-embedding, or re-notifying. Hashtags are deferred to
 * here (curated VTE tags when present, else the submitter's) and attached
 * idempotently.
 */
async function approveForProduction(
  req: AuthenticatedRequest,
  res: Response,
  opts: { reviewId: number; adminNote: string | null; parentFactIdOverride?: number; hashtags?: string[] },
): Promise<void> {
  const { reviewId, adminNote, parentFactIdOverride } = opts;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  // Idempotency gate FIRST: already live → return the existing fact, no side effects.
  if (review.workflowStage === "production_approved" && review.approvedFactId != null) {
    res.json({ success: true, factId: review.approvedFactId, alreadyApproved: true });
    return;
  }
  if (!canProductionApprove(review.workflowStage as ReviewWorkflowStage, review.status)) {
    res.status(409).json({ error: `Cannot approve for production from stage ${review.workflowStage} (${review.status}). Provisionally approve and finish prep first.` });
    return;
  }
  if (review.stagingFactId == null) {
    res.status(409).json({ error: "No staging fact for this review — provisionally approve it first." });
    return;
  }

  const [stagingFact] = await db.select().from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1);
  if (!stagingFact) { res.status(409).json({ error: "Staging fact missing for this review." }); return; }

  // Variant-at-approval (optional): set/confirm the parent when an override is given.
  let parentId = stagingFact.parentId;
  if (parentFactIdOverride != null && parentFactIdOverride !== parentId) {
    const [parentFact] = await db.select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.id, parentFactIdOverride), eq(factsTable.isActive, true)))
      .limit(1);
    if (!parentFact) { res.status(404).json({ error: `Fact #${parentFactIdOverride} not found or inactive` }); return; }
    parentId = parentFactIdOverride;
  }

  // Legacy clients (pre-override-model bundles) sent their flattened enrichment
  // blob on every approve. It is IGNORED — accepting it would re-baseline the
  // staging fact and wipe the tracked override map. Warn (without the blob; it
  // is large and can carry admin-authored notes) so stragglers are visible.
  if ((req.body as { enrichment?: unknown } | null | undefined)?.enrichment != null) {
    logger.warn(
      { reviewId, adminUserId: req.user.id, stagingFactId: review.stagingFactId, ignoredLegacyEnrichmentBody: true },
      "[moderation] client sent legacy enrichment body on approval — ignored (staging fact is authoritative)",
    );
  }

  // REFRESH cycle (versioned enrichment): promote the candidate instead of the
  // first-time activation flow. Strictly guarded to `candidateVersionId != null`
  // so the anti-override-wipe invariant below holds for normal staging approvals.
  if (review.candidateVersionId != null) {
    await approveRefreshCandidateForProduction(req, res, { review, stagingFact, adminNote });
    return;
  }

  // The enrichment to ship is ALWAYS the staging fact's stored effective blob.
  const enrichmentResult = resolveApprovalEnrichment(stagingFact.enrichment);
  if (!enrichmentResult.ok) { res.status(400).json({ error: enrichmentResult.error }); return; }
  const enrichment = enrichmentResult.enrichment;

  // Final discovery tags. The moderator's curated list from the approve body is
  // authoritative; absent that, fall back to the submitter's tags (else AI
  // suggestions). Computed BEFORE any mutation so the required-hashtags gate can
  // reject cleanly: a fact is never approved with an empty tag list — clearing
  // them all is treated as a mistake, not a "ship zero" choice.
  const finalTags = resolveFinalApprovalTags(opts.hashtags, review.hashtags as unknown[] | null, enrichment.suggestedHashtags);
  if (finalTags.length === 0) {
    res.status(400).json({
      error: "A fact can't be approved without at least one hashtag. Add a hashtag and try again.",
      code: "HASHTAGS_REQUIRED",
    });
    return;
  }

  // Visual-render gate (admin-waivable) — the sole renderability gate on
  // approval. Staleness reads the staging fact's stored effective enrichment —
  // the same blob being published — because the override-model write paths keep
  // facts.enrichment current on every edit.
  const gate = await resolveVisualRenderGate(reviewId, req.body, req.user.id);
  if (!gate.ok) {
    res.status(409).json({ error: "visual_render_incomplete", problems: gate.problems });
    return;
  }
  const visualRenderWaiver = gate.waiver;

  // Renderability is already gated above by the Step-2 required-render check
  // (`requiredScenarioProblems`): the required test renders must be fresh +
  // successful, or explicitly waived. Those renders exercise the same
  // planner→compiler→image pipeline and actually produce images — a stronger
  // signal than a plan-only re-check — so approval makes no synchronous planner
  // call of its own and proceeds straight to the commit.

  // Approval never rewrites enrichment columns: the staging fact already holds
  // the materialized layers (AI baseline + override map + effective) written by
  // the enrichment job and the override endpoints. Re-baselining here was the
  // old override-wipe bug.
  const canonicalText = stagingFact.canonicalText ?? renderCanonical(stagingFact.text);

  // Activate the fact, mark the review approved, AND attach the final hashtags in
  // ONE transaction so a fact is never live with the review still pending (or vice
  // versa) — and, since a fact can't ship without tags, never live-but-untagged.
  await db.transaction(async (tx) => {
    await tx.update(factsTable).set({
      isActive: true,
      parentId: parentId ?? null,
    }).where(eq(factsTable.id, stagingFact.id));
    await tx.update(pendingReviewsTable).set({
      status: "approved",
      workflowStage: "production_approved",
      reviewedById: req.user.id,
      approvedFactId: stagingFact.id,
      adminNote,
      reviewedAt: new Date(),
      // AUDIT SNAPSHOT ONLY: what shipped at approval time. Runtime/render/edit
      // truth lives on facts.enrichment and its baseline/override layers — never
      // read this back as editable state.
      enrichment,
      enrichmentStatus: "ok",
      ...(visualRenderWaiver ? { visualRenderApprovalWaiver: visualRenderWaiver } : {}),
    }).where(eq(pendingReviewsTable.id, reviewId));
    // The moderator-curated list resolved + gated (non-empty) above.
    await attachHashtags(tx, stagingFact.id, finalTags);
  });

  // Post-commit side effects, once. Embed for duplicate/related surfacing.
  void embedFactAsync(stagingFact.id, stagingFact.text, canonicalText);

  if (review.submittedById) {
    const [submitter] = await db.select({ email: usersTable.email, displayName: usersTable.displayName })
      .from(usersTable).where(and(eq(usersTable.id, review.submittedById), eq(usersTable.isActive, true))).limit(1);

    await logActivity({
      userId: review.submittedById,
      actionType: "review_approved",
      message: parentId != null
        ? `Your submitted fact was approved as a variant of fact #${parentId} and added to the database!`
        : `Your submitted fact was approved by an admin and added to the database!`,
      metadata: { reviewId, factId: stagingFact.id, parentFactId: parentId, adminNote },
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

  res.json({ success: true, factId: stagingFact.id, hashtags: finalTags, ...(parentId != null ? { parentFactId: parentId } : {}) });
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
// can ONLY act on a fully-prepped review (production_review) — it can never
// shortcut a triage_pending review straight to active.
router.post("/admin/reviews/:id/approve", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const bodyParsed = ReviewDecisionBody.safeParse(req.body);
  const adminNote = bodyParsed.success ? (bodyParsed.data.adminNote ?? null) : null;
  const hashtags = bodyParsed.success ? bodyParsed.data.hashtags : undefined;
  await approveForProduction(req, res, { reviewId: id, adminNote, hashtags });
});

// Back-compat: variant approval. The variant link is normally chosen at
// provisional approval; a parentFactId here re-confirms / sets it at activation.
router.post("/admin/reviews/:id/approve-variant", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const bodyParsed = ApproveVariantBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "parentFactId is required" }); return; }
  await approveForProduction(req, res, { reviewId: id, adminNote: bodyParsed.data.adminNote ?? null, parentFactIdOverride: bodyParsed.data.parentFactId, hashtags: bodyParsed.data.hashtags });
});

// ─── Provisional approval (admin) — first gate ────────────────────────────────
//
// "This fact is worth implementing." Creates the inactive staging fact and
// starts paid prep (enrichment now; Pexels once the durable queue lands). This
// is the ONLY place enrichment spend begins. Optional `parentFactId` accepts the
// candidate as a variant — the variant still gets its OWN enrichment + images.

const ProvisionalApproveBody = z.object({
  parentFactId: z.number().int().positive().optional(),
  adminNote: z.string().max(500).optional(),
});

router.post("/admin/reviews/:id/provisional-approve", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = ProvisionalApproveBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid input", details: bodyParsed.error.flatten() }); return; }
  const { parentFactId, adminNote = null } = bodyParsed.data;

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id));
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  // Idempotent re-click while prep is already running: return the existing
  // staging fact without creating a second fact or re-enqueuing.
  if (review.workflowStage === "prep_pending" && review.stagingFactId != null) {
    res.json({ success: true, stagingFactId: review.stagingFactId, workflowStage: "prep_pending", alreadyPrepping: true });
    return;
  }

  if (!canProvisionallyApprove(review.workflowStage as ReviewWorkflowStage, review.status)) {
    res.status(409).json({ error: `Cannot provisionally approve a review in stage ${review.workflowStage} (${review.status}).` });
    return;
  }

  // Block re-prep from Step 2 while a concept job is still in-flight: a new prep
  // cycle would enqueue a fresh fact_visual_concepts job that COALESCES onto the
  // pending one (review-scoped dedupe), so the gag gate could later complete on
  // stale candidates. Make the moderator wait for the current run to land first.
  if (review.workflowStage === "concept_review" && review.stagingFactId != null) {
    const [conceptFact] = await db
      .select({ visualConceptStatus: factsTable.visualConceptStatus })
      .from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1);
    if (conceptFact?.visualConceptStatus === "pending") {
      res.status(409).json({
        error: "Visual ideas are still generating. Wait for them to finish, then retry, edit, reject, or send back to prep.",
        code: "IDEAS_PENDING",
      });
      return;
    }
  }

  // Verify the parent fact (variant case) exists and is active.
  if (parentFactId != null) {
    const [parentFact] = await db.select({ id: factsTable.id })
      .from(factsTable)
      .where(and(eq(factsTable.id, parentFactId), eq(factsTable.isActive, true)))
      .limit(1);
    if (!parentFact) { res.status(404).json({ error: `Fact #${parentFactId} not found or inactive` }); return; }
  }

  // Create-or-reuse the staging fact and move the review into prep, in one
  // transaction. If enqueue (below) fails the staging fact + prep_pending state
  // remain, so a later re-click recovers without creating a duplicate fact.
  let stagingFactId = 0;
  await db.transaction(async (tx) => {
    const { factId } = await ensureStagingFact(
      { id: review.id, submittedText: review.submittedText, submittedById: review.submittedById, stagingFactId: review.stagingFactId },
      parentFactId ?? null,
      tx,
    );
    stagingFactId = factId;
    // Mark enrichment prep "pending" up front so the moderation UI shows it
    // "working" immediately (symmetric with pexels_status, set by enqueueFactPexels).
    // A re-run from prep_failed / production_review also resets it here.
    await tx.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, factId));
    await tx.update(pendingReviewsTable).set({
      workflowStage: "prep_pending",
      stagingFactId: factId,
      reviewedById: req.user.id,
      ...(adminNote != null ? { adminNote } : {}),
    }).where(eq(pendingReviewsTable.id, id));
  });

  // Start fact-backed prep on the staging fact. Both queues are deduped so a
  // re-click can't double-enqueue. Enrichment is the gate that advances the
  // review to production_review; Pexels image prep runs alongside as tracked
  // best-effort seeding (its status shows per-fact but never blocks the gate).
  await enqueueJob({
    queue: "enrichment",
    payload: { factId: stagingFactId },
    dedupeKey: `enrichment:fact:${stagingFactId}`,
  });
  await enqueueFactPexels(stagingFactId);

  logger.info({ reviewId: id, stagingFactId, parentFactId, adminId: req.user.id }, "[moderation] provisional approval started prep");

  res.json({ success: true, stagingFactId, workflowStage: "prep_pending" });
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

  // REFRESH cycle: "don't promote this refresh," NOT "unpublish the fact." The
  // candidate is RETAINED as rejected history (never hard-deleted, and it no
  // longer blocks a future send-back — the one-candidate index covers
  // status='candidate' only). The live fact's enrichment, projections, Pexels,
  // memes, and isActive are all left exactly as they were.
  const isRefreshCycle = review.candidateVersionId != null;

  // A first-time submission can only be rejected during triage (Step 1). Once
  // it clears triage, a stuck candidate (failed prep, a render that isn't
  // working, a Visual Concept that needs work) stays pending until an admin
  // resolves the underlying issue — never rejected again.
  if (!canReject(review.workflowStage as ReviewWorkflowStage, review.status, isRefreshCycle)) {
    res.status(409).json({
      error: `Cannot reject from stage ${review.workflowStage} — once triage passes, a stuck candidate stays pending until an admin resolves it.`,
    });
    return;
  }

  // Rejecting a refresh candidate is always audited as a production rejection
  // (its staging fact is left inactive so it never reaches users, and any
  // in-flight prep job becomes a no-op via the stale-job guard); a first-time
  // triage reject is a plain triage rejection.
  const targetStage: ReviewWorkflowStage = isRefreshCycle ? "production_rejected" : "triage_rejected";

  await db.transaction(async (tx) => {
    await tx.update(pendingReviewsTable).set({
      status: "rejected",
      workflowStage: targetStage,
      reviewedById: req.user.id,
      adminNote,
      reason: rejectionReason,
      reviewedAt: new Date(),
      ...(isRefreshCycle
        ? { productionRejectedAt: new Date(), productionRejectedById: req.user.id, productionRejectionNote: adminNote }
        : {}),
    }).where(eq(pendingReviewsTable.id, id));
    if (isRefreshCycle) {
      await tx.update(factEnrichmentVersionsTable)
        .set({ status: "rejected", rejectedAt: new Date() })
        .where(and(
          eq(factEnrichmentVersionsTable.id, review.candidateVersionId!),
          eq(factEnrichmentVersionsTable.status, "candidate"),
        ));
      if (review.stagingFactId != null) {
        // Clear the "prep running" pill; the active enrichment itself was never touched.
        await tx.update(factsTable).set({ enrichmentStatus: "ok" }).where(eq(factsTable.id, review.stagingFactId));
      }
    }
  });

  // Submitter notifications are for first-time submissions only: a refresh
  // rejection must never tell the original submitter their live fact "could not
  // be added" (refresh reviews carry submittedById=null; guarded here too).
  if (review.submittedById && !isRefreshCycle) {
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

// ─── Approve the visual gag: Step 2 (concept_review) → Step 3 (production_review) ─
//
// Gates on the SAVED enrichment (persisted coreSceneOverride) + generated Visual
// Ideas — NOT the AI candidate cards or an unsaved browser draft. Each
// precondition returns a distinct code. Advances via an atomic compare-and-set so
// two concurrent approvals produce exactly ONE force render batch; the loser 409s.
router.post("/admin/reviews/:id/approve-visual-concept", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  if (!canApproveVisualConcept(review.workflowStage as ReviewWorkflowStage, review.status)) {
    res.status(409).json({
      error: `Cannot approve the visual gag from stage ${review.workflowStage} (${review.status}).`,
      code: "CONCEPT_STAGE_ALREADY_ADVANCED",
    });
    return;
  }
  if (review.stagingFactId == null) {
    res.status(409).json({ error: "No staging fact for this review.", code: "NO_STAGING_FACT" });
    return;
  }

  // Saved-concept gate (distinct codes: ENRICHMENT_INVALID / CONCEPT_DISABLED /
  // CONCEPT_MISSING). Stale-but-saved is allowed — this reads the *persisted*
  // enrichment, not the AI candidate cards or a browser-only draft.
  const saved = await resolveSavedCoreSceneForReview(review);
  if (!saved.ok) { res.status(saved.status).json({ error: saved.error, code: saved.code }); return; }

  // Ideas-generated gate — Visual Ideas are a BLOCKING prep artifact. A pending
  // job = "still generating"; failed/never-run = "not generated".
  const [conceptFact] = await db
    .select({ visualConceptStatus: factsTable.visualConceptStatus })
    .from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1);
  const conceptStatus = conceptFact?.visualConceptStatus ?? null;
  if (conceptStatus === "pending") {
    res.status(409).json({ error: "Visual ideas are still generating. Wait for them to finish, then approve.", code: "IDEAS_PENDING" });
    return;
  }
  if (conceptStatus !== "ok") {
    res.status(409).json({ error: "Visual ideas were never generated (or failed). Regenerate them before approving the gag.", code: "IDEAS_NOT_GENERATED" });
    return;
  }

  // Atomic compare-and-set: advance ONLY if still pending @ concept_review. A
  // single UPDATE…RETURNING is its own guard — a concurrent approval that already
  // moved the row leaves this WHERE unmatched, so it returns no row → 409. This,
  // not the async queue, is the double-click / concurrency guard because the force
  // render enqueue below carries no dedupe key.
  const advancedRows = await db.update(pendingReviewsTable)
    .set({ workflowStage: "production_review" })
    .where(and(
      eq(pendingReviewsTable.id, id),
      eq(pendingReviewsTable.status, "pending"),
      eq(pendingReviewsTable.workflowStage, "concept_review"),
    ))
    .returning({ id: pendingReviewsTable.id });
  if (advancedRows.length === 0) {
    res.status(409).json({
      error: "This review already advanced past the Visual Concept step.",
      code: "CONCEPT_STAGE_ALREADY_ADVANCED",
    });
    return;
  }

  // Post-commit — ONLY because THIS request performed the CAS: clear the prior
  // Step-3 scenario set, then force a fresh render batch (no dedupe key, so it
  // can't coalesce onto a stale prepare job). Clearing before enqueue means a
  // Step-3 → Step-2 → Step-3 bounce shows the new queued/missing state rather
  // than the superseded stale thumbnails while the async prepare job spins up.
  const clearedRenderAttempts = await db.update(imagePromptAttemptsTable)
    .set({ reviewId: null, updatedAt: new Date() })
    .where(eq(imagePromptAttemptsTable.reviewId, id))
    .returning({ id: imagePromptAttemptsTable.id });

  let renderPrepareJobId: number | undefined;
  try {
    const enq = await enqueueForceReviewRenderPrepare(id);
    renderPrepareJobId = enq.jobId;
  } catch (err) {
    logger.error({ err, reviewId: id }, "[moderation] failed to enqueue force render prepare (stage advance kept)");
  }
  logger.info(
    { reviewId: id, renderPrepareJobId, clearedRenderAttempts: clearedRenderAttempts.length, force: true, adminUserId: req.user.id },
    "[moderation] visual concept approved, prior renders cleared, force render prepare enqueued",
  );

  res.json({
    success: true,
    workflowStage: "production_review",
    ...(renderPrepareJobId != null ? { renderPrepareJobId } : {}),
    clearedRenderAttempts: clearedRenderAttempts.length,
    forceRenderBatch: true,
  });
});

// ─── Back to Visual Concept: Step 3 (production_review) → Step 2 (concept_review) ─
//
// Re-approval clears any prior Step-3 scenario attempts before force-creating a
// fresh batch, so in-flight jobs can finish without remaining the active grid.
router.post("/admin/reviews/:id/back-to-visual-concept", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [review] = await db
    .select({ workflowStage: pendingReviewsTable.workflowStage, status: pendingReviewsTable.status })
    .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (!(review.status === "pending" && review.workflowStage === "production_review")) {
    res.status(409).json({ error: `Cannot send back to Visual Concept from stage ${review.workflowStage} (${review.status}).` });
    return;
  }

  const rows = await db.update(pendingReviewsTable)
    .set({ workflowStage: "concept_review" })
    .where(and(
      eq(pendingReviewsTable.id, id),
      eq(pendingReviewsTable.status, "pending"),
      eq(pendingReviewsTable.workflowStage, "production_review"),
    ))
    .returning({ id: pendingReviewsTable.id });
  if (rows.length === 0) {
    res.status(409).json({ error: "This review is no longer at Test Renders." });
    return;
  }
  logger.info({ reviewId: id, adminUserId: req.user.id }, "[moderation] review sent back to Visual Concept (Step 2)");
  res.json({ success: true, workflowStage: "concept_review" });
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
  } = {};
  if (body.data.note !== undefined) updates.adminNote = body.data.note || null;
  if (body.data.reason !== undefined) {
    updates.reason = (body.data.reason || null) as "duplicate" | "spam" | "offensive" | "lame" | null;
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

// ─── Staging-enrichment whole-blob save: RETIRED ──────────────────────────────
//
// This endpoint used to accept the moderator's whole edited blob and
// materialize it as a FRESH AI baseline (`materializeFromBaseline` → override
// map wiped) — the override-history wipe the lockstep model eliminates. The
// moderation modal now edits the staging fact through the SAME machinery as the
// Edit Fact screen: tracked fields via PUT/DELETE
// `/admin/facts/:stagingFactId/enrichment-overrides` (instant, per-field,
// audited), untracked fields (visual-strategy override) via
// `PATCH /admin/facts/:stagingFactId/enrichment` (tracked-field-guarded,
// baseline-preserving). Kept registered (in this position, ahead of broader
// review routes) for at least one release so stale clients fail with a clear
// code instead of a 404.
router.patch("/admin/reviews/:id/staging-enrichment", requireAdmin, (_req: Request, res: Response) => {
  res.status(410).json({
    error:
      "Whole-blob staging enrichment saves are retired. The moderation editor persists edits through the fact override endpoints (/admin/facts/:stagingFactId/enrichment-overrides and /enrichment) automatically — reload the admin app.",
    code: "STAGING_ENRICHMENT_RETIRED",
  });
});

// ─── Enrichment: retired ──────────────────────────────────────────────────────
//
// Review-blob enrichment is retired. Production prep is fact-backed: enrichment
// runs against the staging fact (created at provisional approval) and is re-run
// via the fact enrichment endpoint (`/admin/facts/:id/enrich`) bound to
// `review.stagingFactId`. This endpoint returns 410 so nothing re-introduces a
// second, review-keyed source of enrichment truth.

router.post("/admin/reviews/:id/enrich", requireAdmin, (_req: Request, res: Response) => {
  res.status(410).json({
    error: "Review-blob enrichment is retired. Provisionally approve the review and re-run enrichment on its staging fact.",
    code: "REVIEW_ENRICH_RETIRED",
  });
});

// ─── Refresh-candidate enrichment editing (production_review) ────────────────
//
// During a REFRESH cycle the Step-2 modal edits the CANDIDATE version row —
// never the live fact, whose enrichment writes are frozen (REFRESH_IN_REVIEW)
// while the cycle is open. These four routes mirror the fact endpoints
// (/admin/facts/:id/enrichment-resolved, /enrichment-overrides, /enrichment)
// through the SHARED merge core in lib/enrichmentOverrideLayers.ts, but
// persist only the version row's four layer columns. Deliberate differences:
//  - NO enrichment_override_history rows (per-version audit is a deferred
//    enhancement; the version row + promote-time snapshot are the audit);
//  - NO re-run-classification (the candidate job requires prep_pending;
//    reject + re-send covers it);
//  - suggestedHashtags are PINNED server-side on PATCH (refresh moderation
//    edits tracked overrides + the visual concept only — discovery tags are
//    out of refresh scope).

/** Map a CandidateEditError to its HTTP response. */
function sendCandidateEditError(res: Response, err: CandidateEditError): void {
  res.status(err.code === "REVIEW_NOT_FOUND" ? 404 : 409).json({ error: err.message, code: err.code });
}

/** Persist a re-materialized candidate: the four layer columns, nothing else.
 * `visual_override` stays canonical with `enrichment.visualPromptStrategyOverride`
 * by construction (both come from the same materializeEnrichment output). */
type ReviewsDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function persistCandidateLayers(
  tx: ReviewsDbTx,
  candidateVersionId: number,
  columns: ReturnType<typeof materializeEnrichment>["columns"],
): Promise<void> {
  await tx
    .update(factEnrichmentVersionsTable)
    .set({
      enrichment: columns.enrichment,
      enrichmentAiDerived: columns.enrichmentAiDerived,
      enrichmentOverrides: columns.enrichmentOverrides,
      visualOverride: (columns.enrichment as { visualPromptStrategyOverride?: VisualOverride })
        .visualPromptStrategyOverride ?? null,
    })
    .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
}

// GET /admin/reviews/:id/candidate-enrichment-resolved — the candidate's
// layers in the exact shape of the fact resolved GET (plus identifiers), so
// the shared editor consumes either interchangeably.
router.get("/admin/reviews/:id/candidate-enrichment-resolved", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const ctx = await loadCandidateEditingContext(id, db, { forUpdate: false, intent: "read" });
    res.json({
      ...serializeResolved(ctx.layers),
      factId: ctx.review.stagingFactId,
      candidateVersionId: ctx.review.candidateVersionId,
    });
  } catch (err) {
    if (err instanceof CandidateEditError) { sendCandidateEditError(res, err); return; }
    throw err;
  }
});

// PUT /admin/reviews/:id/candidate-overrides — create/update/reset one tracked
// override ON THE CANDIDATE. Same body + response contract as the fact PUT.
router.put("/admin/reviews/:id/candidate-overrides", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = (req.body ?? {}) as { path?: unknown; value?: unknown; reason?: unknown; acknowledgeCurrentAiBaseline?: unknown };
  const path = String(body.path ?? "");
  if (!isOverridablePath(path)) { res.status(400).json({ error: `Path "${path}" is not an overridable field` }); return; }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
  const acknowledge = body.acknowledgeCurrentAiBaseline === true;
  const adminId = req.user.id;

  try {
    const out = await db.transaction(async (tx): Promise<{ status: number; body: object }> => {
      const ctx = await loadCandidateEditingContext(id, tx, { forUpdate: true, intent: "write" });
      const aiDerived = ctx.layers.aiDerived!; // write intent guarantees a classified candidate
      const result = applyOverrideUpsert({
        layers: { ...ctx.layers, aiDerived },
        path,
        value: body.value,
        ...(reason !== undefined ? { reason } : {}),
        acknowledge,
        adminId,
      });
      if (!result.ok) return { status: result.status, body: { error: result.error } };
      const { columns } = materializeEnrichment({
        aiDerived,
        overrides: result.overrides,
        visualPromptStrategyOverride: ctx.layers.visualPromptStrategyOverride,
      });
      await persistCandidateLayers(tx, ctx.review.candidateVersionId, columns);
      return {
        status: 200,
        body: { success: true, ...serializeResolved({ ...ctx.layers, aiDerived, overrides: result.overrides }) },
      };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    if (err instanceof CandidateEditError) { sendCandidateEditError(res, err); return; }
    logger.error({ err, reviewId: id, path }, "[PUT /admin/reviews/:id/candidate-overrides] failed");
    res.status(500).json({ error: "Failed to save candidate override" });
  }
});

// DELETE /admin/reviews/:id/candidate-overrides[?path=…] — reset one candidate
// override (or ALL when no path is given) back to the candidate's AI baseline.
router.delete("/admin/reviews/:id/candidate-overrides", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rawPath = req.query["path"];
  const path = rawPath !== undefined ? String(rawPath) : null;
  if (path !== null && !isOverridablePath(path)) { res.status(400).json({ error: `Path "${path}" is not an overridable field` }); return; }

  try {
    const out = await db.transaction(async (tx): Promise<{ status: number; body: object }> => {
      const ctx = await loadCandidateEditingContext(id, tx, { forUpdate: true, intent: "write" });
      const aiDerived = ctx.layers.aiDerived!;
      const result = applyOverrideReset({ layers: { ...ctx.layers, aiDerived }, path: path as OverridablePath | null });
      const { columns } = materializeEnrichment({
        aiDerived,
        overrides: result.overrides,
        visualPromptStrategyOverride: ctx.layers.visualPromptStrategyOverride,
      });
      await persistCandidateLayers(tx, ctx.review.candidateVersionId, columns);
      return {
        status: 200,
        body: { success: true, ...serializeResolved({ ...ctx.layers, aiDerived, overrides: result.overrides }) },
      };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    if (err instanceof CandidateEditError) { sendCandidateEditError(res, err); return; }
    logger.error({ err, reviewId: id, path }, "[DELETE /admin/reviews/:id/candidate-overrides] failed");
    res.status(500).json({ error: "Failed to reset candidate override" });
  }
});

// PATCH /admin/reviews/:id/candidate-enrichment — persist the moderator
// visual-strategy override ON THE CANDIDATE. Tracked fields are rejected (400,
// same as the fact PATCH) and suggestedHashtags are pinned to the candidate's
// persisted baseline regardless of the body.
router.patch("/admin/reviews/:id/candidate-enrichment", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = validateEnrichment((req.body as { enrichment?: unknown } | null | undefined)?.enrichment);
  if (!parsed.ok) { res.status(400).json({ error: `Invalid enrichment: ${parsed.error}` }); return; }
  const submitted = parsed.data;
  const actorLabel = req.user.displayName ?? req.user.email ?? null;

  try {
    const out = await db.transaction(async (tx): Promise<{ status: number; body: object }> => {
      const ctx = await loadCandidateEditingContext(id, tx, { forUpdate: true, intent: "write" });
      const aiDerived = ctx.layers.aiDerived!;

      // Reject any attempt to change a tracked field through PATCH.
      const changed = OVERRIDABLE_PATH_KEYS.filter((p) => {
        const field = pathToField(p);
        return !overrideValuesEqual(
          (submitted as Record<string, unknown>)[field],
          (ctx.layers.effective as unknown as Record<string, unknown>)[field],
        );
      });
      if (changed.length > 0) {
        return {
          status: 400,
          body: {
            error: `Tracked field(s) ${changed.map((p) => OVERRIDABLE_PATHS[p].label).join(", ")} must be changed via the candidate override endpoint (PUT/DELETE /admin/reviews/${id}/candidate-overrides), not PATCH`,
            trackedPaths: changed,
          },
        };
      }

      // suggestedHashtags PINNED: keep the candidate's persisted baseline
      // (never the submitted draft) — refresh moderation never edits tags.
      const stamped = stampOverrideProvenance(
        { ...aiDerived, visualPromptStrategyOverride: submitted.visualPromptStrategyOverride } as FactEnrichment,
        ctx.layers.effective,
        actorLabel,
      );
      const visualPromptStrategyOverride = (stamped as { visualPromptStrategyOverride?: VisualOverride }).visualPromptStrategyOverride;
      const { columns } = materializeEnrichment({ aiDerived, overrides: ctx.layers.overrides, visualPromptStrategyOverride });
      await persistCandidateLayers(tx, ctx.review.candidateVersionId, columns);
      return { status: 200, body: { success: true, enrichment: columns.enrichment } };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    if (err instanceof CandidateEditError) { sendCandidateEditError(res, err); return; }
    logger.error({ err, reviewId: id }, "[PATCH /admin/reviews/:id/candidate-enrichment] failed");
    res.status(500).json({ error: "Failed to save candidate enrichment" });
  }
});

// ─── Moderation render-review tools (production_review) ────────────────────────
//
// Two surfaces a moderator uses to vet a fact's imagery before approval:
//   GET  /admin/reviews/:id/pexels-images        the staging fact's pulled stock
//   POST /admin/reviews/:id/render               render the AI background (t2i)
//   GET  /admin/reviews/:id/renders/:renderJobId admin-gated poll for that render
//
// Renders go through the SAME Nano-Banana-2 attempt pipeline production uses, but
// are EPHEMERAL: the attempt row is kept for audit while the image is NOT mirrored
// into the fact's shared production set (renderControls.mirrorToLegacyStorage:false).

/** Map a stored Pexels entry to the thumbnail shape the moderation panel needs. */
function toPexelsThumb(entry: PexelsPhotoEntry): {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
} {
  return {
    id: entry.id,
    // Prefer the higher-fidelity src URLs; fall back to the legacy `url` field
    // for older entries seeded before `src` was stored.
    url: entry.src?.large2x ?? entry.src?.large ?? entry.url,
    ...(entry.photographer !== undefined ? { photographer: entry.photographer } : {}),
    ...(entry.photographer_url !== undefined ? { photographer_url: entry.photographer_url } : {}),
  };
}

// GET /admin/reviews/:id/pexels-images — all genders, no isActive gate (staging
// facts are inactive, so the public /facts/:id/pexels-images endpoint can't serve
// them). Returns the live pexelsStatus so the panel can poll while seeding.
router.get("/admin/reviews/:id/pexels-images", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [review] = await db
    .select({ stagingFactId: pendingReviewsTable.stagingFactId })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, id))
    .limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  const emptyImages = { male: [], female: [], neutral: [] };
  if (review.stagingFactId == null) {
    res.json({ pexelsStatus: null, factType: null, keywords: null, images: emptyImages });
    return;
  }

  const [fact] = await db
    .select({ pexelsImages: factsTable.pexelsImages, pexelsStatus: factsTable.pexelsStatus })
    .from(factsTable)
    .where(eq(factsTable.id, review.stagingFactId))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "Staging fact not found" }); return; }

  const raw = fact.pexelsImages as FactPexelsImages | null;
  res.json({
    pexelsStatus: fact.pexelsStatus ?? null,
    factType: raw?.fact_type ?? null,
    keywords: raw?.keywords ?? null,
    images: {
      male: (raw?.male ?? []).map(toPexelsThumb),
      female: (raw?.female ?? []).map(toPexelsThumb),
      neutral: (raw?.neutral ?? []).map(toPexelsThumb),
    },
  });
});

const T2I_MODE = "t2i_fallback" as const;
const RenderReviewBody = z.object({
  subjectRenderMode: z.enum(["human_identity_i2i", "nonhuman_subject_i2i", "t2i_fallback"]).optional(),
  userSelectedSubjectRenderMode: z
    .enum(["human_identity_i2i", "nonhuman_subject_i2i", "t2i_fallback"])
    .nullish(),
  lookStyleId: z.string().max(200).nullish(),
  renderControls: z
    .object({
      aspectRatio: z.enum(["landscape", "square", "portrait"]).optional(),
      contentMode: z.enum(["sfw", "suggestive", "spicy"]).optional(),
      negativeSpacePreference: z.enum(["top", "bottom", "left", "right", "auto", "none"]).optional(),
      fallbackSubjectGender: z.enum(["male", "female", "neutral"]).optional(),
    })
    .strict()
    .optional(),
  identityPolicyOverrides: z.object({ preservePhysique: z.boolean() }).partial().strict().optional(),
  previewName: z.string().max(120).optional(),
  previewPronouns: z.string().max(40).optional(),
});

// POST /admin/reviews/:id/render — kick a t2i AI-background render for the staging
// fact using the SAME assembly the prompt preview uses, then return a renderJobId
// the admin poll route tracks. Ephemeral: nothing mirrors onto the fact.
router.post("/admin/reviews/:id/render", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = RenderReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid render controls", details: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;

  // t2i-only: review facts have no source image, so i2i would fail downstream
  // with i2i_missing_reference_url. Reject BEFORE enqueueing any paid work.
  if (body.subjectRenderMode && body.subjectRenderMode !== T2I_MODE) {
    res.status(400).json({
      error: "i2i_unavailable_in_moderation",
      message: "Moderation renders are text-to-image only — review facts have no source image.",
    });
    return;
  }

  const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.workflowStage !== "production_review") {
    res.status(409).json({ error: `Cannot render from stage ${review.workflowStage}. Finish prep first.` });
    return;
  }
  if (review.stagingFactId == null) {
    res.status(409).json({ error: "No staging fact for this review." });
    return;
  }

  // Resolve enrichment through the review-cycle resolver: a refresh cycle
  // previews its CANDIDATE version; a first-time cycle uses the staging fact.
  const cycle = await resolveReviewCycleEnrichment(review);
  if (!cycle) { res.status(409).json({ error: "Staging fact missing for this review." }); return; }

  const ev = validateEnrichment(cycle.rawEnrichment);
  if (!ev.ok) { res.status(400).json({ error: "fact_enrichment_invalid", details: ev.error }); return; }

  // Shared deterministic assembly — identical to the prompt-preview factId path,
  // forced to t2i with a fallback gender so the generator can build a protagonist.
  const resolved = await resolveRenderReviewInput(cycle.text, ev.data, {
    subjectRenderMode: T2I_MODE,
    userSelectedSubjectRenderMode: body.userSelectedSubjectRenderMode ?? body.subjectRenderMode ?? null,
    lookStyleId: body.lookStyleId ?? null,
    renderControls: {
      aspectRatio: body.renderControls?.aspectRatio,
      contentMode: body.renderControls?.contentMode,
      negativeSpacePreference: body.renderControls?.negativeSpacePreference,
      fallbackSubjectGender: body.renderControls?.fallbackSubjectGender ?? "neutral",
    },
    identityPolicyOverrides: body.identityPolicyOverrides,
    previewName: body.previewName,
    previewPronouns: body.previewPronouns,
  });

  // Only server-written internal fields reach renderControls — the client cannot
  // inject arbitrary keys (the resolver rebuilt renderControls from validated input).
  const renderControls: RenderControlsWithRefs = {
    ...resolved.renderControls,
    mirrorToLegacyStorage: false,
    reviewRenderSubject: { name: resolved.renderedSubject.name, pronouns: resolved.renderedSubject.pronouns },
    reviewAudit: { reviewId: id, adminUserId: req.user.id },
  };

  const { renderJobId, attemptId } = await buildAndEnqueueImagePromptAttempt({
    factId: review.stagingFactId,
    userId: null, // not user-owned — provenance lives in reviewAudit / requestId
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
    { reviewId: id, stagingFactId: review.stagingFactId, adminId: req.user.id, attemptId, renderJobId },
    "[moderation] review render enqueued",
  );
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

// ─── Step-2 render scenarios (durable, server-side multi-scenario grid) ────────

// GET the scenario grid (derived status/stale/tally; cards carry admin-gated
// thumbnail URLs reusing the existing render-image route).
router.get("/admin/reviews/:id/render-scenarios", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  res.json(await buildReviewScenarioGrid(id));
});

const RunScenariosBody = z.object({
  scenarios: z.array(renderScenarioKeySchema).min(1).max(RENDER_SCENARIO_KEYS.length),
  force: z.boolean().optional(),
});

// POST a selective rerun (checkbox "Run" + per-tile rerun). Always creates fresh
// attempts; `force` lets a moderator run a non-applicable non-human scenario.
router.post("/admin/reviews/:id/render-scenarios", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = RunScenariosBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid scenarios", details: parsed.error.flatten() }); return; }

  const [review] = await db
    .select({ workflowStage: pendingReviewsTable.workflowStage })
    .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  if (review.workflowStage !== "production_review") {
    res.status(409).json({ error: `Cannot render from stage ${review.workflowStage}. Finish prep first.` });
    return;
  }

  const result = await runReviewScenarios(id, parsed.data.scenarios, req.user.id);
  if ("error" in result) { res.status(409).json(result); return; }
  logger.info({ reviewId: id, scenarios: parsed.data.scenarios, adminId: req.user.id }, "[moderation] manual scenario rerun");
  res.status(202).json(result);
});

// POST /admin/reviews/:id/visual-concepts/regenerate — re-draft the 3 candidate
// Visual concepts (Slice 2A). The body may carry the moderator's UNSAVED draft so
// the server can offer it as "here's my direction — propose DISTINCT alternatives"
// context (the server can't see local drafts otherwise). The draft is NOT
// persisted by regeneration; a blank/invalid draft → fresh ideas.
const RegenerateVisualConceptsBody = z.object({
  coreSceneDraft: z.string().max(CANDIDATE_SCENE_MAX_CHARS).nullish(),
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
      candidateVersionId: pendingReviewsTable.candidateVersionId,
    })
    .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }
  // Regeneration is the Step-2 (Visual Concept) retry path; Visual Ideas are a
  // Step-2 artifact, so it only runs while the review sits at concept_review.
  if (review.workflowStage !== "concept_review") {
    res.status(409).json({ error: `Cannot regenerate visual ideas from stage ${review.workflowStage}. Only available during Visual Concept review (Step 2).` });
    return;
  }
  if (review.stagingFactId == null) { res.status(409).json({ error: "Review has no staging fact." }); return; }

  // Block while a concept job is still in-flight: fact_visual_concepts is review-
  // scoped-deduped, so a regenerate enqueued now would COALESCE onto the pending
  // job (returning it, ignoring the draft) and could complete the gag gate on
  // stale candidates. Force the moderator to wait for the current run to land.
  const [conceptFact] = await db
    .select({ visualConceptStatus: factsTable.visualConceptStatus })
    .from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1);
  if (conceptFact?.visualConceptStatus === "pending") {
    res.status(409).json({
      error: "Visual ideas are still generating. Wait for them to finish, then regenerate.",
      code: "IDEAS_PENDING",
    });
    return;
  }

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

  await enqueueVisualConceptsForReview({
    reviewId: id,
    factId: review.stagingFactId,
    candidateVersionId: review.candidateVersionId ?? null,
    moderatorDraftScene: draft,
  });
  logger.info({ reviewId: id, hasDraft: draft != null, adminId: req.user.id }, "[moderation] visual concepts regenerate");
  res.status(202).json({ success: true, visualConceptStatus: "pending" });
});

// GET frozen diagnostics for ONE attempt (the prompt/plan that produced THIS
// image — distinct from RuntimePromptPreview's recompute-under-current-assumptions).
router.get("/admin/reviews/:id/render-scenarios/:scenarioKey/attempts/:attemptId", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  const attemptId = parseInt(String(req.params["attemptId"] ?? ""), 10);
  if (isNaN(id) || isNaN(attemptId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const keyParsed = renderScenarioKeySchema.safeParse(req.params["scenarioKey"]);
  if (!keyParsed.success) { res.status(400).json({ error: "Invalid scenario key" }); return; }

  const diag = await getScenarioAttemptDiagnostics(id, keyParsed.data, attemptId);
  if (!diag) { res.status(404).json({ error: "attempt_not_found" }); return; }
  res.json(diag);
});

// POST a moderator eval (rating + failure-tag + notes) on ONE moderation
// test-render attempt (Slice 2B). Sibling of the diagnostics route. Ownership
// guards: the attempt exists, belongs to THIS review + scenario, and is a
// moderation attempt (not an eval-run render — those rate via the generic
// /admin/eval/attempts/:id/eval route). Opportunistic ratings here are
// "directional only" in the dashboard; only eval-run rows are a true A/B.
router.post("/admin/reviews/:id/render-scenarios/:scenarioKey/attempts/:attemptId/eval", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  const attemptId = parseInt(String(req.params["attemptId"] ?? ""), 10);
  if (isNaN(id) || isNaN(attemptId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const keyParsed = renderScenarioKeySchema.safeParse(req.params["scenarioKey"]);
  if (!keyParsed.success) { res.status(400).json({ error: "Invalid scenario key" }); return; }
  const parsed = evalWriteSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid eval body", details: parsed.error.flatten() }); return; }
  const update = resolveEvalColumns(parsed.data);
  if (evalColumnUpdateIsEmpty(update)) { res.status(400).json({ error: "No eval fields provided (rating, failureTag, or notes)." }); return; }

  const [attempt] = await db
    .select({
      id: imagePromptAttemptsTable.id,
      reviewId: imagePromptAttemptsTable.reviewId,
      scenarioKey: imagePromptAttemptsTable.reviewRenderScenarioKey,
      evalRunId: imagePromptAttemptsTable.evalRunId,
    })
    .from(imagePromptAttemptsTable)
    .where(eq(imagePromptAttemptsTable.id, attemptId))
    .limit(1);
  if (!attempt) { res.status(404).json({ error: "attempt_not_found" }); return; }
  if (attempt.reviewId !== id) { res.status(404).json({ error: "attempt_not_in_review" }); return; }
  if (attempt.scenarioKey !== keyParsed.data) { res.status(409).json({ error: "scenario_mismatch" }); return; }
  if (attempt.evalRunId != null) { res.status(409).json({ error: "eval_run_attempt", detail: "Rate eval-run renders via /admin/eval/attempts/:attemptId/eval." }); return; }

  await db
    .update(imagePromptAttemptsTable)
    .set({ ...update, evalBy: req.user.id, evalAt: new Date(), updatedAt: new Date() })
    .where(eq(imagePromptAttemptsTable.id, attemptId));
  res.json({ success: true });
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
