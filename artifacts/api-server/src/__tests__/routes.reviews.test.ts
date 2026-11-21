/**
 * Integration tests for routes/reviews.ts.
 *
 * Covers:
 * - POST /facts/submit-review (auth + onboarding gate + Zod + grammar)
 * - GET /admin/reviews + /count (admin auth and read)
 * - GET /admin/reviews/:id (admin auth, 400 / 404 / success)
 * - POST /admin/reviews/:id/reject (admin auth, 404 / 409 / success)
 * - POST /admin/reviews/:id/approve-variant is gone with variants (404)
 * - GET /activity-feed + /mark-read (user auth)
 *
 * The full /approve success path is left out — it needs external API access.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import { assertCanRunGagRenders, GagError } from "../lib/gags/gagStore";
import request from "supertest";

import { db, factGagsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { factGagExamplesTable } from "@workspace/db";
import { giveExampleSet } from "./helpers/gagExampleSets.js";
import {
  usersTable,
  factsTable,
  pendingReviewsTable,
  activityFeedTable,
  asyncJobsTable,
  adminActionsTable,
  factReadingsTable,
} from "@workspace/db/schema";
import { and, eq, gte, like, sql, count, inArray } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import reviewsRouter, { __settleSubmitDuplicateChecksForTest } from "../routes/reviews.js";
import { __setUtilityLLMClientForTest } from "../lib/utilityLLM.js";
import { materializeEnrichment } from "../lib/factEnrichment.js";
import { FACT_SUBMIT_PENDING_CAP, FACT_SUBMIT_MAX } from "../lib/rateLimit.js";
import { enrichmentJobHandler, runEnrichmentForFact } from "../lib/enrichmentJobs.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

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
  characters: [],
} as FactEnrichment;

// A fact's gag lives in fact_gags (migration 0139), not in its enrichment.
const GAG = {
  version: 1,
  coreSceneOverride: "{NAME} bench-presses the Earth overhead in a stadium.",
  requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
  bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
};

/**
 * Give a fact its slot-1 gag, in the draft (plan PLAN_FACT_LIFECYCLE_REBUILD.md,
 * 1F): "approved" is a draft gag with its male, female and pet renders picked,
 * as a submission ready for production approval has it; "pending" has none.
 */
async function addGag(factId: number, kind: "approved" | "pending" = "approved"): Promise<void> {
  const [gag] = await db.insert(factGagsTable).values({ factId, slot: 1, pendingContent: GAG }).returning({ id: factGagsTable.id });
  if (kind === "approved") await giveExampleSet(factId, gag!.id, GAG, "pending");
}


const USER_PREFIX = "t_routes_rv_";

// Capture start time so the after() hook can delete only outbox rows that
// this test file created, without disturbing rows from other concurrent tests.
const TEST_FILE_START = new Date();

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

function makeApp(): Express {
  const app = express();
  app.locals["duplicateDetector"] = async () => ({ outcome: "distinct", confidence: 0 });
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  return app;
}

async function createTestUser(opts: {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
  onboarded?: boolean;
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
    membershipTier: opts.membershipTier ?? "registered",
    // Verified and onboarded by default, so the onboarding check passes in
    // most tests; a test that needs it to fire passes `onboarded: false`.
    emailVerifiedAt: new Date(),
    onboardingCompletedAt: (opts.onboarded ?? true) ? new Date() : null,
  });
  return id;
}

async function bearerForUser(userId: string, opts: {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
} = {}): Promise<string> {
  const sessionData: SessionData = {
    user: {
      id: userId,
      membershipTier: opts.membershipTier ?? "registered",
    } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: opts.isAdmin,
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

// A submission's post-commit duplicate check runs through this app's own stub
// (makeApp): no paid call.
after(() => __settleSubmitDuplicateChecksForTest());

before(cleanup);
after(cleanup);

// Every test must restore the live model client so a stub can't leak across
// tests.
afterEach(() => __setUtilityLLMClientForTest(null));

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

  it("returns 403 ONBOARDING_REQUIRED for non-admin/non-legendary users who have not onboarded", async () => {
    const userId = await createTestUser({ onboarded: false });
    const sid = await bearerForUser(userId);
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

  it("repairs an already-tokenized submission with the full deterministic grammar cleanup, not just name-collapse", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "{NAME} caught the virus. {Subj}'s keeping it locked in {POSS} back yard." });
    assert.equal(res.status, 201);

    const [row] = await db
      .select()
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.ok(row);
    assert.equal(
      row.submittedText,
      "{NAME} caught the virus. {Subj} {is|are} keeping it locked in {POSS} back yard.",
    );
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
    assert.equal(row.workflowStage, "triage");
    assert.equal(row.enrichment, null);
    assert.equal(row.enrichmentStatus, null);
  });

  it("sanitizes submitted hashtags before storing them on the review", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({
        text: "this fact is about strong coffee drinkers everywhere.",
        // mixed case, '#', whitespace, a dup, denied (alex/overhype), and an empty
        hashtags: ["#Coffee!", "coffee", "  Strength  ", "alex", "overhype", ""],
      });
    assert.equal(res.status, 201);
    const [row] = await db
      .select()
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.ok(row);
    // normalized + deduped, denied tags + empties dropped
    assert.deepEqual(row.hashtags, ["coffee", "strength"]);
  });

  it("COST GATE: submission enqueues no enrichment / embedding jobs", async () => {
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
          inArray(asyncJobsTable.queue, ["enrichment"]),
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
        workflowStage: "triage" as const,
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
        workflowStage: "triage" as const,
      })),
      { submittedText: `done ${randomUUID()}`, submittedById: userId, status: "approved" as const, workflowStage: "approved" as const },
      { submittedText: `rej ${randomUUID()}`, submittedById: userId, status: "rejected" as const, workflowStage: "rejected" as const },
    ]);

    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this should be allowed: only cap-1 are unresolved." });
    assert.equal(res.status, 201);
  });

  it("PER-MINUTE LIMIT: a non-admin account's submission past the fact_submit window max gets 429 with the 'too quickly' message", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    // The first FACT_SUBMIT_MAX submissions inside the window are accepted (well
    // under the unresolved cap) …
    for (let i = 0; i < FACT_SUBMIT_MAX; i++) {
      const ok = await request(makeApp())
        .post("/facts/submit-review")
        .set("authorization", `Bearer ${sid}`)
        .send({ text: `per-minute limit filler number ${i} ${randomUUID()}` });
      assert.equal(ok.status, 201, `submission ${i + 1} inside the window must be accepted`);
    }
    // … the next one trips the dedicated limiter, not the pending cap.
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "one submission too many inside the window." });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "You're submitting facts too quickly. Please slow down.");
    assert.equal(res.body.code, undefined, "this is the rate limiter, not PENDING_CAP_REACHED");

    const [{ value: total }] = await db
      .select({ value: count() })
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.submittedById, userId));
    assert.equal(total, FACT_SUBMIT_MAX, "the throttled submission must not create a review");
  });
});

describe("POST /admin/reviews/:id/provisional-approve", () => {
  async function seedTriageReview(submitterId: string, text = "{NAME} bench-presses the Earth."): Promise<number> {
    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: text,
      submittedById: submitterId,
      status: "pending",
      workflowStage: "triage",
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

  async function readingJobsForFact(factId: number) {
    const runs = await db.select({ id: factReadingsTable.id, status: factReadingsTable.status }).from(factReadingsTable).where(eq(factReadingsTable.factId, factId));
    const jobs = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "fact_reading"), inArray(sql`(${asyncJobsTable.payload}->>'readingId')::int`, runs.length ? runs.map((r) => r.id) : [-1])));
    return { runs, jobs };
  }

  it("creates exactly one inactive staging fact, enters reading with one reading run, and starts one taxonomy job", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const reviewId = await seedTriageReview(submitterId);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/provisional-approve`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.workflowStage, "reading");
    const stagingFactId: number = res.body.stagingFactId;
    assert.equal(typeof stagingFactId, "number");

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, stagingFactId));
    assert.equal(fact.isActive, false, "staging fact must be inactive");

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.workflowStage, "reading");
    assert.equal(r.stagingFactId, stagingFactId);

    const reading = await readingJobsForFact(stagingFactId);
    assert.deepEqual(reading.runs.map((x) => x.status), ["pending"], "one reading run, pending");
    assert.equal(reading.jobs.length, 1, "with its job");
    const jobs = await enrichmentJobsForFact(stagingFactId);
    assert.equal(jobs.length, 1, "exactly one taxonomy job beside it");
    const pexels = await pexelsJobsForFact(stagingFactId);
    assert.equal(pexels.length, 0, "no stock-photo job: staging prep is enrichment only since launch Phase 4, removal 6");
  });

  it("a second click finds the review moved: no second fact, run or job", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const reviewId = await seedTriageReview(submitterId);

    const first = await request(makeApp()).post(`/admin/reviews/${reviewId}/provisional-approve`).set("authorization", `Bearer ${sid}`).send({});
    const stagingFactId: number = first.body.stagingFactId;

    const second = await request(makeApp()).post(`/admin/reviews/${reviewId}/provisional-approve`).set("authorization", `Bearer ${sid}`).send({});
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "REVIEW_MOVED");
    assert.equal(second.body.workflowStage, "reading");

    const facts = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.submittedById, submitterId));
    assert.equal(facts.length, 1, "no second staging fact");
    assert.equal((await enrichmentJobsForFact(stagingFactId)).length, 1, "no duplicate taxonomy job");
    assert.equal((await readingJobsForFact(stagingFactId)).runs.length, 1, "no second reading run");
  });

  it("returns 409 for a terminal (already-decided) review", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "already live", submittedById: submitterId, status: "approved", workflowStage: "approved",
    }).returning();
    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/provisional-approve`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 409);
  });
});

describe("the taxonomy run beside moderation (Issue #1018, increment 1.2c-ii)", () => {
  for (const stage of ["reading", "gags", "test_renders"] as const) {
    it(`classifies a staging fact at ${stage}, and never moves the review or starts idea writing`, async () => {
      const submitterId = await createTestUser();
      const [fact] = await db.insert(factsTable).values({ text: `{NAME} lifts a car at ${stage}`, submittedById: submitterId, isActive: false }).returning();
      const [review] = await db.insert(pendingReviewsTable).values({
        submittedText: `{NAME} lifts a car at ${stage}`, submittedById: submitterId, status: "pending",
        workflowStage: stage, stagingFactId: fact.id,
      }).returning();

      const result = await runEnrichmentForFact(fact.id, { classify: async () => VALID_APPROVAL_ENRICHMENT });
      assert.equal(result.ok, true);

      const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
      assert.equal(f.enrichmentStatus, "ok");
      const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
      assert.equal(r.workflowStage, stage, "the review stays where it was");
      const conceptJobs = await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
        .where(and(eq(asyncJobsTable.queue, "fact_visual_concepts"), like(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${review.id}:%`)));
      assert.equal(conceptJobs.length, 0, "no idea writing started by the taxonomy");
    });
  }

  it("a taxonomy run that gives up is recorded as failed and moves nothing", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} bends a girder", submittedById: submitterId, isActive: false, enrichmentStatus: "pending" }).returning();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bends a girder", submittedById: submitterId, status: "pending",
      workflowStage: "reading", stagingFactId: fact.id,
    }).returning();
    await enrichmentJobHandler.onAbandon!({ payload: { factId: fact.id } } as never);
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.enrichmentStatus, "failed");
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "reading");
  });

  it("COST GUARD: skips classification once the review is rejected", async () => {
    const submitterId = await createTestUser();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} runs fast", submittedById: submitterId, isActive: false }).returning();
    await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} runs fast", submittedById: submitterId, status: "rejected",
      workflowStage: "rejected", stagingFactId: fact.id,
    });

    let classifyCalled = false;
    const result = await runEnrichmentForFact(fact.id, {
      classify: async () => { classifyCalled = true; return VALID_APPROVAL_ENRICHMENT; },
    });
    assert.equal(result.ok, true);
    assert.equal(classifyCalled, false, "no paid classification for a rejected submission");
  });

  it("live-fact re-enrich (no linked review) still classifies normally", async () => {
    const submitterId = await createTestUser();
    const fact = await insertLiveFact({ text: "{NAME} jumps high", submittedById: submitterId, enrichment: VALID_APPROVAL_ENRICHMENT }, GAG);
    let classifyCalled = false;
    const result = await runEnrichmentForFact(fact.id, {
      classify: async () => { classifyCalled = true; return VALID_APPROVAL_ENRICHMENT; },
    });
    assert.equal(result.ok, true);
    assert.equal(classifyCalled, true);
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
    assert.equal(res.body.stagingFact, null, "no staging fact before provisional approval");
  });

  it("returns the staging fact's classification without a gag in it (a gag lives in fact_gags)", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Earth.", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    await addGag(staging.id);
    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Earth.", submittedById: submitterId, status: "pending",
      workflowStage: "gags", stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();

    const res = await request(makeApp()).get(`/admin/reviews/${r.id}`).set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.stagingFact.enrichment.primaryArchetype, "superhuman_physical_feat");
    assert.equal(res.body.stagingFact.enrichment.visualPromptStrategyOverride, undefined);
  });

  it("hydrates the Reading step once the submission is accepted: the run, pending, on the detail and the list row", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} prep status check", submittedById: submitterId, status: "pending", workflowStage: "triage",
    }).returning();

    await request(makeApp()).post(`/admin/reviews/${r.id}/provisional-approve`).set("authorization", `Bearer ${sid}`).send({});

    const detail = await request(makeApp()).get(`/admin/reviews/${r.id}`).set("authorization", `Bearer ${sid}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.workflowStage, "reading");
    assert.ok(detail.body.stagingFact, "staging fact hydrated");
    assert.equal(detail.body.stagingFact.isActive, false);
    assert.equal(detail.body.reading.latest.status, "pending");
    assert.equal(detail.body.reading.approved, null);
    assert.equal("pexelsStatus" in detail.body.stagingFact, false, "no stock-photo status since removal 6");

    // The list row carries the reading's status.
    const list = await request(makeApp()).get(`/admin/reviews?status=pending`).set("authorization", `Bearer ${sid}`);
    const row = (list.body.reviews as { id: number; readingStatus: string | null }[]).find((x) => x.id === r.id);
    assert.equal(row?.readingStatus, "pending");
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
    assert.equal(res.body.code, "REVIEW_MOVED");
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
    const actions = await db.select({ action: adminActionsTable.action, actorId: adminActionsTable.actorId, detail: adminActionsTable.detail })
      .from(adminActionsTable).where(eq(adminActionsTable.reviewId, r.id));
    assert.deepEqual(actions, [{ action: "reject", actorId: adminId, detail: { reason: "spam", adminNote: "doesn't fit", stage: "triage", gagsDiscarded: 0 } }]);
  });
});

describe("POST /admin/reviews/:id/approve-variant — retired with variants", () => {
  it("no longer exists", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/1/approve-variant")
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 1 });
    assert.equal(res.status, 404);
  });
});

// ── Approval renderability gating (no synchronous preflight) ──────────────
//
// Approval makes NO model or compiler call of its own: renderability is shown
// by each gag's approved male, female and pet examples (plan
// PLAN_GAG_EXAMPLES.md, section D), which replaced the review-wide render
// check and its waiver. These tests pin that contract.
describe("approval renderability gating", () => {
  // A review that has finished prep: it owns an inactive staging fact carrying
  // the effective enrichment, and sits at Test Renders — the precondition
  // for production approval.
  async function seedPendingReview(
    enrichment: FactEnrichment = VALID_APPROVAL_ENRICHMENT,
  ): Promise<{ reviewId: number; stagingFactId: number }> {
    const submitterId = await createTestUser();
    const [staging] = await db
      .insert(factsTable)
      .values({
        text: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        isActive: false,
        enrichment,
      })
      .returning();
    await addGag(staging.id);
    const [review] = await db
      .insert(pendingReviewsTable)
      .values({
        submittedText: "{NAME} bench-presses the Earth.",
        submittedById: submitterId,
        status: "pending",
        workflowStage: "test_renders",
        stagingFactId: staging.id,
        enrichment,
        enrichmentStatus: "ok",
      })
      .returning();
    return { reviewId: review.id, stagingFactId: staging.id };
  }

  it("approves WITHOUT any model call (no planner exists since PLAN_GAG_DIRECT_RENDER.md, D)", async () => {
    const { reviewId } = await seedPendingReview();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    // Guard the core of this change: the approve path must make NO model call.
    // If it does, the seam throws and the request fails — so a green 200 proves
    // renderability came from the gag's examples, not a re-check.
    let modelCalled = false;
    __setUtilityLLMClientForTest({
      chat: { completions: { create: async () => { modelCalled = true; throw new Error("no model call on approval"); } } },
    } as never);

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(modelCalled, false, "approval makes no model call");

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.status, "approved");
    assert.equal(r.visualRenderApprovalWaiver, null, "no waiver exists any more");
  });

  it("blocks approval (409 CONCEPT_MISSING) while the only gag lacks its examples, naming the missing kinds", async () => {
    const { reviewId, stagingFactId } = await seedPendingReview();
    await db.delete(factGagsTable).where(eq(factGagsTable.factId, stagingFactId));
    await addGag(stagingFactId, "pending");
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({ waiveVisualRenderIssues: true });

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "CONCEPT_MISSING");
    assert.equal(res.body.error, "Gag 1 needs male, female and pet renders approved.");
    assert.deepEqual(res.body.gaps, [{ slot: 1, missing: ["male", "female", "pet"], outdated: [] }]);

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.status, "pending", "a fact without an offered gag must NOT be approved; a waiver flag is ignored");
  });

});

describe("POST /admin/reviews/:id/approve-for-production", () => {
  async function seedProductionReview(): Promise<{ reviewId: number; stagingFactId: number; submitterId: string }> {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Earth.", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    await addGag(staging.id);
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Earth.", submittedById: submitterId, status: "pending",
      workflowStage: "test_renders", stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    return { reviewId: review.id, stagingFactId: staging.id, submitterId };
  }

  it("activates the staging fact, marks the review approved, and is idempotent", async () => {
    const { reviewId, stagingFactId } = await seedProductionReview();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.factId, stagingFactId);

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, stagingFactId));
    assert.equal(fact.isActive, true, "staging fact must become active");
    // The fact now records that it was approved, and by whom (plan, Source-of-Truth Analysis).
    assert.ok(fact.approvedAt, "the approval is recorded");
    assert.equal(fact.approvedById, adminId);
    assert.equal(fact.approvalSource, "moderator");
    const actions = await db.select({ action: adminActionsTable.action, reviewId: adminActionsTable.reviewId, actorId: adminActionsTable.actorId })
      .from(adminActionsTable).where(eq(adminActionsTable.factId, stagingFactId));
    assert.deepEqual(actions, [{ action: "approve_for_production", reviewId, actorId: adminId }]);
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(r.workflowStage, "approved");
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

  it("refuses to activate a review at triage (no shortcut to live)", async () => {
    const submitterId = await createTestUser();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "not prepped yet", submittedById: submitterId, status: "pending", workflowStage: "triage",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 409);
  });

  it("preserves the staging fact's AI baseline + override map through approval", async () => {
    // A staging fact in full override-tracking shape: materialized baseline plus
    // one moderator override — exactly what the moderation modal now produces.
    const submitterId = await createTestUser();
    const overrides = {
      "/visualComplexity": { value: "high", overriddenFrom: "medium", createdAt: new Date("2026-01-01T00:00:00Z").toISOString(), createdBy: "admin", reason: "test" },
    };
    const { columns } = materializeEnrichment({ aiDerived: VALID_APPROVAL_ENRICHMENT, overrides });
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Earth.", submittedById: submitterId, isActive: false,
      ...columns,
      enrichmentStatus: "ok",
    } as typeof factsTable.$inferInsert).returning();
    await addGag(staging.id);
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Earth.", submittedById: submitterId, status: "pending",
      workflowStage: "test_renders", stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 200);

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal(fact.isActive, true);
    // Approval must not rewrite ANY enrichment layer: the effective keeps the
    // override, the baseline keeps the AI value, the override map survives.
    assert.equal((fact.enrichment as FactEnrichment).visualComplexity, "high");
    assert.equal((fact.enrichmentAiDerived as FactEnrichment).visualComplexity, "medium");
    const ov = (fact.enrichmentOverrides as Record<string, { value: unknown; overriddenFrom: unknown }>)["/visualComplexity"];
    assert.equal(ov.value, "high");
    assert.equal(ov.overriddenFrom, "medium");
  });

  it("ignores a legacy client enrichment body — the staging fact's stored blob is authoritative", async () => {
    const { reviewId, stagingFactId } = await seedProductionReview();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    // A stale pre-override-model client ships its flattened edited blob on
    // approve. The edit (visualComplexity medium → high) must NOT take effect.
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({ enrichment: { ...VALID_APPROVAL_ENRICHMENT, visualComplexity: "high" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, stagingFactId));
    assert.equal(fact.isActive, true);
    assert.equal((fact.enrichment as FactEnrichment).visualComplexity, "medium", "the body blob must not overwrite the staging fact");
    // The review-row snapshot records what actually shipped (the stored blob).
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal((r.enrichment as FactEnrichment).visualComplexity, "medium");
  });

  for (const taxonomy of [{ label: "absent", enrichment: null, enrichmentStatus: null }, { label: "failed", enrichment: null, enrichmentStatus: "failed" }] as const) {
    it(`goes live with the taxonomy ${taxonomy.label} (the taxonomy is off the moderation path)`, async () => {
      const submitterId = await createTestUser();
      const [staging] = await db.insert(factsTable).values({
        text: `{NAME} bench-presses the Moon (${taxonomy.label}).`, submittedById: submitterId, isActive: false,
        enrichment: taxonomy.enrichment, enrichmentStatus: taxonomy.enrichmentStatus,
      }).returning();
      await addGag(staging.id);
      const [review] = await db.insert(pendingReviewsTable).values({
        submittedText: `{NAME} bench-presses the Moon (${taxonomy.label}).`, submittedById: submitterId, status: "pending",
        workflowStage: "test_renders", stagingFactId: staging.id, hashtags: ["strength"],
      }).returning();
      const adminId = await createTestUser({ isAdmin: true });
      const sid = await bearerForUser(adminId, { isAdmin: true });

      const res = await request(makeApp())
        .post(`/admin/reviews/${review.id}/approve-for-production`)
        .set("authorization", `Bearer ${sid}`)
        .send({});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
      assert.equal(fact.isActive, true);
      const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
      assert.equal(r.workflowStage, "approved");
      assert.equal(r.enrichment, null, "no taxonomy snapshot when there was none");
    });
  }

  it("Reject against Approve for production, at once: one succeeds, the other is told the review moved (the lock rule)", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const outcomes = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const { reviewId, stagingFactId } = await seedProductionReview();
      const [approve, reject] = await Promise.all([
        request(makeApp()).post(`/admin/reviews/${reviewId}/approve-for-production`).set("authorization", `Bearer ${sid}`).send({}),
        request(makeApp()).post(`/admin/reviews/${reviewId}/reject`).set("authorization", `Bearer ${sid}`).send({ rejectionReason: "lame" }),
      ]);
      const statuses = [approve.status, reject.status].sort();
      assert.deepEqual(statuses, [200, 409], `one success and one refusal, never a server error: ${JSON.stringify([approve.body, reject.body])}`);
      const loser = approve.status === 409 ? approve : reject;
      assert.equal(loser.body.code, "REVIEW_MOVED", JSON.stringify(loser.body));
      const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
      const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, stagingFactId));
      if (approve.status === 200) {
        assert.equal(r.workflowStage, "approved");
        assert.equal(fact.isActive, true);
        assert.equal(loser.body.workflowStage, "approved");
      } else {
        assert.equal(r.workflowStage, "rejected");
        assert.equal(fact.isActive, false);
        assert.equal(fact.approvedAt, null, "a rejected submission is never recorded approved");
        const gags = await db.select({ id: factGagsTable.id }).from(factGagsTable).where(eq(factGagsTable.factId, stagingFactId));
        assert.equal(gags.length, 0, "its gags are deleted");
      }
      outcomes.set(approve.status === 200 ? "approved" : "rejected", (outcomes.get(approve.status === 200 ? "approved" : "rejected") ?? 0) + 1);
    }
    assert.ok(outcomes.size >= 1);
  });

  it("refuses a review still at Reading with 409 REVIEW_MOVED and leaves its staging fact inactive", async () => {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Earth.", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    await addGag(staging.id);
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Earth.", submittedById: submitterId, status: "pending",
      workflowStage: "reading", stagingFactId: staging.id,
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "REVIEW_MOVED");

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal(fact.isActive, false, "a review at Reading keeps its staging fact inactive");
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "reading");
    assert.equal(r.status, "pending");
  });

  it("approval activates the staging fact (inactive before) and tells the submitter in one wording", async () => {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Earth.", submittedById: submitterId, isActive: false,
      enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    await addGag(staging.id);
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Earth.", submittedById: submitterId, status: "pending",
      workflowStage: "test_renders", stagingFactId: staging.id,
      enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [before] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal(before.isActive, false, "the staging fact is inactive before approval");

    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal("parentFactId" in res.body, false);

    const [after] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal(after.isActive, true);

    const [entry] = await db.select().from(activityFeedTable)
      .where(and(eq(activityFeedTable.userId, submitterId), eq(activityFeedTable.actionType, "review_approved")));
    assert.equal(entry.message, "Your submitted fact was approved by an admin and added to the database!");
    assert.deepEqual(entry.metadata, { reviewId: review.id, factId: staging.id, adminNote: null });
  });

  it("returns 409 CONCEPT_MISSING at Test Renders with no gag, then 200, an active fact and its draft published once a gag has its renders approved", async () => {
    const submitterId = await createTestUser();
    const withoutConcept = VALID_APPROVAL_ENRICHMENT;
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Earth.", submittedById: submitterId, isActive: false, enrichment: withoutConcept,
    }).returning();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Earth.", submittedById: submitterId, status: "pending",
      workflowStage: "test_renders", stagingFactId: staging.id, enrichment: withoutConcept, enrichmentStatus: "ok",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const blocked = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.code, "CONCEPT_MISSING");
    assert.equal(blocked.body.error, "A fact needs at least one gag before it can go live.");
    const [stillInactive] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal(stillInactive.isActive, false, "a fact with no approved gag must not go live");

    // A gag is approved on the staging fact; the same approval now succeeds.
    await addGag(staging.id);
    const ok = await request(makeApp())
      .post(`/admin/reviews/${review.id}/approve-for-production`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [live] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal(live.isActive, true);
    const [published] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, staging.id));
    assert.deepEqual(published!.approvedContent, GAG, "the draft became the published set");
    assert.equal(published!.pendingContent, null);
  });

  it("refuses, publishing nothing, when one of two gags lacks a render, naming it; a render of an older version counts as missing (plan item 12)", async () => {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} bench-presses the Moon.", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    await addGag(staging.id);
    const second = { ...GAG, coreSceneOverride: "{NAME} bench-presses the Moon, take two." };
    const [g2] = await db.insert(factGagsTable).values({ factId: staging.id, slot: 2, pendingContent: second }).returning({ id: factGagsTable.id });
    const picks = await giveExampleSet(staging.id, g2!.id, { ...second, coreSceneOverride: "{NAME} an older version of take two." }, "pending");
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} bench-presses the Moon.", submittedById: submitterId, status: "pending",
      workflowStage: "test_renders", stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const approve = () => request(makeApp()).post(`/admin/reviews/${review.id}/approve-for-production`).set("authorization", `Bearer ${sid}`).send({});

    const blocked = await approve();
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.code, "CONCEPT_MISSING");
    assert.match(blocked.body.error, /^Gag 2 has male, female and pet renders of an older version of it/);
    const rows = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, staging.id));
    assert.ok(rows.every((r) => r.approvedContent == null), "nothing was published");
    assert.equal((await db.select().from(factsTable).where(eq(factsTable.id, staging.id)))[0]!.isActive, false);

    // Picks of the current content: the whole set publishes at once.
    await db.delete(factGagExamplesTable).where(eq(factGagExamplesTable.gagId, g2!.id));
    assert.ok(Object.values(picks).length === 3);
    await giveExampleSet(staging.id, g2!.id, second, "pending");
    const ok = await approve();
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, staging.id));
    assert.deepEqual(after.map((r) => r.approvedContent != null).sort(), [true, true], "both gags are published together");
  });
});

describe("PATCH /admin/reviews/:id (draft autosave)", () => {
  it("saves note/reason but ignores a legacy enrichment field (staging fact untouched)", async () => {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} does a thing", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
    }).returning();
    await addGag(staging.id);
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} does a thing", submittedById: submitterId, status: "pending",
      workflowStage: "test_renders", stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const res = await request(makeApp())
      .patch(`/admin/reviews/${review.id}`)
      .set("authorization", `Bearer ${sid}`)
      .send({ note: "looks good", reason: "lame", enrichment: { ...VALID_APPROVAL_ENRICHMENT, visualComplexity: "high" } });
    assert.equal(res.status, 200);

    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.adminNote, "looks good");
    assert.equal(r.reason, "lame");
    // The legacy enrichment draft is ignored — never written to the review row…
    assert.equal((r.enrichment as FactEnrichment).visualComplexity, "medium");
    // …and the staging fact (the only enrichment truth) is untouched.
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
    assert.equal((fact.enrichment as FactEnrichment).visualComplexity, "medium");
  });
});

describe("reject from every step (PLAN_FACT_LIFECYCLE_REBUILD.md item 13)", () => {
  async function seedPastTriage(stage: "reading" | "gags" | "test_renders") {
    const submitterId = await createTestUser();
    const [staging] = await db.insert(factsTable).values({
      text: "{NAME} does a thing", submittedById: submitterId, isActive: false, enrichment: VALID_APPROVAL_ENRICHMENT,
      enrichmentStatus: stage === "reading" ? "pending" : "ok",
    }).returning();
    await addGag(staging.id);
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} does a thing", submittedById: submitterId, status: "pending",
      workflowStage: stage, stagingFactId: staging.id, enrichment: VALID_APPROVAL_ENRICHMENT, enrichmentStatus: "ok",
    }).returning();
    return { submitterId, staging, review };
  }

  for (const stage of ["reading", "gags", "test_renders"] as const) {
    it(`rejects from ${stage}: rejected, the gags deleted, the staging fact never live, recorded, the submitter told`, async () => {
      const { submitterId, staging, review } = await seedPastTriage(stage);
      const adminId = await createTestUser({ isAdmin: true });
      const sid = await bearerForUser(adminId, { isAdmin: true });

      const res = await request(makeApp())
        .post(`/admin/reviews/${review.id}/reject`)
        .set("authorization", `Bearer ${sid}`)
        .send({ rejectionReason: "visual", adminNote: "no picture lands" });
      assert.equal(res.status, 200);

      const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
      assert.equal(r.status, "rejected");
      assert.equal(r.workflowStage, "rejected");
      assert.equal(r.reason, "visual");
      assert.equal(r.adminNote, "no picture lands");
      assert.equal(r.productionRejectedById, adminId);
      assert.ok(r.productionRejectedAt);
      const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, staging.id));
      assert.equal(fact.isActive, false, "the staging fact never goes live");
      assert.equal(fact.approvedAt, null, "and is never recorded as approved");
      if (stage === "reading") assert.equal(fact.enrichmentStatus, null, "a pending taxonomy run is cleared");
      const gags = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, staging.id));
      assert.equal(gags.length, 0, "the submission's gags are discarded");
      const actions = await db.select({ action: adminActionsTable.action, actorId: adminActionsTable.actorId, factId: adminActionsTable.factId, detail: adminActionsTable.detail })
        .from(adminActionsTable).where(eq(adminActionsTable.reviewId, review.id));
      assert.deepEqual(actions, [{ action: "reject", actorId: adminId, factId: staging.id, detail: { reason: "visual", adminNote: "no picture lands", stage, gagsDiscarded: 1 } }]);
      const feed = await db.select().from(activityFeedTable).where(eq(activityFeedTable.userId, submitterId));
      assert.ok(feed.some((e) => e.actionType === "review_rejected"), "the submitter is told (the email follows the same path)");
    });
  }

  it("waits for a gag being added and discards it too; a gag action after the rejection is refused (PR #1036 round 1)", async () => {
    const { staging, review } = await seedPastTriage("gags");
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });

    // Another transaction holds the fact row, the way every gag action does,
    // and adds a gag while Reject is waiting for it.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const adder = db.transaction(async (tx) => {
      await tx.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, staging.id)).for("update");
      locked();
      await held;
      await tx.insert(factGagsTable).values({ factId: staging.id, slot: 2, pendingContent: GAG });
    });
    await lockTaken;

    let settled = false;
    const rejecting = request(makeApp())
      .post(`/admin/reviews/${review.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rejectionReason: "visual" })
      .then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, "Reject waits for the fact row");
    release();
    await adder;
    const res = await rejecting;
    assert.equal(res.status, 200);

    const gags = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, staging.id));
    assert.equal(gags.length, 0, "the gag added while Reject waited is discarded too");
    const [action] = await db.select({ detail: adminActionsTable.detail }).from(adminActionsTable).where(eq(adminActionsTable.reviewId, review.id));
    assert.equal((action.detail as { gagsDiscarded: number }).gagsDiscarded, 2);

    await assert.rejects(
      assertCanRunGagRenders(staging.id, 1, { adminId, reviewId: review.id }),
      (err: unknown) => err instanceof GagError && err.code === "REVIEW_NOT_EDITABLE",
      "a gag action after the rejection is refused",
    );
  });

  it("a reject at triage records no production rejection", async () => {
    const submitterId = await createTestUser();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "junk", submittedById: submitterId, status: "pending", workflowStage: "triage",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rejectionReason: "spam" });
    assert.equal(res.status, 200);
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "rejected");
    assert.equal(r.productionRejectedAt, null);
  });

  it("refuses a review that is already live, and leaves it untouched", async () => {
    const submitterId = await createTestUser();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "live one", submittedById: submitterId, status: "approved", workflowStage: "approved",
    }).returning();
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rejectionReason: "lame" });
    assert.equal(res.status, 409);
    const [r] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, review.id));
    assert.equal(r.workflowStage, "approved");
    const actions = await db.select().from(adminActionsTable).where(eq(adminActionsTable.reviewId, review.id));
    assert.equal(actions.length, 0);
  });

  it("refuses without a reason, and leaves the gags", async () => {
    const { staging, review } = await seedPastTriage("gags");
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post(`/admin/reviews/${review.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ adminNote: "no reason given" });
    assert.equal(res.status, 400);
    const gags = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, staging.id));
    assert.equal(gags.length, 1);
  });
});

describe("retired review routes are gone (Deprecated means removed)", () => {
  for (const [method, path] of [["post", "/admin/reviews/123/enrich"], ["patch", "/admin/reviews/123/staging-enrichment"], ["post", "/admin/reviews/123/withdraw"]] as const) {
    it(`${method.toUpperCase()} ${path} no longer exists`, async () => {
      const adminId = await createTestUser({ isAdmin: true });
      const sid = await bearerForUser(adminId, { isAdmin: true });
      const res = await request(makeApp())[method](path).set("authorization", `Bearer ${sid}`).send({});
      assert.equal(res.status, 404);
    });
  }
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
