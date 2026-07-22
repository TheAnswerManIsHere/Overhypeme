/**
 * Integration tests for PR1 of the stale-fact refresh feature (versioned
 * enrichment core):
 *
 *  - sendFactBackToReview (candidate + new review cycle, guards, 409s)
 *  - runEnrichmentForCandidateVersion (two-phase stale-job guard, writes the
 *    VERSION row — never facts.*)
 *  - candidate isolation across readers (public/active reads facts.enrichment;
 *    moderation single-render, scenario runner, and RuntimePromptPreview read
 *    the CANDIDATE via resolveReviewCycleEnrichment)
 *  - promote (approve-for-production on a refresh cycle): facts.* ← candidate,
 *    prior active archived as superseded, field-preservation invariant, drift
 *    guard (REFRESH_STALE_TEXT), first-approval side effects skipped
 *  - reject: candidate RETAINED as rejected, live fact untouched, a later
 *    send-back works
 *  - generic fact-enrichment guards are refresh-aware (resolved cycles never
 *    poison live re-enrich; in-flight refresh cycles are never touched by the
 *    generic job; abandoned staging facts still skip paid work)
 *
 * Same harness as routes.reviews.test.ts (real authMiddleware + session bearer,
 * real test DB, plan generator stubbed so no test hits OpenAI).
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  pendingReviewsTable,
  factEnrichmentVersionsTable,
  activityFeedTable,
  asyncJobsTable,
  hashtagsTable,
  factHashtagsTable,
  imagePromptAttemptsTable,
  adminConfigTable,
} from "@workspace/db/schema";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { currentProcessingSignature, type FactEnrichment, type ProcessingSignature } from "@workspace/api-zod";
import { bustConfigCache } from "../lib/adminConfig.js";

import reviewsRouter, { __setPlanGeneratorForTest } from "../routes/reviews.js";
import adminRouter from "../routes/admin.js";
import adminImagePromptRouter from "../routes/adminImagePrompt.js";
import { materializeEnrichment } from "../lib/factEnrichment.js";
import { sendFactBackToReview, SendBackToReviewError } from "../lib/sendBackToReview.js";
import { runEnrichmentForCandidateVersion } from "../lib/enrichmentJobs.js";
import {
  advanceReviewForStagingFactEnrichment,
  findUnresolvedReviewForStagingFact,
  isStagingImagePrepActive,
  resolveGenericFactEnrichmentDecision,
  resolveReviewCycleEnrichment,
} from "../lib/moderationStaging.js";
import { runEnrichmentForFact } from "../lib/enrichmentJobs.js";
import { runReviewScenarios } from "../lib/reviewRenderScenarios.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_refresh_";
const TEST_FILE_START = new Date();

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACTIVE_AI_BASELINE: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "legendary", "pushups"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

// The "new pipeline" baseline the refresh classifier returns — distinguishable
// from the active one by its cultural reference and confidence.
const REFRESHED_AI_BASELINE: FactEnrichment = {
  ...ACTIVE_AI_BASELINE,
  taxonomyConfidence: 0.5,
  culturalReferences: [
    {
      sourcePhrase: "Shark Week",
      referenceType: "cultural_reference",
      canonicalReference: "Discovery Channel's Shark Week",
      explanation: "Annual week of shark programming.",
      visualImplication: "Sharks, ocean, documentary framing.",
      confidence: 0.95,
      requiresAdminReview: false,
    },
  ],
} as FactEnrichment;

// A moderator override that must survive the whole refresh round-trip.
const MANUAL_OVERRIDES = {
  "/visualComplexity": {
    value: "high",
    overriddenFrom: "medium",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    createdBy: "admin",
    reason: "test",
  },
};

const PEXELS_SENTINEL = { fact_type: "action", male: [], female: [], neutral: [{ id: 1, url: "https://x/1.jpg" }] };
const AI_MEME_SENTINEL = { male: ["/objects/m1.png"], female: [], neutral: [] };

const WAIVE_ALL_REQUIRED = {
  waiveVisualRenderIssues: true,
  waivedScenarioKeys: ["generic_t2i", "i2i_male_default", "i2i_female_default"],
};

// Minimal valid plan output for the render preflight / preview compiler.
function makePlanOutput(rating: "strong" | "poor" = "strong") {
  return {
    visualPlan: {
      sceneConcept: "Alex Jordan performing a superhuman feat",
      visualGoal: "Make the feat legible",
      visualApproach: "Cinematic close-up",
      archetypeApplication: {
        primaryArchetype: "superhuman_physical_feat",
        subtype: "force_scaled_action",
        selectedFrame: "direct_action",
        strategyRationale: "Authored strategy applies.",
      },
      coreScene: "Alex Jordan performs a superhuman feat in the foreground as onlookers react.",
      subjectDetails: ["confident focused expression", "mid-exertion heroic pose"],
      environment: ["dramatic stage lighting", "blurred background crowd"],
      lightingAndStyle: "high-contrast cinematic key light",
      keyVisualElements: ["central foreground", "dramatic lighting", "exertion pose"],
      subjectTreatment: {
        roleInScene: "Legendary protagonist",
        subjectRenderMode: "t2i_fallback",
        identityPreservation: "none",
        nonhumanSubjectTreatment: {
          applicable: false,
          subjectKind: "not_applicable",
          preserveTraits: [],
          anthropomorphicTreatment: "none",
          doNotTransformIntoHuman: false,
        },
        fallbackSubjectGender: "neutral",
        expressionAndPose: "Confident, focused",
        ageLifeStageTransform: { applies: false, targetState: "" },
      },
      subjectFactCompatibility: {
        rating,
        reason: rating === "poor" ? "The fact cannot be staged on a human subject." : "Stages well.",
        recommendedFallback: rating === "poor" ? "choose_different_fact" : "none",
      },
      composition: {
        subjectFraming: "Medium close-up",
        negativeSpace: "top",
        cameraStyle: "Cinematic 35mm",
        sceneReadability: "Subject is the readable element",
      },
      supportingTextPolicy: {
        allowSupportingText: false,
        supportingTextElements: [],
        forbiddenTextTypes: [
          "full meme captions",
          "full fact text",
          "hashtags",
          "watermarks",
          "real logos",
          "brand marks",
          "long explanatory paragraphs",
        ],
      },
      secondaryCharacters: [],
      semanticEntitiesUsed: [],
      culturalReferencesUsed: [],
      styleIntegration: "Apply cinematic style",
      contentNotes: "SFW",
      debugNotes: "Strategy v2",
      targetEngine: "nano_banana_2" as const,
      generationMode: "t2i" as const,
    },
    compiledPrompt: {
      prompt: "Alex Jordan lifts a mountain over their head with one arm.",
      negativePrompt: "",
      engineNotes: "",
    },
    promptVersion: "test-prompt-v1",
    archetypeStrategyVersion: "test-strategy-v1",
    generatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    generatedBy: "openai" as const,
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  app.use(adminRouter);
  app.use(adminImagePromptRouter);
  return app;
}

async function createTestUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
    membershipTier: opts.isAdmin ? "legendary" : "registered",
    captchaVerified: true,
  });
  return id;
}

async function bearerForUser(userId: string, isAdmin: boolean): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId, membershipTier: isAdmin ? "legendary" : "registered" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin,
    captchaVerified: true,
  };
  return createSession(sessionData, userId);
}

let adminId: string;
let adminSid: string;
let submitterId: string;
const insertedFactIds: number[] = [];

/** A live fact in full override-tracking shape (baseline + one manual override). */
async function seedActiveFact(opts: { text?: string } = {}): Promise<typeof factsTable.$inferSelect> {
  const { columns } = materializeEnrichment({ aiDerived: ACTIVE_AI_BASELINE, overrides: MANUAL_OVERRIDES });
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: opts.text ?? "{NAME} bench-presses the Earth.",
      submittedById: submitterId,
      isActive: true,
      ...columns,
      enrichmentStatus: "ok",
      pexelsImages: PEXELS_SENTINEL,
      aiMemeImages: AI_MEME_SENTINEL,
      upvotes: 7,
      score: 7,
    } as typeof factsTable.$inferInsert)
    .returning();
  insertedFactIds.push(fact.id);
  return fact;
}

/**
 * Send back + run the candidate enrichment job (stubbed classify). Enrichment now
 * lands the cycle at Step 2 (`concept_review`); this helper then advances it to
 * Step 3 (`production_review`) — simulating "approve the visual gag" — so the
 * downstream render/promote (Step-3) assertions can run unchanged.
 */
async function seedReadyRefreshCycle(fact: { id: number }): Promise<{ reviewId: number; candidateVersionId: number }> {
  const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });
  const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
    classify: async () => REFRESHED_AI_BASELINE,
  });
  assert.equal(result.ok, true);
  await db.update(pendingReviewsTable).set({ workflowStage: "production_review" })
    .where(eq(pendingReviewsTable.id, reviewId));
  return { reviewId, candidateVersionId };
}

/** Author a moderator Visual Concept on a refresh candidate (required to promote —
 *  presence-based, no enable toggle). Sends the candidate's CURRENT enrichment (so
 *  tracked fields match) with only the VSO added. Kept OUT of seedReadyRefreshCycle so
 *  shape-comparison tests still see a scene-less candidate. */
async function authorConceptForCycle(reviewId: number, candidateVersionId: number): Promise<void> {
  const [ver] = await db.select({ enrichment: factEnrichmentVersionsTable.enrichment })
    .from(factEnrichmentVersionsTable).where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
  const res = await request(makeApp())
    .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
    .set("authorization", `Bearer ${adminSid}`)
    .send({ enrichment: {
      ...(ver.enrichment as FactEnrichment),
      visualPromptStrategyOverride: {
        version: 1, coreSceneOverride: "{NAME} lifts the planet overhead in a packed stadium.",
        requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
        bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
      },
    } });
  assert.equal(res.status, 200, `authorConceptForCycle: ${JSON.stringify(res.body)}`);
}

async function cleanup() {
  if (insertedFactIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, insertedFactIds));
    await db.delete(factHashtagsTable).where(inArray(factHashtagsTable.factId, insertedFactIds));
    // Refresh reviews carry submittedById=null — delete by staging fact id.
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, insertedFactIds));
    // fact_enrichment_versions cascades on fact delete.
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(activityFeedTable).where(eq(activityFeedTable.userId, u.id));
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(hashtagsTable).where(like(hashtagsTable.name, "trefresh%"));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = await createTestUser({ isAdmin: true });
  submitterId = await createTestUser();
  adminSid = await bearerForUser(adminId, true);
});

after(async () => {
  await cleanup();
  // Drop jobs this file enqueued so no worker ever runs them.
  await db.delete(asyncJobsTable).where(
    and(
      inArray(asyncJobsTable.queue, ["enrichment", "review_render_scenarios_prepare", "image_prompt_generation"]),
      gte(asyncJobsTable.createdAt, TEST_FILE_START),
    ),
  );
});

afterEach(() => __setPlanGeneratorForTest(null));

// ── sendFactBackToReview ─────────────────────────────────────────────────────

describe("sendFactBackToReview", () => {
  it("creates a seeded candidate + a NEW prep_pending review cycle and enqueues the version job — facts.* untouched", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId, versionNo } = await sendFactBackToReview({ factId: fact.id, adminId });
    assert.equal(versionNo, 1);

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.factId, fact.id);
    assert.equal(candidate.source, "refresh_candidate");
    assert.equal(candidate.sourceReviewId, reviewId);
    assert.equal(candidate.enrichment, null, "candidate blob is filled by the job, not at send-back");
    assert.equal(candidate.enrichmentAiDerived, null);
    // Manual edits preserved by default: overrides seeded from the ACTIVE version.
    assert.deepEqual(candidate.enrichmentOverrides, MANUAL_OVERRIDES);
    assert.equal(typeof candidate.factTextHash, "string");
    assert.equal(candidate.createdBy, adminId);

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review.workflowStage, "prep_pending");
    assert.equal(review.stagingFactId, fact.id);
    assert.equal(review.candidateVersionId, candidateVersionId);
    assert.equal(review.submittedById, null, "refresh cycles have no submitter to notify");
    assert.equal(review.enrichment, null, "candidate blobs live ONLY in the version table");

    // The live fact: still active, enrichment untouched, only the prep pill flipped.
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.isActive, true);
    assert.equal(f.enrichmentStatus, "pending");
    assert.deepEqual(f.enrichment, fact.enrichment);
    assert.deepEqual(f.enrichmentOverrides, fact.enrichmentOverrides);
    assert.deepEqual(f.pexelsImages, PEXELS_SENTINEL);

    // Exactly one candidate enrichment job (deduped per version), and NO Pexels job.
    const jobs = await db.select({ queue: asyncJobsTable.queue, dedupeKey: asyncJobsTable.dedupeKey })
      .from(asyncJobsTable)
      .where(sql`${asyncJobsTable.payload}->>'versionId' = ${String(candidateVersionId)}`);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].queue, "enrichment");
    assert.equal(jobs[0].dedupeKey, `enrichment:version:${candidateVersionId}`);
    const pexels = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "fact_pexels"), sql`${asyncJobsTable.payload}->>'factId' = ${String(fact.id)}`));
    assert.equal(pexels.length, 0, "refresh never re-runs Pexels (text unchanged)");
  });

  it("clearOverrides wipes the CANDIDATE's seed only — the fact's own overrides survive", async () => {
    const fact = await seedActiveFact();
    const { candidateVersionId } = await sendFactBackToReview({ factId: fact.id, clearOverrides: true, adminId });
    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.deepEqual(candidate.enrichmentOverrides, {});
    assert.equal(candidate.visualOverride, null);
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(f.enrichmentOverrides, MANUAL_OVERRIDES, "fact-level overrides never touched");
  });

  it("409s a second concurrent refresh (one candidate per fact), naming the in-flight cycle", async () => {
    const fact = await seedActiveFact();
    const first = await sendFactBackToReview({ factId: fact.id, adminId });
    await assert.rejects(
      sendFactBackToReview({ factId: fact.id, adminId }),
      (err: unknown) => {
        assert.ok(err instanceof SendBackToReviewError);
        assert.equal(err.code, "REFRESH_ALREADY_IN_PROGRESS");
        assert.equal(err.existing?.candidateVersionId, first.candidateVersionId);
        assert.equal(err.existing?.reviewId, first.reviewId);
        return true;
      },
    );
  });

  it("rejects an inactive fact (NOT_ACTIVE) and a root with active variants", async () => {
    const [inactive] = await db.insert(factsTable)
      .values({ text: "{NAME} inactive", submittedById: submitterId, isActive: false })
      .returning();
    insertedFactIds.push(inactive.id);
    await assert.rejects(
      sendFactBackToReview({ factId: inactive.id, adminId }),
      (err: unknown) => err instanceof SendBackToReviewError && err.code === "NOT_ACTIVE",
    );

    const root = await seedActiveFact();
    const [variant] = await db.insert(factsTable)
      .values({ text: "{NAME} variant", submittedById: submitterId, isActive: true, parentId: root.id })
      .returning();
    insertedFactIds.push(variant.id);
    await assert.rejects(
      sendFactBackToReview({ factId: root.id, adminId }),
      (err: unknown) => err instanceof SendBackToReviewError && err.code === "HAS_ACTIVE_VARIANTS",
    );
  });
});

// ── Candidate enrichment job (two-phase guard) ───────────────────────────────

describe("runEnrichmentForCandidateVersion", () => {
  it("writes the VERSION row (never facts.*), advances its exact review to concept_review, and preps concepts (NOT renders)", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });

    const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
      classify: async () => REFRESHED_AI_BASELINE,
    });
    assert.equal(result.ok, true);

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(candidate.status, "candidate");
    // Effective = fresh baseline + the seeded manual override.
    assert.equal((candidate.enrichment as FactEnrichment).visualComplexity, "high");
    assert.equal((candidate.enrichment as FactEnrichment).culturalReferences?.[0]?.sourcePhrase, "Shark Week");
    assert.equal((candidate.enrichmentAiDerived as FactEnrichment).visualComplexity, "medium");

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review.workflowStage, "concept_review");

    // facts.* stayed the ACTIVE enrichment; only the pill cleared.
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(f.enrichment, fact.enrichment);
    assert.equal(f.enrichmentStatus, "ok");

    // Step 2: the Visual-Idea concept job is enqueued; NO render prepare fires
    // until the moderator approves the visual gag (Step 3).
    const prep = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
      .where(and(
        eq(asyncJobsTable.queue, "review_render_scenarios_prepare"),
        eq(asyncJobsTable.dedupeKey, `review_render_prep:${reviewId}`),
      ));
    assert.equal(prep.length, 0, "no render prepare at Step 2");
    const concepts = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
      .where(and(
        eq(asyncJobsTable.queue, "fact_visual_concepts"),
        eq(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${reviewId}`),
      ));
    assert.equal(concepts.length, 1, "concepts enqueued at Step 2");
  });

  it("COST GUARD phase 1: skips classification when the cycle was already resolved", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });
    // Moderator rejected the cycle while the job sat queued.
    await db.update(pendingReviewsTable).set({ status: "rejected", workflowStage: "production_rejected" })
      .where(eq(pendingReviewsTable.id, reviewId));

    let classifyCalled = false;
    const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
      classify: async () => { classifyCalled = true; return REFRESHED_AI_BASELINE; },
    });
    assert.equal(result.ok, true, "retires as a successful no-op");
    assert.equal(classifyCalled, false, "no paid classification after the cycle resolved");
    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(candidate.enrichment, null, "candidate row untouched");
  });

  it("onAbandon marks a still-in-flight cycle prep_failed, but never rewrites a resolved one", async () => {
    const { enrichmentJobHandler } = await import("../lib/enrichmentJobs.js");

    // In-flight cycle: terminal abandon → prep_failed + failed pill.
    const factA = await seedActiveFact();
    const a = await sendFactBackToReview({ factId: factA.id, adminId });
    await enrichmentJobHandler.onAbandon!({ payload: { factId: factA.id, versionId: a.candidateVersionId }, id: 991 } as never);
    const [reviewA] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, a.reviewId));
    assert.equal(reviewA.workflowStage, "prep_failed");
    const [fA] = await db.select().from(factsTable).where(eq(factsTable.id, factA.id));
    assert.equal(fA.enrichmentStatus, "failed");

    // Already-rejected cycle: a late abandon must NOT resurrect it as failed.
    const factB = await seedActiveFact();
    const b = await sendFactBackToReview({ factId: factB.id, adminId });
    await db.transaction(async (tx) => {
      await tx.update(pendingReviewsTable)
        .set({ status: "rejected", workflowStage: "production_rejected" })
        .where(eq(pendingReviewsTable.id, b.reviewId));
      await tx.update(factEnrichmentVersionsTable)
        .set({ status: "rejected", rejectedAt: new Date() })
        .where(eq(factEnrichmentVersionsTable.id, b.candidateVersionId));
      await tx.update(factsTable).set({ enrichmentStatus: "ok" }).where(eq(factsTable.id, factB.id));
    });
    await enrichmentJobHandler.onAbandon!({ payload: { factId: factB.id, versionId: b.candidateVersionId }, id: 992 } as never);
    const [reviewB] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, b.reviewId));
    assert.equal(reviewB.workflowStage, "production_rejected", "resolved cycle must not be rewritten to prep_failed");
    assert.equal(reviewB.status, "rejected");
    const [fB] = await db.select().from(factsTable).where(eq(factsTable.id, factB.id));
    assert.equal(fB.enrichmentStatus, "ok", "the LIVE fact's pill must not flip to failed after a reject");
  });

  it("phase 3 recheck: a mid-classify rejection makes the write a no-op", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });

    const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
      classify: async () => {
        // The moderator rejects the refresh WHILE the LLM call is in flight.
        await db.update(factEnrichmentVersionsTable)
          .set({ status: "rejected", rejectedAt: new Date() })
          .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
        await db.update(pendingReviewsTable).set({ status: "rejected", workflowStage: "production_rejected" })
          .where(eq(pendingReviewsTable.id, reviewId));
        return REFRESHED_AI_BASELINE;
      },
    });
    assert.equal(result.ok, true);

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(candidate.status, "rejected");
    assert.equal(candidate.enrichment, null, "the stale result was discarded, not written");
    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review.workflowStage, "production_rejected", "the resolved cycle was not re-advanced");
  });
});

// ── Candidate isolation across readers ───────────────────────────────────────

describe("candidate isolation across readers", () => {
  it("resolveReviewCycleEnrichment: refresh cycle → CANDIDATE; first-time cycle → staging fact", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    const refreshCycle = await resolveReviewCycleEnrichment(review);
    assert.equal(refreshCycle?.source, "candidate_version");
    assert.equal((refreshCycle?.rawEnrichment as FactEnrichment).culturalReferences?.[0]?.sourcePhrase, "Shark Week");

    const firstTime = await resolveReviewCycleEnrichment({ stagingFactId: fact.id, candidateVersionId: null });
    assert.equal(firstTime?.source, "staging_fact");
    assert.deepEqual(firstTime?.rawEnrichment, fact.enrichment);
    assert.ok(candidateVersionId);
  });

  it("RuntimePromptPreview: factId path reads ACTIVE; with reviewIdForRender it reads the CANDIDATE", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await seedReadyRefreshCycle(fact);
    __setPlanGeneratorForTest(async () => makePlanOutput("strong") as never);

    const previewBody = {
      subjectRenderMode: "t2i_fallback",
      renderControls: { aspectRatio: "portrait", contentMode: "sfw", fallbackSubjectGender: "neutral" },
    };

    // Plain fact preview (public/workbench view) → the ACTIVE enrichment.
    const activeRes = await request(makeApp())
      .post("/admin/image-prompt/preview")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ factId: fact.id, ...previewBody });
    assert.equal(activeRes.status, 200, JSON.stringify(activeRes.body));
    assert.deepEqual(activeRes.body.debug.culturalReferencesProvided, []);

    // Moderation-modal preview (review context) → the CANDIDATE.
    const candidateRes = await request(makeApp())
      .post("/admin/image-prompt/preview")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ factId: fact.id, reviewIdForRender: reviewId, ...previewBody });
    assert.equal(candidateRes.status, 200, JSON.stringify(candidateRes.body));
    assert.equal(candidateRes.body.debug.culturalReferencesProvided?.[0]?.sourcePhrase, "Shark Week");

    // A stale client mixing a review with someone else's fact is refused.
    const mismatch = await request(makeApp())
      .post("/admin/image-prompt/preview")
      .set("authorization", `Bearer ${adminSid}`)
      .send({ factId: fact.id + 999999, reviewIdForRender: reviewId, ...previewBody });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, "review_fact_mismatch");
  });

  it("single moderation render + scenario runner snapshot the CANDIDATE enrichment", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await seedReadyRefreshCycle(fact);

    // POST /admin/reviews/:id/render — the ephemeral single render.
    const renderRes = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(renderRes.status, 202, JSON.stringify(renderRes.body));
    const [attempt] = await db.select().from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.id, renderRes.body.attemptId));
    assert.equal(
      (attempt.factEnrichmentSnapshot as FactEnrichment).culturalReferences?.[0]?.sourcePhrase,
      "Shark Week",
      "single render must snapshot the CANDIDATE, not the active enrichment",
    );

    // Scenario runner (the grid's render path).
    const run = await runReviewScenarios(reviewId, ["generic_t2i"], adminId);
    assert.ok(!("error" in run), JSON.stringify(run));
    const [scenarioAttempt] = await db.select().from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.id, run.enqueued[0].attemptId));
    assert.equal(
      (scenarioAttempt.factEnrichmentSnapshot as FactEnrichment).culturalReferences?.[0]?.sourcePhrase,
      "Shark Week",
      "scenario renders must snapshot the CANDIDATE",
    );
  });
});

// ── Promote (approve-for-production on a refresh cycle) ──────────────────────

describe("refresh approve → promote", () => {
  it("promotes candidate→facts.*, archives the prior active as superseded, and preserves every non-enrichment field", async () => {
    const fact = await seedActiveFact();
    // A pre-existing discovery tag that must survive untouched.
    const [tag] = await db.insert(hashtagsTable).values({ name: `trefresh${randomUUID().slice(0, 8)}` }).returning();
    await db.insert(factHashtagsTable).values({ factId: fact.id, hashtagId: tag.id });

    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    // Simulate the PR3 signature stamp so promote's signature-from-candidate is provable now.
    const fakeSignature = { engineRevision: 7, taxonomyVersion: "vTEST" };
    await db.update(factEnrichmentVersionsTable).set({ signature: fakeSignature })
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    await authorConceptForCycle(reviewId, candidateVersionId);

    __setPlanGeneratorForTest(async () => makePlanOutput("strong") as never);
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.refreshPromoted, true);
    assert.equal(res.body.factId, fact.id);

    // facts.* now carries the candidate's layers (override preserved on top of the fresh baseline).
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal((f.enrichment as FactEnrichment).culturalReferences?.[0]?.sourcePhrase, "Shark Week");
    assert.equal((f.enrichment as FactEnrichment).visualComplexity, "high", "manual override survived the refresh");
    assert.equal((f.enrichmentAiDerived as FactEnrichment).visualComplexity, "medium");
    assert.deepEqual(f.enrichmentOverrides, MANUAL_OVERRIDES);
    assert.deepEqual(f.lastProcessedSignature, fakeSignature, "signature stamped FROM THE CANDIDATE at promote");
    assert.equal(f.enrichmentStatus, "ok");

    // FIELD-PRESERVATION INVARIANT: nothing else moved.
    assert.equal(f.isActive, true);
    assert.equal(f.parentId, null);
    assert.equal(f.text, fact.text);
    assert.deepEqual(f.pexelsImages, PEXELS_SENTINEL);
    assert.deepEqual(f.aiMemeImages, AI_MEME_SENTINEL);
    assert.equal(f.upvotes, 7);
    assert.equal(f.score, 7);
    const tagRows = await db.select().from(factHashtagsTable).where(eq(factHashtagsTable.factId, fact.id));
    assert.equal(tagRows.length, 1, "hashtags neither attached nor removed");
    assert.equal(tagRows[0].hashtagId, tag.id);

    // Version history: prior active archived as superseded; candidate now promoted.
    const versions = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.factId, fact.id));
    const superseded = versions.find((v) => v.status === "superseded");
    assert.ok(superseded, "prior active facts.* archived");
    assert.equal(superseded.source, "prior_active_snapshot");
    assert.deepEqual(superseded.enrichment, fact.enrichment);
    assert.ok(superseded.supersededAt);
    const promoted = versions.find((v) => v.id === candidateVersionId);
    assert.equal(promoted?.status, "promoted");
    assert.ok(promoted?.promotedAt);

    // Review resolved; NO enrichment audit snapshot (the version table is the audit).
    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review.workflowStage, "production_approved");
    assert.equal(review.status, "approved");
    assert.equal(review.approvedFactId, fact.id);
    assert.equal(review.enrichment, null);

    // First-approval side effects skipped: no "your fact was added" activity for
    // the original submitter (and refresh reviews carry no submitter at all).
    const activity = await db.select().from(activityFeedTable).where(eq(activityFeedTable.userId, submitterId));
    assert.equal(activity.length, 0);

    // Idempotent re-call.
    const again = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyApproved, true);
  });

  it("fact-text drift → 409 REFRESH_STALE_TEXT and nothing changes", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    await authorConceptForCycle(reviewId, candidateVersionId);
    // The fact's text is edited AFTER the candidate was classified against it.
    await db.update(factsTable).set({ text: "{NAME} bench-presses the Moon." }).where(eq(factsTable.id, fact.id));

    __setPlanGeneratorForTest(async () => makePlanOutput("strong") as never);
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "REFRESH_STALE_TEXT");

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(candidate.status, "candidate", "candidate untouched — moderator can reject + re-send");
    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review.workflowStage, "production_review");
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(f.enrichment, fact.enrichment, "active enrichment untouched");
  });

  it("400s when the candidate has no enrichment yet (job still running)", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await sendFactBackToReview({ factId: fact.id, adminId });
    // Force the stage forward without running the job — approval must still refuse.
    await db.update(pendingReviewsTable).set({ workflowStage: "production_review" })
      .where(eq(pendingReviewsTable.id, reviewId));

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(res.status, 400);
  });
});

// ── Reject (retain) ──────────────────────────────────────────────────────────

describe("refresh reject → candidate retained", () => {
  it("marks the candidate rejected (RETAINED), leaves the live fact untouched, and allows a later send-back", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/reject`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ rejectionReason: "lame", adminNote: "don't promote this refresh" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(candidate.status, "rejected", "retained as history, never deleted");
    assert.ok(candidate.rejectedAt);
    assert.ok(candidate.enrichment, "the classified blob is kept for the history view");

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review.workflowStage, "production_rejected");

    // The live fact is exactly as it was (reject = "don't promote", not "unpublish").
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.isActive, true);
    assert.deepEqual(f.enrichment, fact.enrichment);
    assert.deepEqual(f.enrichmentOverrides, fact.enrichmentOverrides);
    assert.equal(f.enrichmentStatus, "ok");
    assert.deepEqual(f.pexelsImages, PEXELS_SENTINEL);

    // No submitter notification for a refresh rejection.
    const activity = await db.select().from(activityFeedTable).where(eq(activityFeedTable.userId, submitterId));
    assert.equal(activity.length, 0);

    // The retained rejected row does NOT block a fresh refresh; version_no advances.
    const second = await sendFactBackToReview({ factId: fact.id, adminId });
    assert.equal(second.versionNo, 2);
  });
});

// ── Live-fact write freeze while a refresh is in review ──────────────────────

describe("enrichment write freeze during refresh", () => {
  it("409s every live-enrichment write path while a candidate is in flight, and unfreezes after reject", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });
    const app = makeApp();

    const putRes = await request(app)
      .put(`/admin/facts/${fact.id}/enrichment-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/visualComplexity", value: "low" });
    assert.equal(putRes.status, 409, JSON.stringify(putRes.body));
    assert.equal(putRes.body.code, "REFRESH_IN_REVIEW");
    assert.equal(putRes.body.reviewId, reviewId);
    assert.equal(putRes.body.candidateVersionId, candidateVersionId);

    const delRes = await request(app)
      .delete(`/admin/facts/${fact.id}/enrichment-overrides?path=/visualComplexity`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(delRes.status, 409);
    assert.equal(delRes.body.code, "REFRESH_IN_REVIEW");

    const patchRes = await request(app)
      .patch(`/admin/facts/${fact.id}/enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: fact.enrichment });
    assert.equal(patchRes.status, 409);
    assert.equal(patchRes.body.code, "REFRESH_IN_REVIEW");

    const enrichRes = await request(app)
      .post(`/admin/facts/${fact.id}/enrich`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(enrichRes.status, 409);
    assert.equal(enrichRes.body.code, "REFRESH_IN_REVIEW");
    const directJobs = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "enrichment"), eq(asyncJobsTable.dedupeKey, `enrichment:fact:${fact.id}`)));
    assert.equal(directJobs.length, 0, "no direct re-enrich job may be enqueued while frozen");

    // The live layers are exactly as they were.
    const [frozen] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(frozen.enrichment, fact.enrichment);
    assert.deepEqual(frozen.enrichmentOverrides, fact.enrichmentOverrides);

    // Resolve the cycle (reject) → the freeze lifts.
    const rejectRes = await request(app)
      .post(`/admin/reviews/${reviewId}/reject`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ rejectionReason: "lame" });
    assert.equal(rejectRes.status, 200);

    const putAfter = await request(app)
      .put(`/admin/facts/${fact.id}/enrichment-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/visualComplexity", value: "low" });
    assert.equal(putAfter.status, 200, JSON.stringify(putAfter.body));
  });
});

// ── Generic fact-enrichment guards (refresh-aware) ───────────────────────────

describe("processing signature stamping (PR3)", () => {
  async function setEngineRevision(value: number): Promise<void> {
    await db
      .insert(adminConfigTable)
      .values({ key: "engine_revision", value: String(value), dataType: "integer", label: "Engine Revision (test)" })
      .onConflictDoUpdate({ target: adminConfigTable.key, set: { value: String(value) } });
    bustConfigCache();
  }

  afterEach(async () => {
    // Restore the seed default so other suites read a stable engine revision.
    await setEngineRevision(1);
  });

  it("stamps the candidate with the engine revision captured BEFORE classify; promote copies it onto facts", async () => {
    await setEngineRevision(5);
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });
    const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
      classify: async () => {
        // A "Mark major update" landing mid-classify must NOT change the stamp.
        await setEngineRevision(6);
        return REFRESHED_AI_BASELINE;
      },
    });
    assert.equal(result.ok, true);
    // Enrichment lands at Step 2 (concept_review); advance to Step 3 to promote.
    await db.update(pendingReviewsTable).set({ workflowStage: "production_review" })
      .where(eq(pendingReviewsTable.id, reviewId));

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    const sig = candidate.signature as ProcessingSignature;
    assert.equal(sig.engineRevision, 5, "pre-classify revision, not the mid-classify bump");
    assert.deepEqual(sig, currentProcessingSignature(5));

    // Promote copies the candidate's signature onto facts.last_processed_signature.
    // (Author the required Visual Concept AFTER the signature assertions above, so those
    // read the classify-time stamp; the concept save doesn't re-stamp the engine revision.)
    await authorConceptForCycle(reviewId, candidateVersionId);
    __setPlanGeneratorForTest(async () => makePlanOutput("strong") as never);
    const approve = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(f.lastProcessedSignature, sig, "promote copied the candidate's classify-time signature");
  });

  it("first-time staging prep stamps facts.last_processed_signature fresh; a live re-enrich never stamps", async () => {
    await setEngineRevision(4);

    // (a) First-time staging cycle: unresolved prep_pending review, candidateVersionId null.
    const [staging] = await db
      .insert(factsTable)
      .values({ text: "{NAME} first-time staging fact", submittedById: submitterId, isActive: false })
      .returning();
    insertedFactIds.push(staging.id);
    await db.insert(pendingReviewsTable).values({
      submittedText: staging.text, status: "pending", workflowStage: "prep_pending",
      stagingFactId: staging.id, candidateVersionId: null,
    });
    const resA = await runEnrichmentForFact(staging.id, { classify: async () => REFRESHED_AI_BASELINE });
    assert.equal(resA.ok, true);
    const [fStaging] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.deepEqual(
      fStaging.lastProcessedSignature,
      currentProcessingSignature(4),
      "first-time staging stamps the current signature (newly-approved facts read fresh, not stale-for-reprocess)",
    );

    // (b) Live re-enrich of an existing active fact: NEVER stamps (refresh-first).
    const live = await seedActiveFact();
    assert.equal(live.lastProcessedSignature, null, "starts unstamped");
    const resB = await runEnrichmentForFact(live.id, { classify: async () => REFRESHED_AI_BASELINE });
    assert.equal(resB.ok, true);
    const [fLive] = await db.select().from(factsTable).where(eq(factsTable.id, live.id));
    assert.equal(fLive.lastProcessedSignature, null, "a direct live re-enrich leaves the signature untouched");
  });
});

describe("generic fact-enrichment guards", () => {
  it("findUnresolvedReviewForStagingFact ignores resolved rows and picks the newest unresolved cycle", async () => {
    const fact = await seedActiveFact();
    await db.insert(pendingReviewsTable).values({
      submittedText: fact.text,
      status: "approved",
      workflowStage: "production_approved",
      stagingFactId: fact.id,
      createdAt: new Date(Date.now() - 60_000),
    });
    assert.equal(await findUnresolvedReviewForStagingFact(fact.id), null, "resolved rows never count");

    const [unresolved] = await db.insert(pendingReviewsTable).values({
      submittedText: fact.text,
      status: "pending",
      workflowStage: "prep_pending",
      stagingFactId: fact.id,
      candidateVersionId: null,
      createdAt: new Date(),
    }).returning();
    const found = await findUnresolvedReviewForStagingFact(fact.id);
    assert.equal(found?.id, unresolved.id);
    assert.equal(found?.candidateVersionId, null);
  });

  it("resolved cycles never poison live re-enrich: approved refresh, rejected refresh, first-time approval", async () => {
    // (a) Rejected refresh, then re-enrich.
    const factA = await seedActiveFact();
    const a = await seedReadyRefreshCycle(factA);
    await request(makeApp())
      .post(`/admin/reviews/${a.reviewId}/reject`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ rejectionReason: "lame" });
    let classifiedA = false;
    const resA = await runEnrichmentForFact(factA.id, {
      classify: async () => { classifiedA = true; return REFRESHED_AI_BASELINE; },
    });
    assert.equal(resA.ok, true);
    assert.equal(classifiedA, true, "live fact must re-enrich after a rejected refresh");
    const [fA] = await db.select().from(factsTable).where(eq(factsTable.id, factA.id));
    assert.equal(fA.enrichmentStatus, "ok", "no stranded 'classifying…' pill");

    // (b) Promoted (approved) refresh, then re-enrich.
    const factB = await seedActiveFact();
    const b = await seedReadyRefreshCycle(factB);
    await authorConceptForCycle(b.reviewId, b.candidateVersionId);
    const approve = await request(makeApp())
      .post(`/admin/reviews/${b.reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    let classifiedB = false;
    const resB = await runEnrichmentForFact(factB.id, {
      classify: async () => { classifiedB = true; return REFRESHED_AI_BASELINE; },
    });
    assert.equal(resB.ok, true);
    assert.equal(classifiedB, true, "live fact must re-enrich after an approved refresh");

    // (c) Plain first-time production_approved fact (the latent pre-refresh bug).
    const factC = await seedActiveFact();
    await db.insert(pendingReviewsTable).values({
      submittedText: factC.text, status: "approved", workflowStage: "production_approved",
      stagingFactId: factC.id, approvedFactId: factC.id,
    });
    let classifiedC = false;
    const resC = await runEnrichmentForFact(factC.id, {
      classify: async () => { classifiedC = true; return REFRESHED_AI_BASELINE; },
    });
    assert.equal(resC.ok, true);
    assert.equal(classifiedC, true, "a first-time approved fact must re-enrich");
  });

  it("RACE: a generic fact job during an unresolved refresh cycle skips everything; the candidate job owns the cycle", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });

    // The stale generic enrichment:fact:<id> job (queued before send-back) runs now.
    let classifyCalled = false;
    const result = await runEnrichmentForFact(fact.id, {
      classify: async () => { classifyCalled = true; return REFRESHED_AI_BASELINE; },
    });
    assert.equal(result.ok, true, "retires as a successful no-op");
    assert.equal(classifyCalled, false, "no paid classification during a refresh cycle");
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(f.enrichment, fact.enrichment, "live facts.* untouched");
    assert.deepEqual(f.enrichmentAiDerived, fact.enrichmentAiDerived);
    assert.equal(f.primaryArchetype, fact.primaryArchetype);
    assert.deepEqual(f.lastProcessedSignature, fact.lastProcessedSignature);
    const [rev] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(rev.workflowStage, "prep_pending", "the refresh cycle was NOT advanced");
    const [cand] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(cand.enrichment, null, "candidate stays unfilled by the generic job");

    // A generic-outcome advancement can never move a refresh cycle either.
    await advanceReviewForStagingFactEnrichment({ factId: fact.id, outcome: "success" });
    const [rev2] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(rev2.workflowStage, "prep_pending");

    // The version-targeted job then fills the candidate and advances THAT cycle.
    const candResult = await runEnrichmentForCandidateVersion(candidateVersionId, {
      classify: async () => REFRESHED_AI_BASELINE,
    });
    assert.equal(candResult.ok, true);
    const [rev3] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(rev3.workflowStage, "concept_review");
    const [cand2] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.ok(cand2.enrichment, "candidate filled by its own job");
  });

  it("RACE (mid-classify): a send-back landing DURING a live re-enrich discards the stale result", async () => {
    const fact = await seedActiveFact();
    let raceCycle: { reviewId: number; candidateVersionId: number } | null = null;

    // The generic job passes its pre-classify guard (no cycle yet), then the
    // send-back commits WHILE the "LLM call" is in flight.
    const result = await runEnrichmentForFact(fact.id, {
      classify: async () => {
        raceCycle = await sendFactBackToReview({ factId: fact.id, adminId });
        return REFRESHED_AI_BASELINE;
      },
    });
    assert.equal(result.ok, true, "retires as a successful no-op");
    assert.ok(raceCycle, "the send-back succeeded mid-classify");

    // The stale classification was DISCARDED at the transactional recheck.
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(f.enrichment, fact.enrichment, "live facts.* untouched by the stale result");
    assert.deepEqual(f.enrichmentAiDerived, fact.enrichmentAiDerived);
    assert.equal(f.enrichmentStatus, "pending", "the refresh cycle owns the pill now");

    // The refresh cycle proceeds normally from here.
    const { reviewId, candidateVersionId } = raceCycle!;
    const [rev] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(rev.workflowStage, "prep_pending", "the cycle was not advanced by the generic outcome");
    const candResult = await runEnrichmentForCandidateVersion(candidateVersionId, {
      classify: async () => REFRESHED_AI_BASELINE,
    });
    assert.equal(candResult.ok, true);
    const [cand] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.ok(cand.enrichment, "candidate filled by its own job");
  });

  it("abandoned first-time staging facts still skip late enrichment and pexels retries", async () => {
    const [staging] = await db.insert(factsTable)
      .values({ text: "{NAME} abandoned staging", submittedById: submitterId, isActive: false })
      .returning();
    insertedFactIds.push(staging.id);
    await db.insert(pendingReviewsTable).values({
      submittedText: staging.text, status: "rejected", workflowStage: "production_rejected", stagingFactId: staging.id,
    });

    assert.deepEqual(
      await resolveGenericFactEnrichmentDecision(staging.id),
      { action: "skip", reason: "inactive_staging" },
    );
    let classifyCalled = false;
    const result = await runEnrichmentForFact(staging.id, {
      classify: async () => { classifyCalled = true; return REFRESHED_AI_BASELINE; },
    });
    assert.equal(result.ok, true);
    assert.equal(classifyCalled, false, "no paid work on an abandoned staging fact");
    assert.equal(await isStagingImagePrepActive(staging.id), false, "pexels retries skip too");

    // A live fact with only resolved history stays image-prep-eligible.
    const live = await seedActiveFact();
    assert.equal(await isStagingImagePrepActive(live.id), true);
  });
});
