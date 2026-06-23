/**
 * Integration tests for routes/reviews.ts.
 *
 * Covers:
 * - POST /facts/submit-review (auth + onboarding gate + Zod + grammar)
 * - GET /admin/reviews + /count (admin auth and read)
 * - GET /admin/reviews/:id (admin auth, 400 / 404 / success)
 * - POST /admin/reviews/:id/reject (admin auth, 404 / 409 / success)
 * - POST /admin/reviews/:id/approve-variant (admin auth, 404 / 409,
 *   parent-not-found, success)
 * - GET /activity-feed + /mark-read (user auth)
 *
 * The full /approve success path is left out — it kicks off the
 * Pexels image pipeline, which needs external API access.
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
  activityFeedTable,
  asyncJobsTable,
} from "@workspace/db/schema";
import { and, eq, gte, like, sql, count, inArray } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import reviewsRouter, { __setPlanGeneratorForTest } from "../routes/reviews.js";
import { FACT_SUBMIT_PENDING_CAP } from "../lib/rateLimit.js";
import { runEnrichmentForFact } from "../lib/enrichmentJobs.js";
import { runFactPexelsJob, factPexelsJobHandler } from "../lib/factPexelsJobs.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

// A minimal valid render-time plan output the Nano Banana compiler accepts.
// `rating` is overridable so a test can simulate the "poor" (unrenderable) case.
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
        subjectRenderMode: "human_identity_i2i",
        identityPreservation: "human_face",
        nonhumanSubjectTreatment: {
          applicable: false,
          subjectKind: "not_applicable",
          preserveTraits: [],
          anthropomorphicTreatment: "none",
          doNotTransformIntoHuman: false,
        },
        fallbackSubjectGender: "not_applicable",
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
      generationMode: "i2i" as const,
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

const VALID_APPROVAL_ENRICHMENT: FactEnrichment = {
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


const USER_PREFIX = "t_routes_rv_";

// Capture start time so the after() hook can delete only outbox rows that
// this test file created, without disturbing rows from other concurrent tests.
const TEST_FILE_START = new Date();

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  return app;
}

async function createTestUser(opts: {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
  captchaVerified?: boolean;
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
    membershipTier: opts.membershipTier ?? "registered",
    // Default to true so the onboarding gate is bypassed in most tests.
    // The middleware ORs DB and session captchaVerified, so tests that
    // need the gate to fire must set this to false here.
    captchaVerified: opts.captchaVerified ?? true,
  });
  return id;
}

async function bearerForUser(userId: string, opts: {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
  captchaVerified?: boolean;
} = {}): Promise<string> {
  const sessionData: SessionData = {
    user: {
      id: userId,
      membershipTier: opts.membershipTier ?? "registered",
    } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: opts.isAdmin,
    captchaVerified: opts.captchaVerified ?? true,
  };
  return createSession(sessionData, userId);
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(activityFeedTable).where(eq(activityFeedTable.userId, u.id));
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

// Every test must restore the live plan generator so a stub can't leak across
// tests.
afterEach(() => __setPlanGeneratorForTest(null));

// Delete any admin-notify outbox rows queued by this test file so the email
// worker doesn't deliver them to real inboxes. Filtered by kind and start
// time to avoid touching rows from other concurrently-running test files.
after(async () => {
  await db
    .delete(asyncJobsTable)
    .where(
      and(
        eq(asyncJobsTable.queue, "email"),
        gte(asyncJobsTable.createdAt, TEST_FILE_START),
        sql`${asyncJobsTable.payload}->>'kind' = ${"admin_fact_notify"}`,
      ),
    );
});

describe("POST /facts/submit-review", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .send({ text: "hello world here is a fact" });
    assert.equal(res.status, 401);
  });

  it("returns 403 ONBOARDING_REQUIRED for non-admin/non-legendary/non-captcha users", async () => {
    const userId = await createTestUser({ captchaVerified: false });
    const sid = await bearerForUser(userId, { captchaVerified: false });
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this fact is at least ten chars" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "ONBOARDING_REQUIRED");
  });

  it("returns 400 when text is too short", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "short" });
    assert.equal(res.status, 400);
  });

  it("returns 422 when the template has invalid grammar", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this fact uses a {NESTED}{FOO} bad token" });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /grammar validation failed/);
  });

  it("happy path: inserts a triage_pending review with NO paid prep and returns 201", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this is a perfectly fine fact for testing." });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.reviewId, "number");

    const [row] = await db
      .select()
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.ok(row);
    assert.equal(row.status, "pending");
    assert.equal(row.submittedById, userId);
    // COST GATE: the new submission must not trigger any paid prep.
    assert.equal(row.workflowStage, "triage_pending");
    assert.equal(row.enrichment, null);
    assert.equal(row.enrichmentStatus, null);
  });

  it("COST GATE: submission enqueues no enrichment / pexels / embedding jobs", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "another perfectly fine fact for the no-cost check." });
    assert.equal(res.status, 201);
    const reviewId: number = res.body.reviewId;

    const paidJobs = await db
      .select({ id: asyncJobsTable.id, queue: asyncJobsTable.queue })
      .from(asyncJobsTable)
      .where(
        and(
          inArray(asyncJobsTable.queue, ["enrichment", "fact_pexels"]),
          sql`${asyncJobsTable.payload}->>'reviewId' = ${String(reviewId)}`,
        ),
      );
    assert.equal(paidJobs.length, 0, "submission must not enqueue paid prep jobs");
  });

  it("PENDING CAP: returns 429 PENDING_CAP_REACHED when the user is at the unresolved cap", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    // Seed exactly the cap's worth of unresolved (triage_pending) reviews.
    await db.insert(pendingReviewsTable).values(
      Array.from({ length: FACT_SUBMIT_PENDING_CAP }, () => ({
        submittedText: `cap filler ${randomUUID()}`,
        submittedById: userId,
        status: "pending" as const,
        workflowStage: "triage_pending" as const,
      })),
    );

    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this submission should be rejected by the cap." });
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "PENDING_CAP_REACHED");

    // No extra row was created past the cap.
    const [{ value: total }] = await db
      .select({ value: count() })
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.submittedById, userId));
    assert.equal(total, FACT_SUBMIT_PENDING_CAP);
  });

  it("PENDING CAP: terminal-stage reviews do NOT count against the cap", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    // Cap-1 unresolved + several terminal rows that must not count.
    await db.insert(pendingReviewsTable).values([
      ...Array.from({ length: FACT_SUBMIT_PENDING_CAP - 1 }, () => ({
        submittedText: `unresolved ${randomUUID()}`,
        submittedById: userId,
        status: "pending" as const,
        workflowStage: "triage_pending" as const,
      })),
      { submittedText: `done ${randomUUID()}`, submittedById: userId, status: "approved" as const, workflowStage: "production_approved" as const },
      { submittedText: `rej ${randomUUID()}`, submittedById: userId, status: "rejected" as const, workflowStage: "triage_rejected" as const },
    ]);

    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this should be allowed: only cap-1 are unresolved." });
    assert.equal(res.status, 201);
  });
});

describe("POST /admin/reviews/:id/provisional-approve", () => {
  async function seedTriageReview(submitterId: string, text = "{NAME} bench-presses the Earth."): Promise<number> {
    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: text,
      submittedById: submitterId,
      status: "pending",
      workflowStage: "triage_pending",
    }).returning();
    return r.id;
  }

  async function enrichmentJobsForFact(factId: number) {
    return db
      .select({ id: asyncJobsTable.id })
      .from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "enrichment"), sql`${asyncJobsTable.payload}->>'factId' = ${String(factId)}`));
  }

  async function pexelsJobsForFact(factId: number) {
    return db
      .select({ id: asyncJobsTable.id })
      .from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "fact_pexels"), sql`${asyncJobsTable.payload}->>'factId' = ${String(factId)}`));
  }

  it("creates exactly one inactive staging fact, enters prep_pending, enqueues one enrichment job", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const reviewId = await seedTriageReview(submitterId);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/provisional-approve`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.workflowStage, "prep_pending");
    const stagingFactId: number = res.body.stagingFactId;
    assert.equal(typeof stagingFactId, "number");

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, stagingFactId));
    assert.equal(fact.isActive, false, "staging fact must be inactive");
    assert.equal(fact.parentId, null);
    assert.equal(fact.pexelsStatus, "pending", "image prep marked pending so the UI shows working");

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.workflowStage, "prep_pending");
    assert.equal(r.stagingFactId, stagingFactId);

    const jobs = await enrichmentJobsForFact(stagingFactId);
    assert.equal(jobs.length, 1, "exactly one fact-backed enrichment job");
    const pexels = await pexelsJobsForFact(stagingFactId);
    assert.equal(pexels.length, 1, "exactly one fact-backed pexels job");
  });

  it("is idempotent on re-click: no second fact, no duplicate job", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const reviewId = await seedTriageReview(submitterId);

    const first = await request(makeApp()).post(`/admin/reviews/${reviewId}/provisional-approve`).set("authorization", `Bearer ${sid}`).send({});
    const stagingFactId: number = first.body.stagingFactId;

    const second = await request(makeApp()).post(`/admin/reviews/${reviewId}/provisional-approve`).set("authorization", `Bearer ${sid}`).send({});
    assert.equal(second.status, 200);
    assert.equal(second.body.stagingFactId, stagingFactId);
    assert.equal(second.body.alreadyPrepping, true);

    const facts = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.submittedById, submitterId));
    assert.equal(facts.length, 1, "no second staging fact");
    const jobs = await enrichmentJobsForFact(stagingFactId);
    assert.equal(jobs.length, 1, "no duplicate enrichment job");
    const pexels = await pexelsJobsForFact(stagingFactId);
    assert.equal(pexels.length, 1, "no duplicate pexels job");
  });

  it("as variant: sets parentId and still enqueues fact-backed enrichment", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const [parent] = await db.insert(factsTable).values({ text: "{NAME} parent", submittedById: adminId, isActive: true }).returning();
    const reviewId = await seedTriageReview(submitterId);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/provisional-approve`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: parent.id });
    assert.equal(res.status, 200);
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, res.body.stagingFactId));
    assert.equal(fact.parentId, parent.id);
    assert.equal(fact.isActive, false);
    const jobs = await enrichmentJobsForFact(res.body.stagingFactId);
    assert.equal(jobs.length, 1);
  });

  it("returns 404 when the variant parent is missing/inactive", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const reviewId = await seedTriageReview(submitterId);
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/provisional-approve`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 999999 });
    assert.equal(res.status, 404);
  });

  it("returns 409 for a terminal (already-decided) review", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "already live", submittedById: submitterId, status: "approved", workflowStage: "production_approved",
    }).returning();
    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/provisional-approve`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 409);
  });
});

describe("staging-fact enrichment stage advancement", () => {
  it("success advances the linked review prep_pending → production_review", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} lifts a car", submittedById: submitterId, isActive: false }).returning();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} lifts a car", submittedById: submitterId, status: "pending",
      workflowStage: "prep_pending", stagingFactId: fact.id,
    }).returning();

    const result = await runEnrichmentForFact(fact.id, { classify: async () => VALID_APPROVAL_ENRICHMENT });
    assert.equal(result.ok, true);

    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.enrichmentStatus, "ok");
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "production_review");
  });

  it("COST GUARD: skips classification when the linked review left prep_pending", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} runs fast", submittedById: submitterId, isActive: false }).returning();
    await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} runs fast", submittedById: submitterId, status: "rejected",
      workflowStage: "production_rejected", stagingFactId: fact.id,
    });

    let classifyCalled = false;
    const result = await runEnrichmentForFact(fact.id, {
      classify: async () => { classifyCalled = true; return VALID_APPROVAL_ENRICHMENT; },
    });
    assert.equal(result.ok, true);
    assert.equal(classifyCalled, false, "no paid classification after the review left prep_pending");
  });

  it("live-fact re-enrich (no linked review) still classifies normally", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} jumps high", submittedById: submitterId, isActive: true }).returning();
    let classifyCalled = false;
    const result = await runEnrichmentForFact(fact.id, {
      classify: async () => { classifyCalled = true; return VALID_APPROVAL_ENRICHMENT; },
    });
    assert.equal(result.ok, true);
    assert.equal(classifyCalled, true);
  });
});

describe("fact_pexels durable image-prep queue", () => {
  it("success: seeds images, leaves the workflow stage untouched (Pexels never gates)", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} surfs a tsunami", submittedById: submitterId, isActive: false, pexelsStatus: "pending" }).returning();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} surfs a tsunami", submittedById: submitterId, status: "pending",
      workflowStage: "prep_pending", stagingFactId: fact.id,
    }).returning();

    let seedCalled = false;
    const result = await runFactPexelsJob(fact.id, {
      seed: async (id) => {
        seedCalled = true;
        // Mirror seedFactPexelsImagesOnce's terminal write so the assertion is real.
        await db.update(factsTable).set({ pexelsStatus: "ok", pexelsImages: { fact_type: "action", male: [], female: [], neutral: [] } }).where(eq(factsTable.id, id));
      },
    });
    assert.equal(result.ok, true);
    assert.equal(seedCalled, true);

    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.pexelsStatus, "ok");
    // Image prep does NOT advance the review — enrichment owns that gate.
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "prep_pending");
  });

  it("COST GUARD: skips paid image seeding when the linked review left prep_pending", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} tames a dragon", submittedById: submitterId, isActive: false, pexelsStatus: "pending" }).returning();
    await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} tames a dragon", submittedById: submitterId, status: "rejected",
      workflowStage: "production_rejected", stagingFactId: fact.id,
    });

    let seedCalled = false;
    const result = await runFactPexelsJob(fact.id, { seed: async () => { seedCalled = true; } });
    assert.equal(result.ok, true);
    assert.equal(seedCalled, false, "no paid Pexels/OpenAI work after the review left prep_pending");
  });

  it("retryable failure: returns error and leaves pexels_status pending (still running, not failed)", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} outruns light", submittedById: submitterId, isActive: false, pexelsStatus: "pending" }).returning();
    await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} outruns light", submittedById: submitterId, status: "pending",
      workflowStage: "prep_pending", stagingFactId: fact.id,
    });

    const result = await runFactPexelsJob(fact.id, { seed: async () => { throw new Error("pexels 503"); } });
    assert.equal(result.ok, false);

    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.pexelsStatus, "pending", "a retryable failure must NOT mark failed — that's reserved for abandon");
  });

  it("onAbandon: marks pexels_status failed without touching the workflow stage", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} bottles lightning", submittedById: submitterId, isActive: false, pexelsStatus: "pending" }).returning();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bottles lightning", submittedById: submitterId, status: "pending",
      workflowStage: "production_review", stagingFactId: fact.id,
    }).returning();

    await factPexelsJobHandler.onAbandon!({ payload: { factId: fact.id }, id: 999 } as never);

    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.pexelsStatus, "failed");
    // Abandon must not regress/advance the moderation stage — moderator can still approve.
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "production_review");
  });
});

describe("GET /admin/reviews/count", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/reviews/count");
    assert.equal(res.status, 401);
  });

  it("returns 403 for non-admin users", async () => {
    const userId = await createTestUser({ isAdmin: false });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/admin/reviews/count")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 403);
  });

  it("returns the pending count for admins", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    await db.insert(pendingReviewsTable).values([
      { submittedText: "pending one", submittedById: submitterId, status: "pending" },
      { submittedText: "approved one", submittedById: submitterId, status: "approved" },
    ]);

    const res = await request(makeApp())
      .get("/admin/reviews/count")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 1);
  });
});

describe("GET /admin/reviews", () => {

  it("returns paginated reviews for admins", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    await db.insert(pendingReviewsTable).values([
      { submittedText: `pending ${randomUUID()}`, submittedById: submitterId, status: "pending" },
    ]);

    const res = await request(makeApp())
      .get("/admin/reviews")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.reviews));
    assert.equal(typeof res.body.total, "number");
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 20);
  });
});

describe("GET /admin/reviews/:id", () => {

  it("returns 400 for a non-numeric id", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .get("/admin/reviews/abc")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
  });

  it("returns 404 when no review matches", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .get("/admin/reviews/999999")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 404);
  });

  it("returns the hydrated review on success", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "details please",
      submittedById: submitterId,
      status: "pending",
    }).returning();

    const res = await request(makeApp())
      .get(`/admin/reviews/${r.id}`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, r.id);
    assert.equal(res.body.submittedText, "details please");
    assert.equal(res.body.submitter?.id, submitterId);
  });
});

describe("POST /admin/reviews/:id/reject", () => {

  it("returns 404 when the review doesn't exist", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/999999/reject")
      .set("authorization", `Bearer ${sid}`)
      .send({ rejectionReason: "spam" });
    assert.equal(res.status, 404);
  });

  it("returns 409 when the review has already been decided", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "already approved",
      submittedById: submitterId,
      status: "approved",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rejectionReason: "spam" });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already approved/);
  });

  it("happy path: marks the review rejected", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "to-be-rejected",
      submittedById: submitterId,
      status: "pending",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ adminNote: "doesn't fit", rejectionReason: "spam" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const [after] = await db
      .select()
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, r.id));
    assert.equal(after.status, "rejected");
    assert.equal(after.adminNote, "doesn't fit");
    assert.equal(after.reason, "spam");
    assert.equal(after.reviewedById, adminId);
  });
});

describe("POST /admin/reviews/:id/approve-variant", () => {

  it("returns 400 when parentFactId is missing", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/1/approve-variant")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 400);
  });

  it("returns 404 when the review doesn't exist", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/999999/approve-variant")
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 1 });
    assert.equal(res.status, 404);
  });

  it("returns 404 when the parent fact doesn't exist", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    // A prepped review (production_review + staging fact) so the request reaches
    // the parent-fact check rather than the stage gate.
    const [staging] = await db.insert(factsTable).values({
      text: "variant attempt", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "variant attempt",
      submittedById: submitterId,
      status: "pending",
      workflowStage: "production_review",
      stagingFactId: staging.id,
      enrichment: VALID_APPROVAL_ENRICHMENT,
      enrichmentStatus: "ok",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 999999 });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found or inactive/);
  });

  it("returns 409 when the review has already been decided", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "already-approved",
      submittedById: submitterId,
      status: "approved",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 1 });
    assert.equal(res.status, 409);
  });
});

// ── Approval render preflight ─────────────────────────────────────────────
//
// Approval runs a NON-PERSISTENT renderability preflight (the real runtime
// pipeline over the neutral canonical subject "Alex Jordan"/they-them) BEFORE
// any state mutation. The planner is stubbed via __setPlanGeneratorForTest; the
// real Nano Banana compiler still runs on the stubbed plan.
describe("approval render preflight", () => {
  // A review that has finished prep: it owns an inactive staging fact carrying
  // the effective enrichment, and sits at production_review — the precondition
  // for production approval.
  async function seedPendingReviewWithParent(
    enrichment: FactEnrichment = VALID_APPROVAL_ENRICHMENT,
  ): Promise<{ reviewId: number; parentId: number; stagingFactId: number }> {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const [parent] = await db
      .insert(factsTable)
      .values({ text: "{NAME} parent fact", submittedById: adminId, isActive: true })
      .returning();
    const [staging] = await db
      .insert(factsTable)
      .values({
        text: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        isActive: false,
        enrichment,
      })
      .returning();
    const [review] = await db
      .insert(pendingReviewsTable)
      .values({
        submittedText: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        status: "pending",
        workflowStage: "production_review",
        stagingFactId: staging.id,
        enrichment,
        enrichmentStatus: "ok",
      })
      .returning();
    return { reviewId: review.id, parentId: parent.id, stagingFactId: staging.id };
  }

  it("passes on a non-poor rating and the canonical subject is Alex Jordan / they-them", async () => {
    const { reviewId, parentId } = await seedPendingReviewWithParent();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    let seenFactText = "";
    __setPlanGeneratorForTest(async (input) => {
      seenFactText = input.factText;
      return makePlanOutput("strong") as never;
    });

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: parentId });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    // The preflight rendered the fact text for the neutral canonical subject.
    assert.match(seenFactText, /Alex Jordan/);
    assert.doesNotMatch(seenFactText, /\{NAME\}/);
    assert.doesNotMatch(seenFactText, /David/);

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.status, "approved");
  });

  it("blocks with 400 on a poor rating and leaves the review unchanged", async () => {
    const { reviewId, parentId } = await seedPendingReviewWithParent();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    __setPlanGeneratorForTest(async () => makePlanOutput("poor") as never);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: parentId });

    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /render coherently|achievable/i);

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.status, "pending", "review must NOT be mutated when the preflight blocks");
  });

  it("returns 503 (retryable) on a simulated timeout and leaves the review unchanged", async () => {
    const { reviewId, parentId } = await seedPendingReviewWithParent();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    // The preflight races a ~20s deadline; a planner that never resolves trips
    // the timeout (with one retry, also timing out) → retryable 503.
    __setPlanGeneratorForTest(() => new Promise(() => {}) as never);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: parentId });

    assert.equal(res.status, 503);
    assert.match(String(res.body.error), /retry/i);

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.status, "pending", "review must NOT be mutated on a transient failure");
  });

  it("returns 422 (non-retryable) when the planner throws and leaves the review unchanged", async () => {
    const { reviewId, parentId } = await seedPendingReviewWithParent();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    __setPlanGeneratorForTest(async () => { throw new Error("planner schema validation failed"); });

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: parentId });

    assert.equal(res.status, 422);

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.status, "pending", "review must NOT be mutated when the planner throws");
  });

  it("feeds the moderator override through to the planner input (override-driven case)", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const [parent] = await db
      .insert(factsTable)
      .values({ text: "{NAME} parent fact", submittedById: adminId, isActive: true })
      .returning();
    const overrideEnrichment: FactEnrichment = {
      ...VALID_APPROVAL_ENRICHMENT,
      visualPromptStrategyOverride: {
        version: 1,
        enabled: true,
        requiredVisualDetails: ["{NAME} wearing a glowing crown"],
        forbiddenVisualDetails: [],
        roleBindings: [],
        compositionGuidance: [],
        styleAgnosticPromptAdditions: [],
        negativePromptAdditions: [],
      },
    };
    const [staging] = await db
      .insert(factsTable)
      .values({
        text: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        isActive: false,
        enrichment: overrideEnrichment,
      })
      .returning();
    const [review] = await db
      .insert(pendingReviewsTable)
      .values({
        submittedText: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        status: "pending",
        workflowStage: "production_review",
        stagingFactId: staging.id,
        enrichment: overrideEnrichment,
        enrichmentStatus: "ok",
      })
      .returning();

    let seenRenderPolicy: unknown;
    __setPlanGeneratorForTest(async (input) => {
      seenRenderPolicy = input.renderPolicy;
      return makePlanOutput("strong") as never;
    });

    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: parent.id });

    assert.equal(res.status, 200);
    // resolveRenderPolicy folds the moderator override into the planner input —
    // proving the override reaches the same runtime path as render time.
    assert.ok(seenRenderPolicy, "render policy (with the override folded in) reached the planner");
  });
});

describe("POST /admin/reviews/:id/approve-for-production", () => {
  async function seedProductionReview(): Promise<{ reviewId: number; stagingFactId: number; submitterId: string }> {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Earth.", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Earth.", submittedById: submitterId, status: "pending",
      workflowStage: "production_review", stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    return { reviewId: review.id, stagingFactId: staging.id, submitterId };
  }

  it("activates the staging fact, marks production_approved, and is idempotent", async () => {
    const { reviewId, stagingFactId } = await seedProductionReview();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    __setPlanGeneratorForTest(async () => makePlanOutput("strong") as never);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.factId, stagingFactId);

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, stagingFactId));
    assert.equal(fact.isActive, true, "staging fact must become active");
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.workflowStage, "production_approved");
    assert.equal(r.status, "approved");
    assert.equal(r.approvedFactId, stagingFactId);

    // Idempotent re-call: returns the existing fact, no re-activation.
    const again = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyApproved, true);
    assert.equal(again.body.factId, stagingFactId);
  });

  it("refuses to activate a triage_pending review (no shortcut to live)", async () => {
    const submitterId = await createTestUser();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "not prepped yet", submittedById: submitterId, status: "pending", workflowStage: "triage_pending",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 409);
  });
});

describe("reject after prep → production_rejected", () => {
  it("audits a production rejection and leaves the staging fact inactive", async () => {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} does a thing", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} does a thing", submittedById: submitterId, status: "pending",
      workflowStage: "production_review", stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rejectionReason: "lame", adminNote: "not strong enough" });
    assert.equal(res.status, 200);

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "production_rejected");
    assert.equal(r.status, "rejected");
    assert.equal(r.productionRejectedById, adminId);
    assert.ok(r.productionRejectedAt);
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal(fact.isActive, false, "rejected staging fact stays inactive");
  });

  it("a triage-stage reject stays triage_rejected", async () => {
    const submitterId = await createTestUser();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "junk", submittedById: submitterId, status: "pending", workflowStage: "triage_pending",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rejectionReason: "spam" });
    assert.equal(res.status, 200);
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "triage_rejected");
    assert.equal(r.productionRejectedAt, null);
  });
});

describe("POST /admin/reviews/:id/enrich (retired)", () => {
  it("returns 410 Gone", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/123/enrich")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 410);
    assert.equal(res.body.code, "REVIEW_ENRICH_RETIRED");
  });
});

describe("GET /activity-feed", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/activity-feed");
    assert.equal(res.status, 401);
  });

  it("returns the canonical empty-state for a new user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/activity-feed")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.entries, []);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.unread, 0);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 20);
  });

  it("returns seeded entries newest-first with unread count", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    await db.insert(activityFeedTable).values([
      { userId, actionType: "fact_submitted", message: "old", read: true,  createdAt: new Date(Date.now() - 5000) },
      { userId, actionType: "fact_submitted", message: "new", read: false, createdAt: new Date() },
    ]);

    const res = await request(makeApp())
      .get("/activity-feed")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.unread, 1);
    assert.equal(res.body.entries[0].message, "new");
  });
});

describe("POST /activity-feed/mark-read", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post("/activity-feed/mark-read").send({});
    assert.equal(res.status, 401);
  });

  it("flips unread entries to read for the calling user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    await db.insert(activityFeedTable).values([
      { userId, actionType: "fact_submitted", message: "u1", read: false },
      { userId, actionType: "fact_submitted", message: "u2", read: false },
    ]);

    const res = await request(makeApp())
      .post("/activity-feed/mark-read")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);

    const rows = await db
      .select()
      .from(activityFeedTable)
      .where(eq(activityFeedTable.userId, userId));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.read === true));
  });
});
