/**
 * Integration tests for the Step-2 (Visual Concept) transition endpoints:
 *   POST /admin/reviews/:id/approve-visual-concept
 *   POST /admin/reviews/:id/back-to-visual-concept
 *
 * Covers the gag gate's distinct 409 codes, the stale-but-saved allowance, the
 * atomic compare-and-set (concurrent approvals → exactly one force batch), and
 * the Step-3 → Step-2 bounce. Renders are only ENQUEUED (no worker in tests), so
 * we assert on the force `review_render_scenarios_prepare` job row (no dedupe key)
 * rather than finished images. Seeds under the `t_avc_` user prefix.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, asyncJobsTable, imagePromptAttemptsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import {
  type FactEnrichment,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
} from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_avc_";
const TEST_FILE_START = new Date();
const PREPARE_QUEUE = "review_render_scenarios_prepare";

/** A valid enrichment carrying a saved, enabled, non-empty Visual Concept. */
function enrichmentWithConcept(coreScene: string | null): FactEnrichment {
  return {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["strength", "legendary", "earth"],
    taxonomyConfidence: 0.95,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    visualPromptStrategyOverride: {
      ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
      coreSceneOverride: coreScene ?? "",
    },
  } as FactEnrichment;
}

const insertedFactIds: number[] = [];

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  return app;
}

async function createUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
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

async function bearer(userId: string, isAdmin: boolean): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId, membershipTier: isAdmin ? "legendary" : "registered" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin,
    captchaVerified: true,
  };
  return createSession(sessionData, userId);
}

async function seedReview(opts: {
  submittedById: string;
  stage: string;
  enrichment?: unknown;
  visualConceptStatus?: "pending" | "ok" | "failed" | null;
  withStaging?: boolean;
}): Promise<{ reviewId: number; stagingFactId: number | null }> {
  let stagingFactId: number | null = null;
  if (opts.withStaging !== false) {
    const [fact] = await db
      .insert(factsTable)
      .values({
        text: "{NAME} bench-presses the Earth.",
        submittedById: opts.submittedById,
        isActive: false,
        enrichment: (opts.enrichment ?? enrichmentWithConcept("A hero hoists the planet overhead.")) as FactEnrichment,
        visualConceptStatus: opts.visualConceptStatus ?? null,
      })
      .returning({ id: factsTable.id });
    stagingFactId = fact!.id;
    insertedFactIds.push(stagingFactId);
  }
  const [review] = await db
    .insert(pendingReviewsTable)
    .values({
      submittedText: "{NAME} bench-presses the Earth.",
      submittedById: opts.submittedById,
      matchingSimilarity: 0,
      status: "pending",
      workflowStage: opts.stage as never,
      stagingFactId,
    })
    .returning({ id: pendingReviewsTable.id });
  return { reviewId: review!.id, stagingFactId };
}

async function seedReviewRenderAttempt(reviewId: number, factId: number): Promise<number> {
  const [attempt] = await db
    .insert(imagePromptAttemptsTable)
    .values({
      factId,
      userId: null,
      renderJobId: randomUUID(),
      requestId: `test-avc-render:${reviewId}:${randomUUID()}`,
      generationMode: "t2i",
      subjectRenderMode: "t2i_fallback",
      targetEngine: "nano_banana_2",
      sourceImageAnalysis: {
        subjectKind: "none",
        confidence: "high",
        hasUsableHumanFace: false,
        hasUsableSubject: false,
        subjectCount: 0,
        subjectDescription: "test",
        suggestedRenderMode: "t2i_fallback",
        warnings: [],
        classificationMethod: "manual_user_choice",
        analyzerVersion: "test",
      },
      identityPolicy: { mode: "none" },
      renderControls: {
        aspectRatio: "portrait",
        contentMode: "sfw",
        fallbackSubjectGender: "neutral",
        mirrorToLegacyStorage: false,
        reviewAudit: { reviewId, adminUserId: adminId },
      },
      factEnrichmentSnapshot: enrichmentWithConcept("A prior concept."),
      renderedFactText: "Alex Franklin bench-presses the Earth.",
      archetypeStrategyVersion: "v2",
      generatedImageObjectPath: "review-renders/test.png",
      reviewId,
      reviewRenderScenarioKey: "generic_t2i",
      reviewRenderInputHash: "old-input-hash",
      reviewRenderBatchId: `old-batch-${randomUUID()}`,
    })
    .returning({ id: imagePromptAttemptsTable.id });
  return attempt!.id;
}

async function prepareJobsFor(reviewId: number): Promise<{ id: number; dedupeKey: string | null }[]> {
  const rows = await db
    .select({ id: asyncJobsTable.id, dedupeKey: asyncJobsTable.dedupeKey, payload: asyncJobsTable.payload })
    .from(asyncJobsTable)
    .where(and(eq(asyncJobsTable.queue, PREPARE_QUEUE), gte(asyncJobsTable.createdAt, TEST_FILE_START)));
  return rows
    .filter((r) => (r.payload as { reviewId?: number })?.reviewId === reviewId)
    .map((r) => ({ id: r.id, dedupeKey: r.dedupeKey }));
}

let adminId: string;
let plainId: string;
let adminSid: string;
let plainSid: string;

async function cleanup() {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  insertedFactIds.length = 0;
}

before(async () => {
  await cleanup();
  adminId = await createUser({ isAdmin: true });
  plainId = await createUser({ isAdmin: false });
  adminSid = await bearer(adminId, true);
  plainSid = await bearer(plainId, false);
});

after(async () => {
  await cleanup();
  await db
    .delete(asyncJobsTable)
    .where(and(eq(asyncJobsTable.queue, PREPARE_QUEUE), gte(asyncJobsTable.createdAt, TEST_FILE_START)));
});

describe("POST /admin/reviews/:id/approve-visual-concept — preconditions", () => {
  it("403 for a non-admin", async () => {
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "ok" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${plainSid}`).send({});
    assert.equal(res.status, 403);
  });

  it("409 CONCEPT_STAGE_ALREADY_ADVANCED from the wrong stage (production_review)", async () => {
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "production_review", visualConceptStatus: "ok" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "CONCEPT_STAGE_ALREADY_ADVANCED");
  });

  it("succeeds with a non-empty saved Visual Concept (presence-based — no enable toggle)", async () => {
    const { reviewId } = await seedReview({
      submittedById: adminId, stage: "concept_review", visualConceptStatus: "ok",
      enrichment: enrichmentWithConcept("A hero hoists the planet overhead."),
    });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 200);
  });

  it("409 CONCEPT_MISSING when the concept is blank", async () => {
    const blank = enrichmentWithConcept("A hero hoists the planet.");
    (blank.visualPromptStrategyOverride as { coreSceneOverride: string }).coreSceneOverride = "   ";
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "ok", enrichment: blank });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "CONCEPT_MISSING");
  });

  it("409 IDEAS_PENDING while visual ideas are still generating", async () => {
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "pending" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "IDEAS_PENDING");
  });

  it("409 IDEAS_NOT_GENERATED when ideas failed / never ran", async () => {
    const failed = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "failed" });
    const r1 = await request(makeApp()).post(`/admin/reviews/${failed.reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(r1.status, 409);
    assert.equal(r1.body.code, "IDEAS_NOT_GENERATED");

    const never = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: null });
    const r2 = await request(makeApp()).post(`/admin/reviews/${never.reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(r2.status, 409);
    assert.equal(r2.body.code, "IDEAS_NOT_GENERATED");
  });
});

describe("POST /admin/reviews/:id/approve-visual-concept — happy path + concurrency", () => {
  it("advances to production_review and force-enqueues a no-dedupe prepare job", async () => {
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "ok" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.workflowStage, "production_review");
    assert.equal(res.body.forceRenderBatch, true);

    const [row] = await db.select({ stage: pendingReviewsTable.workflowStage }).from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(row!.stage, "production_review");

    const jobs = await prepareJobsFor(reviewId);
    assert.equal(jobs.length, 1, "exactly one force prepare job");
    assert.equal(jobs[0]!.dedupeKey, null, "force job has NO dedupe key");
  });

  it("stale-but-saved concept still advances (visualConcepts.current false is allowed)", async () => {
    // A saved concept + ok ideas is enough; staleness of the AI cards never blocks.
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "ok" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.workflowStage, "production_review");
  });

  it("two concurrent approvals → exactly one advances, one 409s, exactly one force batch", async () => {
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "ok" });
    const [a, b] = await Promise.all([
      request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({}),
      request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({}),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `expected one 200 + one 409, got ${statuses}`);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.code, "CONCEPT_STAGE_ALREADY_ADVANCED");

    const jobs = await prepareJobsFor(reviewId);
    assert.equal(jobs.length, 1, "exactly one force prepare job despite two approvals");
  });
});

describe("POST /admin/reviews/:id/back-to-visual-concept", () => {
  it("403 for a non-admin", async () => {
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "production_review", visualConceptStatus: "ok" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/back-to-visual-concept`).set("authorization", `Bearer ${plainSid}`).send({});
    assert.equal(res.status, 403);
  });

  it("409 from a stage other than production_review", async () => {
    const { reviewId } = await seedReview({ submittedById: adminId, stage: "concept_review", visualConceptStatus: "ok" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/back-to-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 409);
  });

  it("bounces production_review → concept_review; re-approval clears prior renders and force-creates a fresh batch", async () => {
    const { reviewId, stagingFactId } = await seedReview({ submittedById: adminId, stage: "production_review", visualConceptStatus: "ok" });
    assert.ok(stagingFactId);
    const priorAttemptId = await seedReviewRenderAttempt(reviewId, stagingFactId);

    const back = await request(makeApp()).post(`/admin/reviews/${reviewId}/back-to-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(back.status, 200);
    assert.equal(back.body.workflowStage, "concept_review");

    const reApprove = await request(makeApp()).post(`/admin/reviews/${reviewId}/approve-visual-concept`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(reApprove.status, 200);
    assert.equal(reApprove.body.forceRenderBatch, true);
    assert.equal(reApprove.body.clearedRenderAttempts, 1);

    const [priorAttempt] = await db
      .select({ reviewId: imagePromptAttemptsTable.reviewId })
      .from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.id, priorAttemptId));
    assert.equal(priorAttempt!.reviewId, null, "the superseded render is detached from the active review grid");

    const jobs = await prepareJobsFor(reviewId);
    assert.ok(jobs.length >= 1, "re-approval scheduled a fresh force prepare job");
    assert.ok(jobs.every((j) => j.dedupeKey === null), "all force jobs are keyless");
  });
});
