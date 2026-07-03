/**
 * Integration tests for candidate Visual-concept generation (Slice 2A):
 *   - the fact_visual_concepts job handler (writes 3 candidates + status "ok",
 *     stamps reviewId + inputHash from the STAGING enrichment; no-ops when the
 *     review is resolved) — the generator is stubbed off the network.
 *   - server-computed `current` staleness (buildVisualConceptsResponse).
 *   - POST /admin/reviews/:id/visual-concepts/regenerate (202 + status pending;
 *     admin-auth drift; stage guard).
 *   - GET /admin/reviews/:id surfaces the visualConcepts block.
 *
 * No worker runs; we invoke the handler directly. Seeds under `t_vc_`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, asyncJobsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import {
  visualConceptCandidatesBlobSchema,
  type FactEnrichment,
  type VisualConceptProvenance,
} from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import {
  runVisualConceptsJob,
  buildVisualConceptsResponse,
  type VisualConceptsJobDeps,
} from "../lib/visualConceptJobs.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_vc_";
const TEST_FILE_START = new Date();
const FACT_TEXT = "{NAME} bench-presses the Earth.";

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

const PROVENANCE: VisualConceptProvenance = {
  engineId: "openai-visual-planner",
  model: "gpt-5.5",
  reasoningEffort: "high",
  timeoutMs: 180_000,
  promptVersion: 1,
  fallbackReason: null,
};

function stubGenerate(sceneSuffix = ""): VisualConceptsJobDeps["generate"] {
  return async () => ({
    candidates: [1, 2, 3].map((n) => ({
      title: `Concept ${n}`,
      whyItWorks: "It lands.",
      sceneDescription: `{NAME} lifts the planet, variant ${n}${sceneSuffix}.`,
      tokenValid: true,
    })),
    provenance: PROVENANCE,
  });
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

async function seedReview(submittedById: string, stage = "production_review"): Promise<{ reviewId: number; factId: number }> {
  const [fact] = await db.insert(factsTable).values({
    text: FACT_TEXT, submittedById, isActive: false, enrichment: ENRICHMENT,
  }).returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: FACT_TEXT, submittedById, matchingSimilarity: 0,
    status: "pending", workflowStage: stage as never, stagingFactId: fact!.id,
    enrichment: ENRICHMENT, enrichmentStatus: "ok",
  }).returning({ id: pendingReviewsTable.id });
  return { reviewId: review!.id, factId: fact!.id };
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  return app;
}

async function cleanup() {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  insertedFactIds.length = 0;
}

let adminId: string, plainId: string, adminSid: string, plainSid: string;

before(async () => {
  await cleanup();
  adminId = await createUser(true);
  plainId = await createUser(false);
  adminSid = await bearer(adminId, true);
  plainSid = await bearer(plainId, false);
});

after(async () => {
  await cleanup();
  await db.delete(asyncJobsTable).where(and(
    inArray(asyncJobsTable.queue, ["fact_visual_concepts"]),
    gte(asyncJobsTable.createdAt, TEST_FILE_START),
  ));
});

async function factConceptState(factId: number) {
  const [row] = await db
    .select({ status: factsTable.visualConceptStatus, blob: factsTable.visualConceptCandidates })
    .from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  return row!;
}

describe("fact_visual_concepts handler", () => {
  it("writes 3 candidates + status ok, stamping reviewId + a staging-fact inputHash", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    const res = await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    assert.equal(res.ok, true);

    const state = await factConceptState(factId);
    assert.equal(state.status, "ok");
    const parsed = visualConceptCandidatesBlobSchema.safeParse(state.blob);
    assert.ok(parsed.success, "stored blob validates");
    assert.equal(parsed.data!.candidates.length, 3);
    assert.equal(parsed.data!.reviewId, reviewId);
    assert.equal(parsed.data!.source, "staging_fact");
    assert.equal(parsed.data!.candidateVersionId, null);
    assert.ok(parsed.data!.inputHash.length > 0);
  });

  it("no-ops (writes nothing) when the review is already resolved", async () => {
    const { reviewId, factId } = await seedReview(adminId, "production_rejected");
    const res = await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    assert.equal(res.ok, true);
    const state = await factConceptState(factId);
    // Never generated: status untouched (null), no blob.
    assert.equal(state.status, null);
    assert.equal(state.blob, null);
  });

  it("returns a retryable failure when generation throws (status stays pending, not failed)", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    await db.update(factsTable).set({ visualConceptStatus: "pending" }).where(eq(factsTable.id, factId));
    const res = await runVisualConceptsJob(
      { reviewId, factId },
      { generate: async () => { throw new Error("boom"); } },
    );
    assert.equal(res.ok, false);
    const state = await factConceptState(factId);
    assert.equal(state.status, "pending"); // failed is onAbandon-only
  });
});

describe("buildVisualConceptsResponse — server-computed current flag", () => {
  it("current=true right after a fresh write, then stale after the enrichment changes", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });

    const state = await factConceptState(factId);
    const fresh = await buildVisualConceptsResponse({
      id: reviewId, candidateVersionId: null,
      visualConceptStatus: state.status, visualConceptCandidates: state.blob,
    });
    assert.equal(fresh.status, "ok");
    assert.equal(fresh.candidates.length, 3);
    assert.equal(fresh.current, true);
    assert.equal(fresh.staleReason, undefined);

    // Change a render-affecting enrichment field → the input hash moves.
    await db.update(factsTable)
      .set({ enrichment: { ...ENRICHMENT, primaryArchetype: "impossible_knowledge_or_skill" } })
      .where(eq(factsTable.id, factId));
    const stale = await buildVisualConceptsResponse({
      id: reviewId, candidateVersionId: null,
      visualConceptStatus: state.status, visualConceptCandidates: state.blob,
    });
    assert.equal(stale.current, false);
    assert.equal(stale.staleReason, "input_hash_mismatch");
  });

  it("flags review_mismatch when the stored blob belongs to a different review", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    const state = await factConceptState(factId);
    const res = await buildVisualConceptsResponse({
      id: reviewId + 987654, candidateVersionId: null,
      visualConceptStatus: state.status, visualConceptCandidates: state.blob,
    });
    assert.equal(res.current, false);
    assert.equal(res.staleReason, "review_mismatch");
  });

  it("reports status-only (no candidates) when there is no stored blob", async () => {
    const res = await buildVisualConceptsResponse({
      id: 1, candidateVersionId: null, visualConceptStatus: "pending", visualConceptCandidates: null,
    });
    assert.deepEqual(res, { status: "pending", candidates: [], current: false });
  });
});

describe("POST /admin/reviews/:id/visual-concepts/regenerate", () => {
  const app = makeApp();

  it("202 + sets status pending for an admin on a production_review", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    const res = await request(app)
      .post(`/admin/reviews/${reviewId}/visual-concepts/regenerate`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ coreSceneDraft: "{NAME} lifts a globe in a library." });
    assert.equal(res.status, 202);
    assert.equal(res.body.visualConceptStatus, "pending");
    const state = await factConceptState(factId);
    assert.equal(state.status, "pending");
    // A job was enqueued for this review.
    const [job] = await db.select({ id: asyncJobsTable.id })
      .from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "fact_visual_concepts"), eq(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${reviewId}`)))
      .limit(1);
    assert.ok(job, "enqueued a fact_visual_concepts job");
  });

  it("rejects a non-admin (auth drift)", async () => {
    const { reviewId } = await seedReview(adminId);
    const res = await request(app)
      .post(`/admin/reviews/${reviewId}/visual-concepts/regenerate`)
      .set("authorization", `Bearer ${plainSid}`)
      .send({});
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  });

  it("409 when the review is not in production_review", async () => {
    const { reviewId } = await seedReview(adminId, "prep_pending");
    const res = await request(app)
      .post(`/admin/reviews/${reviewId}/visual-concepts/regenerate`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 409);
  });
});

describe("GET /admin/reviews/:id surfaces visualConcepts", () => {
  const app = makeApp();

  it("includes the normalized visualConcepts block once candidates exist", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    const res = await request(app)
      .get(`/admin/reviews/${reviewId}`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.visualConcepts, "visualConcepts present");
    assert.equal(res.body.visualConcepts.status, "ok");
    assert.equal(res.body.visualConcepts.candidates.length, 3);
    assert.equal(res.body.visualConcepts.current, true);
  });
});
