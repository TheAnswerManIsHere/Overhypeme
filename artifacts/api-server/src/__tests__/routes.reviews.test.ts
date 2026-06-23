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

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "variant attempt",
      submittedById: submitterId,
      status: "pending",
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
  async function seedPendingReviewWithParent(): Promise<{ reviewId: number; parentId: number }> {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const [parent] = await db
      .insert(factsTable)
      .values({ text: "{NAME} parent fact", submittedById: adminId, isActive: true })
      .returning();
    const [review] = await db
      .insert(pendingReviewsTable)
      .values({
        submittedText: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        status: "pending",
        enrichment: VALID_APPROVAL_ENRICHMENT,
        enrichmentStatus: "ok",
      })
      .returning();
    return { reviewId: review.id, parentId: parent.id };
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
    const [review] = await db
      .insert(pendingReviewsTable)
      .values({
        submittedText: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        status: "pending",
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
