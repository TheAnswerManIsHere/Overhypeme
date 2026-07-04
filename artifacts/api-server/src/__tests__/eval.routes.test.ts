/**
 * Eval harness (Slice 2B) — route + aggregation integration tests.
 *   - POST /admin/facts/:id/eval-golden        (active only; drift)
 *   - POST /admin/reviews/:id/render-scenarios/:key/attempts/:id/eval
 *                                              (persist/clear/ownership; drift)
 *   - POST /admin/eval/attempts/:id/eval        (eval-run guard; drift)
 *   - POST /admin/eval/runs + GET runs + GET runs/:id   (create/list/status; drift)
 *   - GET  /admin/eval/attempts/:id/image       (guards; drift)
 *   - GET  /admin/eval/dashboard                (aggregation + run diff; drift)
 * Plus: eval-run attempts are tagged eval_run_id / eval_scenario_key with a NULL
 * review_id, so they never appear in the moderation scenario grid.
 *
 * Eval attempts are inserted directly (bypassing the render pipeline) so the
 * rating/dashboard assertions are deterministic. Seeds under `t_eval_`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, imagePromptAttemptsTable, evalRunsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import evalRouter from "../routes/eval.js";
import { buildReviewScenarioGrid } from "../lib/reviewRenderScenarios.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_eval_";
const TEST_FILE_START = new Date();

const ENRICHMENT: FactEnrichment = {
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
} as unknown as FactEnrichment;

const insertedFactIds: number[] = [];
let adminId: string, plainId: string, adminSid: string, plainSid: string;

async function createUser(isAdmin: boolean): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, isAdmin,
    membershipTier: isAdmin ? "legendary" : "registered", captchaVerified: true,
  });
  return id;
}
async function bearer(userId: string, isAdmin: boolean): Promise<string> {
  return createSession({
    user: { id: userId, membershipTier: isAdmin ? "legendary" : "registered" } as unknown as SessionData["user"],
    access_token: "test-token", isAdmin, captchaVerified: true,
  }, userId);
}

async function makeFact(opts: { active?: boolean; golden?: boolean } = {}): Promise<number> {
  const [f] = await db.insert(factsTable).values({
    text: "{NAME} bench-presses the Earth.", submittedById: adminId,
    isActive: opts.active ?? true, enrichment: ENRICHMENT,
    evalGolden: opts.golden ?? false,
  }).returning({ id: factsTable.id });
  insertedFactIds.push(f!.id);
  return f!.id;
}

/** A real pending review (image_prompt_attempts.review_id has an FK to it). */
async function makeReview(factId: number): Promise<number> {
  const [r] = await db.insert(pendingReviewsTable).values({
    submittedText: "x", submittedById: adminId, matchingSimilarity: 0,
    status: "pending", workflowStage: "production_review" as never, stagingFactId: factId,
    enrichment: ENRICHMENT, enrichmentStatus: "ok",
  }).returning({ id: pendingReviewsTable.id });
  return r!.id;
}

/** Insert an attempt row directly. `kind` sets review vs eval scoping. */
async function insertAttempt(opts: {
  factId: number;
  kind: "review" | "eval";
  reviewId?: number;
  scenarioKey?: string;
  evalRunId?: number;
  generationMode?: string;
  subjectRenderMode?: string;
  rating?: number;
  failureTag?: string;
}): Promise<number> {
  const [a] = await db.insert(imagePromptAttemptsTable).values({
    factId: opts.factId,
    userId: null,
    generationMode: opts.generationMode ?? "t2i",
    subjectRenderMode: opts.subjectRenderMode ?? "t2i_fallback",
    targetEngine: "nano_banana_2",
    sourceImageAnalysis: {},
    identityPolicy: {},
    renderControls: {},
    factEnrichmentSnapshot: ENRICHMENT,
    archetypeStrategyVersion: "v2",
    reviewId: opts.kind === "review" ? (opts.reviewId ?? null) : null,
    reviewRenderScenarioKey: opts.kind === "review" ? (opts.scenarioKey ?? null) : null,
    evalRunId: opts.kind === "eval" ? (opts.evalRunId ?? null) : null,
    evalScenarioKey: opts.kind === "eval" ? (opts.scenarioKey ?? null) : null,
    moderatorRating: opts.rating ?? null,
    failureTag: opts.failureTag ?? null,
  }).returning({ id: imagePromptAttemptsTable.id });
  return a!.id;
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  app.use(evalRouter);
  return app;
}
const app = makeApp();

async function cleanup() {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  if (insertedFactIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, insertedFactIds));
  }
  for (const u of users) {
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(evalRunsTable).where(gte(evalRunsTable.createdAt, TEST_FILE_START));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  insertedFactIds.length = 0;
}

before(async () => {
  await cleanup();
  adminId = await createUser(true);
  plainId = await createUser(false);
  adminSid = await bearer(adminId, true);
  plainSid = await bearer(plainId, false);
});
after(async () => { await cleanup(); });

const authp = (r: request.Test, sid: string) => r.set("authorization", `Bearer ${sid}`);

describe("POST /admin/facts/:id/eval-golden", () => {
  it("toggles golden on an active fact + stores the reason", async () => {
    const factId = await makeFact({ active: true });
    const res = await authp(request(app).post(`/admin/facts/${factId}/eval-golden`), adminSid).send({ golden: true, reason: "clean regression case" });
    assert.equal(res.status, 200);
    const [f] = await db.select({ g: factsTable.evalGolden, r: factsTable.evalGoldenReason }).from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(f!.g, true);
    assert.equal(f!.r, "clean regression case");
  });

  it("rejects an inactive fact (409) and a non-admin (drift)", async () => {
    const inactive = await makeFact({ active: false });
    assert.equal((await authp(request(app).post(`/admin/facts/${inactive}/eval-golden`), adminSid).send({ golden: true })).status, 409);
    const active = await makeFact({ active: true });
    const drift = await authp(request(app).post(`/admin/facts/${active}/eval-golden`), plainSid).send({ golden: true });
    assert.ok(drift.status === 401 || drift.status === 403, `expected 401/403, got ${drift.status}`);
  });
});

describe("POST /admin/reviews/:id/.../attempts/:id/eval (review-scoped)", () => {
  async function seedReviewAttempt(scenarioKey = "generic_t2i") {
    const factId = await makeFact({ active: false });
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "x", submittedById: adminId, matchingSimilarity: 0,
      status: "pending", workflowStage: "production_review" as never, stagingFactId: factId,
      enrichment: ENRICHMENT, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const attemptId = await insertAttempt({ factId, kind: "review", reviewId: review!.id, scenarioKey });
    return { reviewId: review!.id, attemptId, factId, scenarioKey };
  }

  it("persists rating + failureTag + notes, then clears via explicit null", async () => {
    const { reviewId, attemptId, scenarioKey } = await seedReviewAttempt();
    const url = `/admin/reviews/${reviewId}/render-scenarios/${scenarioKey}/attempts/${attemptId}/eval`;
    assert.equal((await authp(request(app).post(url), adminSid).send({ rating: 4, failureTag: "compiler", notes: "  lost the pose  " })).status, 200);
    let [a] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attemptId));
    assert.equal(a!.moderatorRating, 4);
    assert.equal(a!.failureTag, "compiler");
    assert.equal(a!.evalNotes, "lost the pose");
    assert.ok(a!.evalBy && a!.evalAt);
    // Clear rating only (leave the tag) with explicit null.
    assert.equal((await authp(request(app).post(url), adminSid).send({ rating: null })).status, 200);
    [a] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attemptId));
    assert.equal(a!.moderatorRating, null);
    assert.equal(a!.failureTag, "compiler"); // untouched (omitted)
  });

  it("rejects an empty body, a foreign review, a scenario mismatch, and a non-admin", async () => {
    const { reviewId, attemptId, scenarioKey } = await seedReviewAttempt("generic_t2i");
    const base = `/admin/reviews/${reviewId}/render-scenarios/${scenarioKey}/attempts/${attemptId}/eval`;
    assert.equal((await authp(request(app).post(base), adminSid).send({})).status, 400);
    // foreign review id
    assert.equal((await authp(request(app).post(`/admin/reviews/${reviewId + 99999}/render-scenarios/${scenarioKey}/attempts/${attemptId}/eval`), adminSid).send({ rating: 3 })).status, 404);
    // scenario mismatch
    assert.equal((await authp(request(app).post(`/admin/reviews/${reviewId}/render-scenarios/i2i_male_default/attempts/${attemptId}/eval`), adminSid).send({ rating: 3 })).status, 409);
    const drift = await authp(request(app).post(base), plainSid).send({ rating: 3 });
    assert.ok(drift.status === 401 || drift.status === 403);
  });
});

describe("POST /admin/eval/attempts/:id/eval (eval-run scoped)", () => {
  it("rates a pure eval-run attempt but rejects a moderation attempt (409) and a non-admin", async () => {
    const factId = await makeFact({ active: true, golden: true });
    const [run] = await db.insert(evalRunsTable).values({ label: "r", createdBy: adminId }).returning({ id: evalRunsTable.id });
    const evalAttempt = await insertAttempt({ factId, kind: "eval", evalRunId: run!.id, scenarioKey: "generic_t2i" });
    assert.equal((await authp(request(app).post(`/admin/eval/attempts/${evalAttempt}/eval`), adminSid).send({ rating: 5, failureTag: "none" })).status, 200);
    const [a] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, evalAttempt));
    assert.equal(a!.moderatorRating, 5);
    assert.equal(a!.failureTag, "none");

    // A moderation attempt (review_id set, eval_run_id null) is rejected here.
    const modReview = await makeReview(factId);
    const modAttempt = await insertAttempt({ factId, kind: "review", reviewId: modReview, scenarioKey: "generic_t2i" });
    assert.equal((await authp(request(app).post(`/admin/eval/attempts/${modAttempt}/eval`), adminSid).send({ rating: 3 })).status, 409);
    const drift = await authp(request(app).post(`/admin/eval/attempts/${evalAttempt}/eval`), plainSid).send({ rating: 3 });
    assert.ok(drift.status === 401 || drift.status === 403);
  });
});

describe("eval runs: create / list / status + isolation from the review grid", () => {
  it("creates a run row and lists it; status resolves; drift is rejected", async () => {
    await makeFact({ active: true, golden: true });
    const res = await authp(request(app).post(`/admin/eval/runs`), adminSid).send({ label: "baseline" });
    assert.equal(res.status, 202);
    const runId = res.body.runId as number;
    assert.ok(typeof runId === "number");
    assert.ok(Array.isArray(res.body.items));

    const list = await authp(request(app).get(`/admin/eval/runs`), adminSid);
    assert.equal(list.status, 200);
    assert.ok((list.body.runs as Array<{ id: number }>).some((r) => r.id === runId));

    const status = await authp(request(app).get(`/admin/eval/runs/${runId}`), adminSid);
    assert.equal(status.status, 200);
    assert.equal(status.body.run.id, runId);

    const drift = await authp(request(app).post(`/admin/eval/runs`), plainSid).send({});
    assert.ok(drift.status === 401 || drift.status === 403);
  });

  it("eval-run attempts (eval_run_id set, review_id null) never appear in the review scenario grid", async () => {
    const factId = await makeFact({ active: false });
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "x", submittedById: adminId, matchingSimilarity: 0,
      status: "pending", workflowStage: "production_review" as never, stagingFactId: factId,
      enrichment: ENRICHMENT, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const [run] = await db.insert(evalRunsTable).values({ label: "r", createdBy: adminId }).returning({ id: evalRunsTable.id });
    // An eval attempt on the SAME fact — must not leak into the review grid.
    await insertAttempt({ factId, kind: "eval", evalRunId: run!.id, scenarioKey: "generic_t2i" });

    const grid = await buildReviewScenarioGrid(review!.id);
    const anyEvalLeaked = grid.cards.some((c) => c.latestAttemptId != null);
    assert.equal(anyEvalLeaked, false, "no eval attempt should back a review scenario card");
  });
});

describe("GET /admin/eval/attempts/:id/image (guards)", () => {
  it("404s a non-eval attempt and an eval attempt with no image; drift rejected", async () => {
    const factId = await makeFact({ active: true, golden: true });
    const [run] = await db.insert(evalRunsTable).values({ label: "r", createdBy: adminId }).returning({ id: evalRunsTable.id });
    const evalAttempt = await insertAttempt({ factId, kind: "eval", evalRunId: run!.id });
    const modReview = await makeReview(factId);
    const modAttempt = await insertAttempt({ factId, kind: "review", reviewId: modReview });
    assert.equal((await authp(request(app).get(`/admin/eval/attempts/${evalAttempt}/image`), adminSid)).status, 404); // image_not_ready
    assert.equal((await authp(request(app).get(`/admin/eval/attempts/${modAttempt}/image`), adminSid)).status, 404); // attempt_not_found (not eval)
    const drift = await authp(request(app).get(`/admin/eval/attempts/${evalAttempt}/image`), plainSid);
    assert.ok(drift.status === 401 || drift.status === 403);
  });
});

describe("GET /admin/eval/dashboard (aggregation + run diff)", () => {
  it("groups by run, computes avg rating + tag distribution, diffs run N vs N-1, separates opportunistic", async () => {
    const factId = await makeFact({ active: true, golden: true });
    // Previous run: two attempts rated 2 and 4 (avg 3), one tagged concept.
    const [prev] = await db.insert(evalRunsTable).values({ label: "prev", createdBy: adminId }).returning({ id: evalRunsTable.id });
    await insertAttempt({ factId, kind: "eval", evalRunId: prev!.id, scenarioKey: "generic_t2i", rating: 2, failureTag: "concept" });
    await insertAttempt({ factId, kind: "eval", evalRunId: prev!.id, scenarioKey: "i2i_male_default", generationMode: "i2i", subjectRenderMode: "human_identity_i2i", rating: 4 });
    // Current run: two attempts rated 4 and 5 (avg 4.5), no concept failures.
    const [cur] = await db.insert(evalRunsTable).values({ label: "cur", createdBy: adminId }).returning({ id: evalRunsTable.id });
    await insertAttempt({ factId, kind: "eval", evalRunId: cur!.id, scenarioKey: "generic_t2i", rating: 4 });
    await insertAttempt({ factId, kind: "eval", evalRunId: cur!.id, scenarioKey: "i2i_male_default", generationMode: "i2i", subjectRenderMode: "human_identity_i2i", rating: 5, failureTag: "none" });
    // Opportunistic (non-run) moderation rating on the golden fact → directional only.
    const oppReview = await makeReview(factId);
    await insertAttempt({ factId, kind: "review", reviewId: oppReview, rating: 1, failureTag: "image_model" });

    const res = await authp(request(app).get(`/admin/eval/dashboard`), adminSid);
    assert.equal(res.status, 200);
    const body = res.body as {
      runs: Array<{ id: number; aggregate: { avgRating: number | null; tagDistribution: Record<string, number> }; byFact: unknown[] }>;
      runDiff: { currentRunId: number; previousRunId: number; avgRatingDelta: number | null } | null;
      opportunistic: { ratedCount: number; avgRating: number | null };
    };
    const curView = body.runs.find((r) => r.id === cur!.id)!;
    assert.equal(curView.aggregate.avgRating, 4.5);
    assert.ok(curView.byFact.length >= 1);
    assert.ok(body.runDiff && body.runDiff.currentRunId === cur!.id && body.runDiff.previousRunId === prev!.id);
    assert.equal(body.runDiff!.avgRatingDelta, 1.5); // 4.5 − 3
    // Opportunistic is separate + directional (the rating:1 attempt is NOT in a run's avg).
    assert.equal(body.opportunistic.ratedCount, 1);
    assert.equal(body.opportunistic.avgRating, 1);

    const drift = await authp(request(app).get(`/admin/eval/dashboard`), plainSid);
    assert.ok(drift.status === 401 || drift.status === 403);
  });
});
