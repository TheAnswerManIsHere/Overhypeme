/**
 * Integration tests for moderation enrichment edits and a gag's kind renders
 * (lib/reviewRenderScenarios.ts). The review-wide scenario grid, its routes
 * and the waivable visual-render gate were retired by plan
 * PLAN_GAG_EXAMPLES.md: renders are per gag and per kind (male, female, pet),
 * and a changed input draws afresh rather than marking an old render stale.
 *
 * No worker runs in tests, so we assert enqueued attempts rather than
 * finished images. fal uploads are stubbed off the network.
 * Seeds rows under the `t_rrs_` user prefix.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, factGagsTable, pendingReviewsTable, imagePromptAttemptsTable, asyncJobsTable, enrichmentOverrideHistoryTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import { type FactEnrichment } from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import { withCast } from "./helpers/gagCast.js";
import adminRouter from "../routes/admin.js";
import { drawGagKinds } from "../lib/reviewRenderScenarios.js";
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
  characters: [],
};

// A fact reaching production_review has an approved gag (fact_gags, migration 0139).
const GAG = withCast({
  version: 1 as const,
  coreSceneOverride: "{NAME} bench-presses the Earth overhead in a stadium.",
  requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
  bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
});

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
const gagOf = new Map<number, number>();

async function createUser(isAdmin: boolean): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, isAdmin,
    membershipTier: isAdmin ? "legendary" : "registered", emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
  });
  return id;
}

async function bearer(userId: string, isAdmin: boolean): Promise<string> {
  return createSession({
    user: { id: userId, membershipTier: isAdmin ? "legendary" : "registered" } as unknown as SessionData["user"],
    access_token: "test-token", isAdmin,
  }, userId);
}

async function seedReview(submittedById: string, stage = "test_renders"): Promise<number> {
  const [fact] = await db.insert(factsTable).values({
    text: "{NAME} bench-presses the Earth.", submittedById, isActive: false, enrichment: ENRICHMENT,
  }).returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  // A submission's gag is in its draft (migration 0157).
  await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, pendingContent: GAG });
  gagOf.set(fact!.id, (await db.select({ id: factGagsTable.id }).from(factGagsTable).where(eq(factGagsTable.factId, fact!.id)))[0]!.id);
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

// One wrapper scopes the file-level hooks to this file: with test isolation off,
// root-level hooks run for the whole shard, so another file's cleanup could
// clear this file's fal stub before its tests ran.
describe("review render scenarios", () => {
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
  await cleanup();
  await db.delete(asyncJobsTable).where(and(
    inArray(asyncJobsTable.queue, ["image_prompt_generation", "review_render_scenarios_prepare"]),
    gte(asyncJobsTable.createdAt, TEST_FILE_START),
  ));
});

describe("moderation enrichment edits via fact override endpoints", () => {
  it("a per-field override PUT persists to the staging fact and leaves prior renders current (the picture is drawn from the gag alone)", async () => {
    const reviewId = await seedReview(plainId);
    const [{ stagingFactId }] = await db
      .select({ stagingFactId: pendingReviewsTable.stagingFactId })
      .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);

    const gagId = gagOf.get(stagingFactId as number)!;
    // A male render against the ORIGINAL enrichment; drawing again reuses it.
    const first = await drawGagKinds(gagId, ["male"], { adminUserId: adminId });
    assert.ok(!("error" in first), JSON.stringify(first));
    assert.equal(first.enqueued.length, 1);
    const again = await drawGagKinds(gagId, ["male"], { adminUserId: adminId });
    assert.ok(!("error" in again));
    assert.equal(again.enqueued.length, 0, "the same input reuses its render");

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

    // A classification edit shapes no picture since the switch
    // (PLAN_GAG_DIRECT_RENDER.md, D): the earlier render still matches and is reused.
    const after = await drawGagKinds(gagId, ["male"], { adminUserId: adminId });
    assert.ok(!("error" in after));
    assert.equal(after.enqueued.length, 0, "the pre-override render is reused after a classification edit");
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
});

});
