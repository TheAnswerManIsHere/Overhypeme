/**
 * Integration tests for the Step-2 render-scenario routes + the admin-waivable
 * approval gate (routes/reviews.ts + lib/reviewRenderScenarios.ts):
 *   GET  /admin/reviews/:id/render-scenarios
 *   POST /admin/reviews/:id/render-scenarios
 *   POST /admin/reviews/:id/approve-for-production   (visual-render gate)
 *
 * No worker runs in tests, so we assert enqueued attempts/jobs + derived grid
 * state rather than finished images. fal uploads are stubbed off the network.
 * Seeds rows under the `t_rrs_` user prefix.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, imagePromptAttemptsTable, asyncJobsTable, enrichmentOverrideHistoryTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import reviewsRouter, { __setPlanGeneratorForTest } from "../routes/reviews.js";
import adminRouter from "../routes/admin.js";
import { ensureDefaultReviewRenders } from "../lib/reviewRenderScenarios.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_rrs_";
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
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  // The moderation modal edits the staging fact through the SAME fact override
  // endpoints as the Edit Fact screen — mount them so the lockstep write path
  // is exercised end-to-end against review render staleness.
  app.use(adminRouter);
  return app;
}

const insertedFactIds: number[] = [];

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

async function seedReview(submittedById: string, stage = "production_review"): Promise<number> {
  const [fact] = await db.insert(factsTable).values({
    text: "{NAME} bench-presses the Earth.", submittedById, isActive: false, enrichment: ENRICHMENT,
  }).returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: "{NAME} bench-presses the Earth.", submittedById, matchingSimilarity: 0,
    status: "pending", workflowStage: stage as never, stagingFactId: fact!.id,
    enrichment: ENRICHMENT, enrichmentStatus: "ok",
  }).returning({ id: pendingReviewsTable.id });
  return review!.id;
}

let adminId: string, plainId: string, adminSid: string, plainSid: string;

async function cleanup() {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  if (insertedFactIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, insertedFactIds));
    await db.delete(enrichmentOverrideHistoryTable).where(inArray(enrichmentOverrideHistoryTable.factId, insertedFactIds));
  }
  for (const u of users) {
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  insertedFactIds.length = 0;
}

before(async () => {
  await cleanup();
  // Stub fal uploads so the i2i (male) reference resolves without a network call.
  __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
  adminId = await createUser(true);
  plainId = await createUser(false);
  adminSid = await bearer(adminId, true);
  plainSid = await bearer(plainId, false);
});

after(async () => {
  __setReferenceFalUploadForTest(null);
  __setPlanGeneratorForTest(null);
  await cleanup();
  await db.delete(asyncJobsTable).where(and(
    inArray(asyncJobsTable.queue, ["image_prompt_generation", "review_render_scenarios_prepare"]),
    gte(asyncJobsTable.createdAt, TEST_FILE_START),
  ));
});

describe("GET /admin/reviews/:id/render-scenarios", () => {
  it("returns the scenario grid (3 required + 1 non-human card) for admins", async () => {
    const reviewId = await seedReview(plainId);
    const res = await request(makeApp())
      .get(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.reviewId, reviewId);
    assert.equal(res.body.cards.length, 4);
    const byKey = Object.fromEntries(res.body.cards.map((c: { key: string }) => [c.key, c]));
    assert.equal(byKey["generic_t2i"].status, "missing");
    // The non-human card is "skipped" (not applicable, not auto-run) with applicability.
    const nh = res.body.cards.find((c: { key: string }) => c.key.startsWith("i2i_nonhuman"));
    assert.equal(nh.status, "skipped");
    assert.equal(nh.applicability.autoRun, false);
  });

  it("rejects non-admins", async () => {
    const reviewId = await seedReview(plainId);
    const res = await request(makeApp())
      .get(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${plainSid}`);
    assert.equal(res.status, 403);
  });
});

describe("POST /admin/reviews/:id/render-scenarios", () => {
  it("enqueues only the requested scenarios (202) and records attempts", async () => {
    const reviewId = await seedReview(plainId);
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ scenarios: ["generic_t2i"] });
    assert.equal(res.status, 202);
    assert.equal(res.body.enqueued.length, 1);
    assert.equal(res.body.enqueued[0].scenarioKey, "generic_t2i");

    const attempts = await db.select().from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.reviewId, reviewId));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.reviewRenderScenarioKey, "generic_t2i");
    assert.ok(attempts[0]!.reviewRenderInputHash, "input hash recorded");
  });

  it("rejects invalid scenario keys (400)", async () => {
    const reviewId = await seedReview(plainId);
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ scenarios: ["not_a_scenario"] });
    assert.equal(res.status, 400);
  });

  it("refuses to render from a non-production_review stage (409)", async () => {
    const reviewId = await seedReview(plainId, "prep_pending");
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ scenarios: ["generic_t2i"] });
    assert.equal(res.status, 409);
  });

  it("rejects non-admins (403)", async () => {
    const reviewId = await seedReview(plainId);
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${plainSid}`)
      .send({ scenarios: ["generic_t2i"] });
    assert.equal(res.status, 403);
  });
});

describe("moderation enrichment edits via fact override endpoints", () => {
  it("a per-field override PUT persists to the staging fact and flips prior renders stale", async () => {
    const reviewId = await seedReview(plainId);
    const [{ stagingFactId }] = await db
      .select({ stagingFactId: pendingReviewsTable.stagingFactId })
      .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);

    // Enqueue a render against the ORIGINAL enrichment so there's a tile to stale.
    await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ scenarios: ["generic_t2i"] });

    // Per-field override (visualComplexity medium → high) — the moderation
    // modal's tracked-field write path, identical to Edit Fact. The seed is a
    // LEGACY-shaped row (enrichment only, no enrichmentAiDerived), which also
    // pins loadFactOverrideState's derive-baseline-from-effective fallback.
    const save = await request(makeApp())
      .put(`/admin/facts/${stagingFactId}/enrichment-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/visualComplexity", value: "high" });
    assert.equal(save.status, 200);
    assert.equal(save.body.success, true);
    assert.equal((save.body.effective as FactEnrichment).visualComplexity, "high");
    assert.equal(save.body.overrideSummary.overriddenPaths.includes("/visualComplexity"), true);

    // The staging fact now holds the edit in full override-tracking shape:
    // effective updated, baseline preserved, override recorded — nothing wiped.
    const [fact] = await db
      .select({ enrichment: factsTable.enrichment, enrichmentAiDerived: factsTable.enrichmentAiDerived, enrichmentOverrides: factsTable.enrichmentOverrides })
      .from(factsTable).where(eq(factsTable.id, stagingFactId as number)).limit(1);
    assert.equal((fact!.enrichment as FactEnrichment).visualComplexity, "high");
    assert.equal((fact!.enrichmentAiDerived as FactEnrichment).visualComplexity, "medium");
    const ov = (fact!.enrichmentOverrides as Record<string, { value: unknown; overriddenFrom: unknown }>)["/visualComplexity"];
    assert.equal(ov.value, "high");
    assert.equal(ov.overriddenFrom, "medium");

    // The earlier render now reads as stale against the saved effective enrichment.
    const grid = await request(makeApp())
      .get(`/admin/reviews/${reviewId}/render-scenarios`)
      .set("authorization", `Bearer ${adminSid}`);
    const t2i = grid.body.cards.find((c: { key: string }) => c.key === "generic_t2i");
    assert.equal(t2i.stale, true, "the pre-override render is stale after the enrichment edit");
  });

  it("rejects non-admins (403) on the staging-fact override PUT", async () => {
    const reviewId = await seedReview(plainId);
    const [{ stagingFactId }] = await db
      .select({ stagingFactId: pendingReviewsTable.stagingFactId })
      .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);
    const res = await request(makeApp())
      .put(`/admin/facts/${stagingFactId}/enrichment-overrides`)
      .set("authorization", `Bearer ${plainSid}`)
      .send({ path: "/visualComplexity", value: "high" });
    assert.equal(res.status, 403);
  });

  it("the retired whole-blob save returns 410 with a stable code", async () => {
    const reviewId = await seedReview(plainId);
    const res = await request(makeApp())
      .patch(`/admin/reviews/${reviewId}/staging-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: { ...ENRICHMENT, visualComplexity: "high" } });
    assert.equal(res.status, 410);
    assert.equal(res.body.code, "STAGING_ENRICHMENT_RETIRED");
  });
});

describe("ensureDefaultReviewRenders idempotency", () => {
  it("enqueues the default batch once per input hash", async () => {
    const reviewId = await seedReview(plainId);
    const first = await ensureDefaultReviewRenders(reviewId);
    // 3 required scenarios attempted (generic_t2i + i2i male + i2i female). All
    // default references now ship, so each enqueues a real attempt (the stubbed
    // fal upload keeps the i2i reference resolution off-network). Non-human does
    // not auto-run.
    assert.equal(first.enqueued.length, 3);
    const afterFirst = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.reviewId, reviewId));
    assert.equal(afterFirst.length, 3);

    const second = await ensureDefaultReviewRenders(reviewId);
    assert.equal(second.enqueued.length, 0, "re-run enqueues nothing for the same input hash");
    const afterSecond = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.reviewId, reviewId));
    assert.equal(afterSecond.length, 3, "no duplicate attempts");

    // Every required scenario resolved its reference and enqueued cleanly — none
    // failed with reference_asset_unavailable now that all assets are present.
    for (const a of afterSecond) {
      assert.ok(
        !a.error?.includes("reference_asset_unavailable"),
        `scenario ${a.reviewRenderScenarioKey} unexpectedly missing its reference: ${a.error}`,
      );
    }
  });

  it("does NOT enqueue paid renders once the review has left production_review", async () => {
    const reviewId = await seedReview(plainId, "production_rejected");
    const { enqueued } = await ensureDefaultReviewRenders(reviewId);
    assert.equal(enqueued.length, 0, "a resolved/rejected review must not auto-render");
    const attempts = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.reviewId, reviewId));
    assert.equal(attempts.length, 0);
  });
});

describe("approval visual-render gate (admin-waivable)", () => {
  it("blocks approval naming the missing required scenarios (409)", async () => {
    const reviewId = await seedReview(plainId);
    // The visual gate runs BEFORE the render preflight, so no planner stub needed.
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "visual_render_incomplete");
    const keys = res.body.problems.map((p: { scenarioKey: string }) => p.scenarioKey).sort();
    assert.deepEqual(keys, ["generic_t2i", "i2i_female_default", "i2i_male_default"]);
  });

  it("rejects a partial waiver that doesn't name every problem (409)", async () => {
    const reviewId = await seedReview(plainId);
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ waiveVisualRenderIssues: true, waivedScenarioKeys: ["generic_t2i"] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "visual_render_incomplete");
  });
});
