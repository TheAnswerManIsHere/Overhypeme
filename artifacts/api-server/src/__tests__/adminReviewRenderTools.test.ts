/**
 * Integration tests for the moderation render-review tools in routes/reviews.ts:
 *   GET  /admin/reviews/:id/pexels-images
 *   POST /admin/reviews/:id/render
 *   GET  /admin/reviews/:id/renders/:renderJobId
 *
 * Uses the real authMiddleware + session bearer harness (same as
 * routes.reviews.test.ts). The render route only ENQUEUES the async job (no
 * worker runs in tests), so we assert the 202 + the inserted attempt row rather
 * than a finished image. Seeds rows under the `t_mrr_` user prefix.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  pendingReviewsTable,
  imagePromptAttemptsTable,
  asyncJobsTable,
} from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import { buildRenderStatusPayload } from "../lib/imagePromptAttempts.js";
import { resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_mrr_";
const TEST_FILE_START = new Date();

const VALID_ENRICHMENT: FactEnrichment = {
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

const PEXELS_IMAGES = {
  fact_type: "action" as const,
  keywords: { male: "man lifting", female: "woman lifting", neutral: "person lifting" },
  male: [
    { id: 101, url: "https://images.pexels.com/legacy-101.jpg", photographer: "Ada L", photographer_url: "https://pexels.com/@ada" },
  ],
  female: [
    {
      id: 201,
      url: "https://images.pexels.com/legacy-201.jpg",
      src: { large2x: "https://images.pexels.com/201-large2x.jpg", large: "https://images.pexels.com/201-large.jpg" },
      photographer: "Bo P",
    },
  ],
  neutral: [
    { id: 301, url: "https://images.pexels.com/legacy-301.jpg" },
    { id: 302, url: "https://images.pexels.com/legacy-302.jpg" },
  ],
};

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
  stage?: string;
  withStaging?: boolean;
  enrichment?: unknown;
  pexelsImages?: unknown;
  pexelsStatus?: "pending" | "ok" | "failed" | null;
}): Promise<{ reviewId: number; stagingFactId: number | null }> {
  let stagingFactId: number | null = null;
  if (opts.withStaging !== false) {
    const [fact] = await db
      .insert(factsTable)
      .values({
        text: "{NAME} bench-presses the Earth.",
        submittedById: opts.submittedById,
        isActive: false,
        enrichment: (opts.enrichment ?? VALID_ENRICHMENT) as FactEnrichment,
        pexelsImages: (opts.pexelsImages ?? null) as never,
        pexelsStatus: opts.pexelsStatus ?? null,
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
      workflowStage: (opts.stage ?? "production_review") as never,
      stagingFactId,
    })
    .returning({ id: pendingReviewsTable.id });
  return { reviewId: review!.id, stagingFactId };
}

let adminId: string;
let plainId: string;
let adminSid: string;
let plainSid: string;

async function cleanup() {
  if (insertedFactIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, insertedFactIds));
  }
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
  // Drop any image_prompt_generation jobs this file enqueued so no worker runs them.
  await db
    .delete(asyncJobsTable)
    .where(and(eq(asyncJobsTable.queue, "image_prompt_generation"), gte(asyncJobsTable.createdAt, TEST_FILE_START)));
});

// ── buildRenderStatusPayload (pure mapping) ───────────────────────────────────

describe("buildRenderStatusPayload", () => {
  const base = {
    id: 5, subjectRenderMode: "t2i_fallback", generationMode: "t2i",
    visualPlan: null, compiledPrompt: null, subjectFactCompatibility: null,
    generatedImageObjectPath: null, error: null,
  } as never;
  it("pending when nothing produced yet", () => {
    assert.equal(buildRenderStatusPayload(base).status, "pending");
  });
  it("prompt_ready once a visual plan exists", () => {
    assert.equal(buildRenderStatusPayload({ ...(base as object), visualPlan: { a: 1 } } as never).status, "prompt_ready");
  });
  it("image_ready once an image path exists", () => {
    assert.equal(
      buildRenderStatusPayload({ ...(base as object), visualPlan: { a: 1 }, generatedImageObjectPath: "/objects/x.png" } as never).status,
      "image_ready",
    );
  });
  it("blocked for poor subject↔fact compatibility", () => {
    const p = buildRenderStatusPayload({ ...(base as object), error: "subject_fact_compatibility_poor" } as never);
    assert.equal(p.status, "blocked");
    assert.equal(p.blocked, true);
    assert.equal(p.error, null);
  });
  it("failed for any other error", () => {
    const p = buildRenderStatusPayload({ ...(base as object), error: "fal submit failed" } as never);
    assert.equal(p.status, "failed");
    assert.equal(p.error, "fal submit failed");
  });
});

// ── Shared preview/render assembly (parity) ───────────────────────────────────
// Both POST /admin/image-prompt/preview (fact path) and POST /admin/reviews/:id/
// render delegate token resolution + mode/identity/style assembly to this one
// function, so they cannot drift. Determinism here = parity there.

describe("resolveRenderReviewInput", () => {
  it("resolves tokens to the sample subject and assembles a t2i input", async () => {
    const r = await resolveRenderReviewInput("{NAME} bench-presses the Earth.", VALID_ENRICHMENT, {
      subjectRenderMode: "t2i_fallback",
      previewName: "Casey Park",
      previewPronouns: "she/her",
      renderControls: { fallbackSubjectGender: "female", aspectRatio: "landscape" },
    });
    assert.match(r.renderedFactText, /Casey Park/);
    assert.doesNotMatch(r.renderedFactText, /\{NAME\}/);
    assert.equal(r.subjectRenderMode, "t2i_fallback");
    assert.equal(r.generationMode, "t2i");
    assert.equal(r.renderControls.fallbackSubjectGender, "female");
    assert.equal(r.renderControls.aspectRatio, "landscape");
    assert.equal(r.renderedSubject.name, "Casey Park");
  });

  it("is deterministic for identical inputs (no cross-route drift)", async () => {
    const controls = { subjectRenderMode: "t2i_fallback" as const, previewName: "Sam Vale", renderControls: { fallbackSubjectGender: "neutral" as const } };
    const a = await resolveRenderReviewInput("{NAME} flies.", VALID_ENRICHMENT, controls);
    const b = await resolveRenderReviewInput("{NAME} flies.", VALID_ENRICHMENT, controls);
    assert.equal(a.renderedFactText, b.renderedFactText);
    assert.deepEqual(a.renderControls, b.renderControls);
    assert.deepEqual(a.identityPolicy, b.identityPolicy);
  });
});

// ── GET /admin/reviews/:id/pexels-images ──────────────────────────────────────

describe("GET /admin/reviews/:id/pexels-images", () => {
  it("401 unauthenticated, 403 non-admin", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId, pexelsStatus: "ok", pexelsImages: PEXELS_IMAGES });
    const anon = await request(makeApp()).get(`/admin/reviews/${reviewId}/pexels-images`);
    assert.equal(anon.status, 401);
    const nonAdmin = await request(makeApp()).get(`/admin/reviews/${reviewId}/pexels-images`).set("authorization", `Bearer ${plainSid}`);
    assert.equal(nonAdmin.status, 403);
  });

  it("serves the staging (inactive) fact's images across all genders, preferring src urls", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId, pexelsStatus: "ok", pexelsImages: PEXELS_IMAGES });
    const res = await request(makeApp()).get(`/admin/reviews/${reviewId}/pexels-images`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.pexelsStatus, "ok");
    assert.equal(res.body.factType, "action");
    assert.equal(res.body.images.neutral.length, 2);
    // Legacy entry (only `url`) still renders.
    assert.equal(res.body.images.male[0].url, "https://images.pexels.com/legacy-101.jpg");
    assert.equal(res.body.images.male[0].photographer, "Ada L");
    // Prefers src.large2x when present.
    assert.equal(res.body.images.female[0].url, "https://images.pexels.com/201-large2x.jpg");
  });

  it("ok + zero images is distinct from pending/failed", async () => {
    const { reviewId } = await seedReview({
      submittedById: plainId,
      pexelsStatus: "ok",
      pexelsImages: { fact_type: "abstract", male: [], female: [], neutral: [] },
    });
    const res = await request(makeApp()).get(`/admin/reviews/${reviewId}/pexels-images`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.pexelsStatus, "ok");
    assert.equal(res.body.images.male.length + res.body.images.female.length + res.body.images.neutral.length, 0);
  });

  it("returns empty + null status when there is no staging fact", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId, withStaging: false, stage: "triage_pending" });
    const res = await request(makeApp()).get(`/admin/reviews/${reviewId}/pexels-images`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.pexelsStatus, null);
    assert.equal(res.body.images.neutral.length, 0);
  });
});

// ── POST /admin/reviews/:id/render ────────────────────────────────────────────

describe("POST /admin/reviews/:id/render", () => {
  it("403 for non-admin", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/render`).set("authorization", `Bearer ${plainSid}`).send({});
    assert.equal(res.status, 403);
  });

  it("409 when not in production_review", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId, stage: "prep_pending" });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/render`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 409);
  });

  it("400 i2i_unavailable_in_moderation without enqueueing", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId });
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ subjectRenderMode: "human_identity_i2i" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "i2i_unavailable_in_moderation");
  });

  it("400 fact_enrichment_invalid for an unusable staging enrichment", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId, enrichment: { primaryArchetype: "nope" } });
    const res = await request(makeApp()).post(`/admin/reviews/${reviewId}/render`).set("authorization", `Bearer ${adminSid}`).send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "fact_enrichment_invalid");
  });

  it("202 + inserts an ephemeral, audited, t2i attempt for the staging fact", async () => {
    const { reviewId, stagingFactId } = await seedReview({ submittedById: plainId });
    const res = await request(makeApp())
      .post(`/admin/reviews/${reviewId}/render`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ previewName: "Casey Park", previewPronouns: "she/her", renderControls: { aspectRatio: "landscape", fallbackSubjectGender: "female" } });

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.ok(res.body.renderJobId);
    assert.ok(res.body.attemptId);

    const [attempt] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, res.body.attemptId)).limit(1);
    assert.ok(attempt);
    assert.equal(attempt!.factId, stagingFactId);
    assert.equal(attempt!.userId, null);
    assert.equal(attempt!.subjectRenderMode, "t2i_fallback");
    assert.equal(attempt!.generationMode, "t2i");
    assert.match(String(attempt!.renderedFactText), /Casey Park/);
    assert.doesNotMatch(String(attempt!.renderedFactText), /\{NAME\}/);
    assert.match(String(attempt!.requestId), new RegExp(`^admin-review:${reviewId}:${adminId}:`));

    const rc = attempt!.renderControls as Record<string, unknown>;
    assert.equal(rc["mirrorToLegacyStorage"], false);
    assert.equal((rc["reviewRenderSubject"] as { name: string }).name, "Casey Park");
    assert.deepEqual(rc["reviewAudit"], { reviewId, adminUserId: adminId });
    assert.equal(rc["aspectRatio"], "landscape");
  });
});

// ── GET /admin/reviews/:id/renders/:renderJobId (admin-gated poll) ─────────────

describe("GET /admin/reviews/:id/renders/:renderJobId", () => {
  async function seedAttempt(reviewId: number, factId: number): Promise<string> {
    const renderJobId = randomUUID();
    await db.insert(imagePromptAttemptsTable).values({
      factId,
      userId: null,
      renderJobId,
      generationMode: "t2i",
      subjectRenderMode: "t2i_fallback",
      targetEngine: "nano_banana_2",
      sourceImageAnalysis: {} as never,
      identityPolicy: {} as never,
      renderControls: { aspectRatio: "portrait", reviewAudit: { reviewId, adminUserId: adminId } } as never,
      factEnrichmentSnapshot: VALID_ENRICHMENT as never,
      renderedFactText: "Casey bench-presses the Earth.",
      archetypeStrategyVersion: "v2",
      visualPlan: { a: 1 } as never,
    });
    return renderJobId;
  }

  it("403 non-admin, 200 admin with status payload", async () => {
    const { reviewId, stagingFactId } = await seedReview({ submittedById: plainId });
    const renderJobId = await seedAttempt(reviewId, stagingFactId!);

    const nonAdmin = await request(makeApp()).get(`/admin/reviews/${reviewId}/renders/${renderJobId}`).set("authorization", `Bearer ${plainSid}`);
    assert.equal(nonAdmin.status, 403);

    const ok = await request(makeApp()).get(`/admin/reviews/${reviewId}/renders/${renderJobId}`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "prompt_ready");
  });

  it("404 when the attempt's reviewAudit does not match the path review id", async () => {
    const a = await seedReview({ submittedById: plainId });
    const b = await seedReview({ submittedById: plainId });
    const renderJobId = await seedAttempt(a.reviewId, a.stagingFactId!);
    const res = await request(makeApp()).get(`/admin/reviews/${b.reviewId}/renders/${renderJobId}`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 404);
  });

  it("404 for an unknown renderJobId", async () => {
    const { reviewId } = await seedReview({ submittedById: plainId });
    const res = await request(makeApp()).get(`/admin/reviews/${reviewId}/renders/${randomUUID()}`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 404);
  });
});
