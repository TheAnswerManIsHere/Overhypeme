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
import { usersTable, factsTable, pendingReviewsTable, asyncJobsTable, adminConfigTable, factGagsTable } from "@workspace/db/schema";
import { ALL_ENGINES } from "../lib/engines/index.js";
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
import { generateVisualConcepts } from "../lib/visualConcepts/generator.js";
import { bustConfigCache } from "../lib/adminConfig.js";

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
      bubbles: [],
    })),
    provenance: PROVENANCE,
  });
}

const insertedFactIds: number[] = [];

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

async function seedReview(
  submittedById: string,
  stage = "test_renders",
  enrichment: FactEnrichment = ENRICHMENT,
): Promise<{ reviewId: number; factId: number }> {
  // The gag lives in fact_gags (migration 0139): a first-time submission's
  // saved gag is a new gag's pending version.
  const { visualPromptStrategyOverride: gag, ...classification } = enrichment as FactEnrichment & { visualPromptStrategyOverride?: unknown };
  enrichment = classification as FactEnrichment;
  const [fact] = await db.insert(factsTable).values({
    text: FACT_TEXT, submittedById, isActive: false, enrichment,
  }).returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  if (gag) await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, pendingContent: gag as never });
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: FACT_TEXT, submittedById, matchingSimilarity: 0,
    status: "pending", workflowStage: stage as never, stagingFactId: fact!.id,
    enrichment, enrichmentStatus: "ok",
  }).returning({ id: pendingReviewsTable.id });
  // The review owns the fact's ideas, as every enqueue path claims it (migration 0140).
  await db.update(factsTable).set({ visualConceptOwner: `review:${review!.id}` }).where(eq(factsTable.id, fact!.id));
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
    assert.ok(parsed.data!.inputHash.length > 0);
  });

  it("no-ops (writes nothing) when the review is already resolved", async () => {
    const { reviewId, factId } = await seedReview(adminId, "rejected");
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
  it("current=true right after a fresh write; a taxonomy change leaves it current, a gag change stales it", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });

    const state = await factConceptState(factId);
    const fresh = await buildVisualConceptsResponse({
      id: reviewId,
      visualConceptStatus: state.status, visualConceptCandidates: state.blob,
    });
    assert.equal(fresh.status, "ok");
    assert.equal(fresh.candidates.length, 3);
    assert.equal(fresh.current, true);
    assert.equal(fresh.staleReason, undefined);

    // The taxonomy is not a writer input (Issue #1018, increment 1.2c-ii): a
    // taxonomy run finishing after the ideas leaves them current.
    await db.update(factsTable)
      .set({ enrichment: { ...ENRICHMENT, primaryArchetype: "impossible_knowledge_or_skill" } })
      .where(eq(factsTable.id, factId));
    const still = await buildVisualConceptsResponse({
      id: reviewId,
      visualConceptStatus: state.status, visualConceptCandidates: state.blob,
    });
    assert.equal(still.current, true);

    // A gag the writer is shown → the input hash moves.
    await db.insert(factGagsTable).values({ factId, slot: 1, pendingContent: { version: 1, requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [], bubbles: [], coreSceneOverride: "{NAME} hoists the planet overhead." } as never });
    const stale = await buildVisualConceptsResponse({
      id: reviewId,
      visualConceptStatus: state.status, visualConceptCandidates: state.blob,
    });
    assert.equal(stale.current, false);
    assert.equal(stale.staleReason, "input_hash_mismatch");
  });

  // Saving the Visual Concept or a bubble (an edit to visualPromptStrategyOverride,
  // archetype and every other field unchanged) must also stale the stored ideas.
  const withOverride = (partial: Record<string, unknown>): FactEnrichment => ({
    ...ENRICHMENT,
    visualPromptStrategyOverride: {
      version: 1,
      requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
      compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
      bubbles: [],
      coreSceneOverride: "{NAME} hoists the planet overhead.",
      ...partial,
    },
  }) as unknown as FactEnrichment;

  const editCases: Array<{ name: string; edit: Record<string, unknown> }> = [
    { name: "editing and saving the Concept", edit: { coreSceneOverride: "{NAME} hoists the planet over a crowded stadium." } },
    {
      name: "editing and saving a bubble",
      edit: { bubbles: [{ type: "speech", entity: "subject", text: "Still got it." }] },
    },
  ];
  for (const { name, edit } of editCases) {
    it(`${name} makes the stored ideas stale (input_hash_mismatch) with the archetype untouched`, async () => {
      const original = withOverride({ bubbles: [{ type: "speech", entity: "subject", text: "Heavy." }] });
      const { reviewId, factId } = await seedReview(adminId, "gags", original);
      await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
      const state = await factConceptState(factId);
      const review = { id: reviewId, visualConceptStatus: state.status, visualConceptCandidates: state.blob };

      assert.equal((await buildVisualConceptsResponse(review)).current, true, "fresh ideas are current");

      // A save that rewrites the same enrichment unchanged leaves the ideas current.
      const saveGag = (e: FactEnrichment) => db.update(factGagsTable)
        .set({ pendingContent: (e as unknown as { visualPromptStrategyOverride: unknown }).visualPromptStrategyOverride as never })
        .where(eq(factGagsTable.factId, factId));
      await saveGag(original);
      assert.equal((await buildVisualConceptsResponse(review)).current, true, "an unchanged re-save does not stale");

      await saveGag(withOverride({ bubbles: [{ type: "speech", entity: "subject", text: "Heavy." }], ...edit }));
      const stale = await buildVisualConceptsResponse(review);
      assert.equal(stale.current, false);
      assert.equal(stale.staleReason, "input_hash_mismatch");
      // The candidates themselves are still returned — staleness is advisory.
      assert.equal(stale.candidates.length, 3);
    });
  }

  it("flags review_mismatch when the stored blob belongs to a different review", async () => {
    const { reviewId, factId } = await seedReview(adminId);
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    const state = await factConceptState(factId);
    const res = await buildVisualConceptsResponse({
      id: reviewId + 987654,
      visualConceptStatus: state.status, visualConceptCandidates: state.blob,
    });
    assert.equal(res.current, false);
    assert.equal(res.staleReason, "review_mismatch");
  });

  it("reports status-only (no candidates) when there is no stored blob", async () => {
    const res = await buildVisualConceptsResponse({
      id: 1, visualConceptStatus: "pending", visualConceptCandidates: null,
    });
    assert.deepEqual(res, { status: "pending", candidates: [], current: false, humorNote: null });
  });
});

describe("POST /admin/reviews/:id/visual-concepts/regenerate", () => {
  const app = makeApp();

  it("202 + sets status pending for an admin at Gags", async () => {
    const { reviewId, factId } = await seedReview(adminId, "gags");
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
      .where(and(eq(asyncJobsTable.queue, "fact_visual_concepts"), like(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${reviewId}:%`)))
      .limit(1);
    assert.ok(job, "enqueued a fact_visual_concepts job");
  });

  it("rejects a non-admin (auth drift)", async () => {
    const { reviewId } = await seedReview(adminId, "gags");
    const res = await request(app)
      .post(`/admin/reviews/${reviewId}/visual-concepts/regenerate`)
      .set("authorization", `Bearer ${plainSid}`)
      .send({});
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  });

  it("409 when the review is not at Gags (regenerate is a Gags action)", async () => {
    const { reviewId } = await seedReview(adminId, "reading");
    const res = await request(app)
      .post(`/admin/reviews/${reviewId}/visual-concepts/regenerate`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 409);
  });

  it("409 IDEAS_PENDING: regenerate is blocked while a concept job is in flight (no coalescing on stale)", async () => {
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await db.update(factsTable).set({ visualConceptStatus: "pending" }).where(eq(factsTable.id, factId));
    const res = await request(app)
      .post(`/admin/reviews/${reviewId}/visual-concepts/regenerate`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "IDEAS_PENDING");
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

// ─── The gag writer (plan docs/plans/PLAN_GAG_GENERATOR.md) ─────────────────

describe("the gag writer: humor note, joke read and freshness", () => {
  const app = makeApp();

  async function note(factId: number) {
    const [row] = await db.select({ text: factsTable.humorNote, by: factsTable.humorNoteApprovedBy, at: factsTable.humorNoteApprovedAt })
      .from(factsTable).where(eq(factsTable.id, factId)).limit(1);
    return row!;
  }
  async function response(reviewId: number, factId: number) {
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, factId)).limit(1);
    return buildVisualConceptsResponse({
      id: reviewId,
      visualConceptStatus: row!.visualConceptStatus, visualConceptCandidates: row!.visualConceptCandidates,
      humorNote: row!.humorNote, humorNoteApprovedBy: row!.humorNoteApprovedBy, humorNoteApprovedAt: row!.humorNoteApprovedAt,
    });
  }

  it("the job sends the saved note, the fact's gags, the render policy and the draft with its bubbles", async () => {
    const live = { ...ENRICHMENT, visualPromptStrategyOverride: { version: 1, coreSceneOverride: "{NAME} lifts the moon (gag A).", bubbles: [{ type: "speech", entity: "subject", text: "Light." }], violencePolicyOverride: { mode: "soften", intensity: "strong" } } } as unknown as FactEnrichment;
    const { reviewId, factId } = await seedReview(adminId, "gags", live);
    await db.update(factsTable).set({ humorNote: "Alex lifts what nobody can.", humorNoteApprovedBy: adminId, humorNoteApprovedAt: new Date() }).where(eq(factsTable.id, factId));
    let seen: Parameters<VisualConceptsJobDeps["generate"]>[0] | null = null;
    const res = await runVisualConceptsJob(
      { reviewId, factId, moderatorDraftScene: "{NAME} juggles planets (draft C).", moderatorDraftBubbles: [{ type: "thought", entity: "subject", text: "Easy." }] },
      { generate: async (input) => { seen = input; return stubGenerate()(input); } },
    );
    assert.equal(res.ok, true);
    assert.ok(seen);
    const got = seen as unknown as Parameters<VisualConceptsJobDeps["generate"]>[0];
    assert.equal(got.humorNote, "Alex lifts what nobody can.");
    assert.equal(got.existingGags.length, 1);
    assert.equal(got.existingGags[0]?.scene, "{NAME} lifts the moon (gag A).");
    assert.equal(got.existingGags[0]?.bubbles[0]?.text, "Light.");
    assert.equal(got.draft?.scene, "{NAME} juggles planets (draft C).");
    assert.equal(got.draft?.bubbles[0]?.text, "Easy.");
    assert.equal(got.renderPolicy.violence.mode, "soften");
  });

  it("sends each gag's version being worked on: its pending change over the approved one (plan PLAN_THREE_GAGS.md, increment 2)", async () => {
    // The gag holds a published version A and a draft change B; a gag
    // removed in the draft is not sent (migration 0157). Published content
    // needs a fact approved for production on record.
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await db.update(factsTable).set({ approvedAt: new Date(), approvalSource: "legacy" }).where(eq(factsTable.id, factId));
    await db.insert(factGagsTable).values({
      factId, slot: 2, approvedContent: { version: 1, coreSceneOverride: "{NAME} removed in the draft." } as never,
      approvedCarriedOver: true, draftRemoved: true,
    });
    await db.insert(factGagsTable).values({
      factId, slot: 1,
      approvedContent: { version: 1, coreSceneOverride: "{NAME} approved gag A." } as never, approvedCarriedOver: true,
      pendingContent: { version: 1, coreSceneOverride: "{NAME} pending change B." } as never,
    });
    let seen: Parameters<VisualConceptsJobDeps["generate"]>[0] | null = null;
    await runVisualConceptsJob({ reviewId, factId, moderatorDraftScene: "{NAME} draft C." }, { generate: async (input) => { seen = input; return stubGenerate()(input); } });
    const got = seen as unknown as Parameters<VisualConceptsJobDeps["generate"]>[0];
    assert.deepEqual(got.existingGags.map((g) => g.scene), ["{NAME} pending change B."]);
    assert.equal(got.draft?.scene, "{NAME} draft C.");
    assert.ok(!("enrichment" in got) && !("classification" in got), "the taxonomy is not sent (Issue #1018, increments 1.2c-ii and 1.2d)");
  });

  it("stores no joke read: the response carries ideas and the note only (plan 1C, increment 1.2d)", async () => {
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    const [row] = await db.select({ blob: factsTable.visualConceptCandidates }).from(factsTable).where(eq(factsTable.id, factId));
    assert.equal((row!.blob as { jokeRead?: string }).jokeRead, undefined, "the stored idea set has no read");
    const r = await response(reviewId, factId);
    assert.ok(!("jokeRead" in r));
    assert.equal(r.humorNote, null);
    assert.equal(r.current, true);
  });

  it("ideas written under the saved note stay current; a different note marks them out of date; regenerating under it makes them current", async () => {
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await db.update(factsTable).set({ humorNote: "Read one." }).where(eq(factsTable.id, factId));
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    assert.equal((await response(reviewId, factId)).current, true, "written under the saved note");

    await request(app).put(`/admin/reviews/${reviewId}/humor-note`).set("authorization", `Bearer ${adminSid}`).send({ text: "A corrected reading." });
    const n = await note(factId);
    assert.equal(n.text, "A corrected reading.");
    assert.equal(n.by, adminId);
    const stale = await response(reviewId, factId);
    assert.equal(stale.current, false);
    assert.equal(stale.staleReason, "humor_note_changed");

    let sentNote: string | null = null;
    await runVisualConceptsJob({ reviewId, factId }, { generate: async (input) => { sentNote = input.humorNote; return stubGenerate()(input); } });
    assert.equal(sentNote, "A corrected reading.");
    assert.equal((await response(reviewId, factId)).current, true);
    assert.equal((await note(factId)).text, "A corrected reading.", "a generation never writes the note");
  });

  it("ideas written with no note go out of date once a note is saved: they were not written for it", async () => {
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    await request(app).put(`/admin/reviews/${reviewId}/humor-note`).set("authorization", `Bearer ${adminSid}`).send({ text: "Written later." });
    const r = await response(reviewId, factId);
    assert.equal(r.current, false);
    assert.equal(r.staleReason, "humor_note_changed");
  });

  it("a changed gag still marks the ideas out of date whatever the note says", async () => {
    // A fact's wording never changes (migration 0141); its gags do.
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    await db.update(factsTable).set({ humorNote: "Read." }).where(eq(factsTable.id, factId));
    await db.insert(factGagsTable).values({ factId, slot: 1, pendingContent: { version: 1, coreSceneOverride: "{NAME} a gag saved after the ideas." } as never });
    const r = await response(reviewId, factId);
    assert.equal(r.current, false);
    assert.equal(r.staleReason, "input_hash_mismatch");
  });

  it("the note route refuses an empty note, a non-admin, and a resolved review", async () => {
    const { reviewId } = await seedReview(adminId, "gags");
    assert.equal((await request(app).put(`/admin/reviews/${reviewId}/humor-note`).set("authorization", `Bearer ${adminSid}`).send({ text: "  " })).status, 400);
    assert.notEqual((await request(app).put(`/admin/reviews/${reviewId}/humor-note`).set("authorization", `Bearer ${plainSid}`).send({ text: "x" })).status, 200);
    const resolved = await seedReview(adminId, "rejected");
    assert.equal((await request(app).put(`/admin/reviews/${resolved.reviewId}/humor-note`).set("authorization", `Bearer ${adminSid}`).send({ text: "x" })).status, 409);
  });

  it("an old (pre-v3) blob parses and reads as out of date", async () => {
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    const [row] = await db.select({ blob: factsTable.visualConceptCandidates }).from(factsTable).where(eq(factsTable.id, factId));
    const old = { ...(row!.blob as Record<string, unknown>), inputHash: "hash-from-the-v2-contract" };
    delete (old as Record<string, unknown>).jokeRead;
    delete (old as Record<string, unknown>).humorNoteUsed;
    await db.update(factsTable).set({ visualConceptCandidates: old }).where(eq(factsTable.id, factId));
    const r = await response(reviewId, factId);
    assert.equal(r.candidates.length, 3);
    assert.equal(r.current, false);
  });
});

describe("the gag writer has no fallback model", () => {
  it("an unusable engine fails the job at once, and the review response still loads with the reason", async () => {
    const { reviewId, factId } = await seedReview(adminId, "gags");
    await runVisualConceptsJob({ reviewId, factId }, { generate: stubGenerate() });
    // As an enqueue leaves it: pending, with the earlier ideas and a saved note.
    await db.update(factsTable).set({ humorNote: "Saved.", visualConceptStatus: "pending" }).where(eq(factsTable.id, factId));
    // The engine is set in code (decisions.md 2026-11-14); switching its catalogue definition off is what makes it unusable now.
    const gagWriter = ALL_ENGINES.find((e) => e.id === "openai-gag-writer")!;
    const prevActive = gagWriter.isActive;
    gagWriter.isActive = false;
    try {
      let called = false;
      const res = await runVisualConceptsJob({ reviewId, factId }, { generate: async (input) => { called = true; return generateVisualConcepts(input); } });
      assert.ok(called);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal((res as { retryable?: boolean }).retryable, false, "a configuration fault is terminal");
        assert.match(res.error, /openai-gag-writer|engine_inactive/);
      }
      const [row] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
      assert.equal(row!.visualConceptStatus, "failed", "the handler itself marks the fact failed (no onAbandon on a terminal failure)");
      const r = await buildVisualConceptsResponse({
        id: reviewId, visualConceptStatus: row!.visualConceptStatus, visualConceptCandidates: row!.visualConceptCandidates,
        humorNote: row!.humorNote, humorNoteApprovedBy: row!.humorNoteApprovedBy, humorNoteApprovedAt: row!.humorNoteApprovedAt,
      });
      assert.equal(r.candidates.length, 3, "the stored ideas still load");
      assert.equal(r.humorNote?.text, "Saved.");
      assert.match(r.failureReason ?? "", /openai-gag-writer|engine_inactive|inactive/);

      // Repair it: Regenerate is accepted, and a run succeeds.
      gagWriter.isActive = prevActive;
      const regen = await request(makeApp()).post(`/admin/reviews/${reviewId}/visual-concepts/regenerate`).set("authorization", `Bearer ${adminSid}`).send({});
      assert.equal(regen.status, 202, JSON.stringify(regen.body));
      // The job Regenerate queued, run from its own payload: it carries the new generation.
      const [queued] = await db.select({ payload: asyncJobsTable.payload }).from(asyncJobsTable)
        .where(and(eq(asyncJobsTable.queue, "fact_visual_concepts"), like(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${reviewId}:%`), eq(asyncJobsTable.status, "pending")));
      const again = await runVisualConceptsJob(queued!.payload as Parameters<typeof runVisualConceptsJob>[0], { generate: stubGenerate() });
      assert.equal(again.ok, true);
      const [after] = await db.select({ status: factsTable.visualConceptStatus, note: factsTable.humorNote }).from(factsTable).where(eq(factsTable.id, factId));
      assert.equal(after!.status, "ok");
      assert.equal(after!.note, "Saved.", "the approved note survives the failure and the recovery");
    } finally {
      gagWriter.isActive = prevActive;
    }
  });
});
