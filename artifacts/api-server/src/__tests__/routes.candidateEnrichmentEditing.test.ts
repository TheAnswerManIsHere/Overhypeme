/**
 * Integration tests for the refresh-candidate enrichment editing endpoints:
 *
 *   GET    /admin/reviews/:id/candidate-enrichment-resolved
 *   PUT    /admin/reviews/:id/candidate-overrides
 *   DELETE /admin/reviews/:id/candidate-overrides[?path=…]
 *   PATCH  /admin/reviews/:id/candidate-enrichment
 *
 * The load-bearing invariants: candidate writes NEVER touch facts.* (the live
 * enrichment layers, projections, and lastProcessedSignature stay
 * byte-identical), write ZERO override-history rows, keep
 * candidate.visual_override canonical with enrichment.visualPromptStrategyOverride,
 * pin suggestedHashtags server-side on PATCH, and 409 cleanly once the cycle
 * resolves. A promoted candidate carries its edits into facts.*.
 *
 * Same harness as enrichmentVersioning.refresh.test.ts (real authMiddleware +
 * bearer, real test DB, classify stubbed — no OpenAI).
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
  factEnrichmentVersionsTable,
  enrichmentOverrideHistoryTable,
  asyncJobsTable,
} from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, type FactEnrichment } from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import { materializeEnrichment } from "../lib/factEnrichment.js";
import { sendFactBackToReview } from "../lib/sendBackToReview.js";
import { runEnrichmentForCandidateVersion } from "../lib/enrichmentJobs.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_cee_";
const TEST_FILE_START = new Date();

const ACTIVE_AI_BASELINE: FactEnrichment = {
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
  visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "A hero stands tall." },
};

// The refreshed baseline the candidate job produces — distinct tags + a
// cultural reference so candidate-vs-active reads are distinguishable.
const REFRESHED_AI_BASELINE: FactEnrichment = {
  ...ACTIVE_AI_BASELINE,
  taxonomyConfidence: 0.5,
  suggestedHashtags: ["refreshedone", "refreshedtwo", "refreshedthree"],
  culturalReferences: [
    {
      sourcePhrase: "Shark Week",
      referenceType: "cultural_reference",
      canonicalReference: "Discovery Channel's Shark Week",
      explanation: "Annual week of shark programming.",
      visualImplication: "Sharks, ocean, documentary framing.",
      confidence: 0.95,
      requiresAdminReview: false,
    },
  ],
} as FactEnrichment;

const MANUAL_OVERRIDES = {
  "/visualComplexity": {
    value: "high",
    overriddenFrom: "medium",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    createdBy: "admin",
    reason: "test",
  },
};

const VSO_FIXTURE = {
  version: 1,
  coreSceneOverride: "{NAME} lifts the planet overhead in a packed stadium.",
  requiredVisualDetails: ["{NAME} wearing a glowing crown"],
  forbiddenVisualDetails: [],
  roleBindings: [],
  compositionGuidance: [],
  styleAgnosticPromptAdditions: [],
  negativePromptAdditions: [],
};

const WAIVE_ALL_REQUIRED = {
  waiveVisualRenderIssues: true,
  waivedScenarioKeys: ["generic_t2i", "i2i_male_default", "i2i_female_default"],
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  return app;
}

let adminId: string;
let adminEmail: string;
let adminSid: string;
let plainSid: string;
const insertedFactIds: number[] = [];

async function seedActiveFact(): Promise<typeof factsTable.$inferSelect> {
  const { columns } = materializeEnrichment({
    aiDerived: ACTIVE_AI_BASELINE,
    overrides: MANUAL_OVERRIDES,
    visualPromptStrategyOverride: ACTIVE_AI_BASELINE.visualPromptStrategyOverride,
  });
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: "{NAME} bench-presses the Earth.",
      submittedById: adminId,
      isActive: true,
      ...columns,
      enrichmentStatus: "ok",
      lastProcessedSignature: { engineRevision: 3 },
    } as typeof factsTable.$inferInsert)
    .returning();
  insertedFactIds.push(fact.id);
  return fact;
}

/**
 * Send back + run the candidate job. Enrichment now lands the cycle at Step 2
 * (`concept_review`); advance it to Step 3 (`production_review`) — simulating gag
 * approval — so promote/render (Step-3) assertions run unchanged. (Candidate
 * editing is allowed in both steps; promotion stays Step-3-only.)
 */
async function seedReadyRefreshCycle(fact: { id: number }): Promise<{ reviewId: number; candidateVersionId: number }> {
  const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });
  const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
    classify: async () => REFRESHED_AI_BASELINE,
  });
  assert.equal(result.ok, true);
  await db.update(pendingReviewsTable).set({ workflowStage: "production_review" })
    .where(eq(pendingReviewsTable.id, reviewId));
  return { reviewId, candidateVersionId };
}

/** Author a moderator Visual Concept on a refresh candidate via the real save path
 *  so it can be promoted (production release requires a non-empty scene — presence-based).
 *  Sends the candidate's CURRENT enrichment (so tracked fields match) with only the VSO
 *  added. Kept OUT of seedReadyRefreshCycle so shape-comparison tests see a scene-less
 *  candidate. */
async function authorConceptForCycle(reviewId: number, candidateVersionId: number): Promise<void> {
  const [ver] = await db.select({ enrichment: factEnrichmentVersionsTable.enrichment })
    .from(factEnrichmentVersionsTable).where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
  const res = await request(makeApp())
    .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
    .set("authorization", `Bearer ${adminSid}`)
    .send({ enrichment: {
      ...(ver.enrichment as FactEnrichment),
      visualPromptStrategyOverride: {
        version: 1, coreSceneOverride: "{NAME} lifts the planet overhead in a packed stadium.",
        requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
        bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
      },
    } });
  assert.equal(res.status, 200, `authorConceptForCycle: ${JSON.stringify(res.body)}`);
}

/**
 * A refresh cycle whose candidate has NO persisted Visual Concept.
 *
 * The PUT and DELETE gates read `candidate.visual_override` (via
 * `ctx.layers.visualPromptStrategyOverride`), NOT the AI baseline — and the
 * candidate job carries that column forward from the source version row
 * (`visualOverride: visualPromptStrategyOverride ?? null`, enrichmentJobs.ts).
 * The shared ACTIVE_AI_BASELINE fixture seeds a scene there, which satisfies the
 * gate and would make both tests below vacuous — so this clears the column to
 * reproduce the `?? null` shape the job itself can write.
 *
 * The AI baseline is left scene-less too, so the candidate is concept-less in
 * both layers rather than only one.
 */
async function seedConceptLessRefreshCycle(fact: { id: number }): Promise<{ reviewId: number; candidateVersionId: number }> {
  const { reviewId, candidateVersionId } = await sendFactBackToReview({ factId: fact.id, adminId });
  const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
    classify: async () => ({
      ...REFRESHED_AI_BASELINE,
      visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE },
    }) as FactEnrichment,
  });
  assert.equal(result.ok, true);
  await db.update(factEnrichmentVersionsTable).set({ visualOverride: null })
    .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
  await db.update(pendingReviewsTable).set({ workflowStage: "production_review" })
    .where(eq(pendingReviewsTable.id, reviewId));

  // Precondition: the gate's own input really is empty, so a 400 below can only
  // come from the gate and not from some unrelated refusal.
  const [seeded] = await db.select({ visualOverride: factEnrichmentVersionsTable.visualOverride })
    .from(factEnrichmentVersionsTable).where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
  assert.equal(seeded.visualOverride, null, "precondition: the candidate must have no persisted Visual Concept");
  return { reviewId, candidateVersionId };
}

/** The live fact's refresh-protected fields, for byte-identical comparisons. */
async function factSnapshot(factId: number) {
  const [f] = await db.select({
    enrichment: factsTable.enrichment,
    enrichmentAiDerived: factsTable.enrichmentAiDerived,
    enrichmentOverrides: factsTable.enrichmentOverrides,
    primaryArchetype: factsTable.primaryArchetype,
    subtype: factsTable.subtype,
    overhypeFit: factsTable.overhypeFit,
    adultSuitability: factsTable.adultSuitability,
    lastProcessedSignature: factsTable.lastProcessedSignature,
  }).from(factsTable).where(eq(factsTable.id, factId));
  return f;
}

async function historyCount(factId: number): Promise<number> {
  const rows = await db.select({ id: enrichmentOverrideHistoryTable.id })
    .from(enrichmentOverrideHistoryTable)
    .where(eq(enrichmentOverrideHistoryTable.factId, factId));
  return rows.length;
}

async function cleanup() {
  if (insertedFactIds.length) {
    await db.delete(enrichmentOverrideHistoryTable).where(inArray(enrichmentOverrideHistoryTable.factId, insertedFactIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, insertedFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = `${USER_PREFIX}${randomUUID()}`;
  adminEmail = `${adminId}@test.local`;
  const plainId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values([
    { id: adminId, email: adminEmail, isAdmin: true, membershipTier: "legendary", captchaVerified: true },
    { id: plainId, email: `${plainId}@test.local`, isAdmin: false, membershipTier: "registered", captchaVerified: true },
  ]);
  adminSid = await createSession({
    user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token", isAdmin: true, captchaVerified: true,
  }, adminId);
  plainSid = await createSession({
    user: { id: plainId, membershipTier: "registered" } as unknown as SessionData["user"],
    access_token: "test-token", isAdmin: false, captchaVerified: true,
  }, plainId);
});

after(async () => {
  await cleanup();
  await db.delete(asyncJobsTable).where(and(
    inArray(asyncJobsTable.queue, ["enrichment", "review_render_scenarios_prepare"]),
    gte(asyncJobsTable.createdAt, TEST_FILE_START),
  ));
});

describe("GET /admin/reviews/:id/candidate-enrichment-resolved", () => {
  it("returns the CANDIDATE's layers in the fact-resolved shape (+ identifiers), never the live fact's", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);

    const res = await request(makeApp())
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.factId, fact.id);
    assert.equal(res.body.candidateVersionId, candidateVersionId);
    assert.equal(res.body.enrichmentStatus, "ok");
    // Candidate, not active: the refreshed baseline carries the Shark Week ref…
    assert.equal((res.body.aiDerived as FactEnrichment).culturalReferences?.[0]?.sourcePhrase, "Shark Week");
    // …with the seeded manual override applied on top in the effective.
    assert.equal((res.body.effective as FactEnrichment).visualComplexity, "high");
    assert.deepEqual(res.body.overrides, MANUAL_OVERRIDES);
    assert.equal(res.body.overrideSummary.hasOverrides, true);
  });

  it("guards: 404 unknown review; 409 NOT_REFRESH_CYCLE; 409 CANDIDATE_NOT_READY while classifying", async () => {
    const missing = await request(makeApp())
      .get("/admin/reviews/999999999/candidate-enrichment-resolved")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(missing.status, 404);

    // A first-time (non-refresh) review.
    const fact = await seedActiveFact();
    const [firstTime] = await db.insert(pendingReviewsTable).values({
      submittedText: fact.text, status: "pending", workflowStage: "production_review", stagingFactId: fact.id,
    }).returning();
    const nonRefresh = await request(makeApp())
      .get(`/admin/reviews/${firstTime.id}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(nonRefresh.status, 409);
    assert.equal(nonRefresh.body.code, "NOT_REFRESH_CYCLE");

    // A refresh cycle whose job hasn't classified yet (prep_pending, blob null).
    const fact2 = await seedActiveFact();
    const { reviewId } = await sendFactBackToReview({ factId: fact2.id, adminId });
    const notReady = await request(makeApp())
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(notReady.status, 409);
    assert.equal(notReady.body.code, "CANDIDATE_NOT_READY");
  });

  it("401 unauthenticated / 403 non-admin (all candidate routes share requireAdmin)", async () => {
    const res401 = await request(makeApp()).get("/admin/reviews/1/candidate-enrichment-resolved");
    assert.equal(res401.status, 401);
    const res403 = await request(makeApp())
      .put("/admin/reviews/1/candidate-overrides")
      .set("authorization", `Bearer ${plainSid}`)
      .send({ path: "/overhypeFit", value: "questionable" });
    assert.equal(res403.status, 403);
  });
});

describe("candidate override writes", () => {
  it("PUT set/update/reset-when-equal-AI land on the VERSION row only; facts.* byte-identical; zero history rows", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    // Tracked-override writes are concept-gated; author one first (doesn't touch
    // the live fact or write override-history, so the byte-identical/zero-history
    // assertions below still hold).
    await authorConceptForCycle(reviewId, candidateVersionId);
    const before = await factSnapshot(fact.id);
    const historyBefore = await historyCount(fact.id);
    const app = makeApp();

    // SET a new override on the candidate.
    const set = await request(app)
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "questionable", reason: "sharper call" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal((set.body.effective as FactEnrichment).overhypeFit, "questionable");
    assert.equal(set.body.overrideSummary.overriddenPaths.includes("/overhypeFit"), true);

    // UPDATE the seeded override.
    const update = await request(app)
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/visualComplexity", value: "low" });
    assert.equal(update.status, 200);
    assert.equal((update.body.effective as FactEnrichment).visualComplexity, "low");

    // RESET-when-equal-AI: setting back to the candidate baseline deletes it.
    const reset = await request(app)
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/visualComplexity", value: "medium" });
    assert.equal(reset.status, 200);
    assert.equal("/visualComplexity" in reset.body.overrides, false, "override == AI is never stored");

    // Version row carries it all; invariant holds.
    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal((candidate.enrichment as FactEnrichment).overhypeFit, "questionable");
    assert.equal((candidate.enrichmentOverrides as Record<string, unknown>)["/visualComplexity"], undefined);
    assert.deepEqual(
      (candidate.enrichment as FactEnrichment).visualPromptStrategyOverride ?? null,
      candidate.visualOverride,
      "visual_override stays canonical with enrichment.visualPromptStrategyOverride",
    );

    // The live fact is byte-identical and unaudited.
    assert.deepEqual(await factSnapshot(fact.id), before, "facts.* untouched by candidate edits");
    assert.equal(await historyCount(fact.id), historyBefore, "no override-history rows for candidate edits");

    // Bad input still 400s through the shared validation.
    const bad = await request(app)
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "not_a_value" });
    assert.equal(bad.status, 400);
  });

  it("PUT /primaryArchetype auto-links a compatible /subtype on the candidate", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    await authorConceptForCycle(reviewId, candidateVersionId);
    const res = await request(makeApp())
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/primaryArchetype", value: "object_logic_impossibility" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const eff = res.body.effective as FactEnrichment;
    assert.equal(eff.primaryArchetype, "object_logic_impossibility");
    assert.equal(res.body.overrideSummary.overriddenPaths.includes("/subtype"), true, "subtype auto-linked");
  });

  it("DELETE resets one path or all, on the candidate only", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    await authorConceptForCycle(reviewId, candidateVersionId);
    const before = await factSnapshot(fact.id);
    const app = makeApp();
    await request(app).put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "questionable" });

    const one = await request(app)
      .delete(`/admin/reviews/${reviewId}/candidate-overrides?path=/overhypeFit`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(one.status, 200);
    assert.equal("/overhypeFit" in one.body.overrides, false);
    assert.equal("/visualComplexity" in one.body.overrides, true, "other overrides survive a single reset");

    const all = await request(app)
      .delete(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.overrides, {});
    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.deepEqual(candidate.enrichmentOverrides, {});
    assert.equal((candidate.enrichment as FactEnrichment).visualComplexity, "medium", "effective back to candidate baseline");
    assert.deepEqual(await factSnapshot(fact.id), before, "facts.* untouched");
  });

  it("PATCH saves the visual concept with provenance, rejects tracked-field changes, and PINS suggestedHashtags", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    const before = await factSnapshot(fact.id);
    const app = makeApp();

    const resolved = await request(app)
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    const effective = resolved.body.effective as FactEnrichment;

    // Attempt to smuggle BOTH a suggestedHashtags change and a visual concept.
    const patch = await request(app)
      .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({
        enrichment: {
          ...effective,
          suggestedHashtags: ["smuggled", "tags", "here"],
          visualPromptStrategyOverride: VSO_FIXTURE,
        },
      });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    const saved = candidate.enrichment as FactEnrichment;
    assert.deepEqual(saved.visualPromptStrategyOverride?.requiredVisualDetails, VSO_FIXTURE.requiredVisualDetails);
    assert.equal(typeof saved.visualPromptStrategyOverride?.updatedAt, "string", "server-owned provenance stamped");
    // A human-readable actor label (email, since this test admin has no display
    // name) — never the raw admin user id.
    assert.equal(saved.visualPromptStrategyOverride?.updatedBy, adminEmail);
    assert.deepEqual(
      saved.suggestedHashtags,
      REFRESHED_AI_BASELINE.suggestedHashtags,
      "suggestedHashtags pinned to the candidate's persisted baseline",
    );
    assert.deepEqual(saved.visualPromptStrategyOverride ?? null, candidate.visualOverride, "invariant holds");
    assert.deepEqual(await factSnapshot(fact.id), before, "facts.* untouched");

    // A tracked-field change through PATCH is refused.
    const tracked = await request(app)
      .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: { ...saved, overhypeFit: "questionable" } });
    assert.equal(tracked.status, 400);
    assert.ok(Array.isArray(tracked.body.trackedPaths) && tracked.body.trackedPaths.includes("/overhypeFit"));
  });

  it("write guards: 409 at prep_pending (REVIEW_NOT_EDITABLE), after reject, and after promote", async () => {
    const app = makeApp();

    // prep_pending: write intent refuses on stage before readiness.
    const factA = await seedActiveFact();
    const a = await sendFactBackToReview({ factId: factA.id, adminId });
    const early = await request(app)
      .put(`/admin/reviews/${a.reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "questionable" });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "REVIEW_NOT_EDITABLE");

    // After reject: candidate no longer 'candidate' → stale tabs fail safely.
    const factB = await seedActiveFact();
    const b = await seedReadyRefreshCycle(factB);
    const reject = await request(app)
      .post(`/admin/reviews/${b.reviewId}/reject`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ rejectionReason: "lame" });
    assert.equal(reject.status, 200);
    const afterReject = await request(app)
      .put(`/admin/reviews/${b.reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "questionable" });
    assert.equal(afterReject.status, 409);
    assert.equal(afterReject.body.code, "CANDIDATE_NOT_PENDING");

    // After promote: same protection.
    const factC = await seedActiveFact();
    const c = await seedReadyRefreshCycle(factC);
    await authorConceptForCycle(c.reviewId, c.candidateVersionId);
    const approve = await request(app)
      .post(`/admin/reviews/${c.reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    const afterPromote = await request(app)
      .patch(`/admin/reviews/${c.reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: ACTIVE_AI_BASELINE });
    assert.equal(afterPromote.status, 409);
    assert.equal(afterPromote.body.code, "CANDIDATE_NOT_PENDING");
  });

  it("END-TO-END: a candidate override survives promotion into facts.*", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    const app = makeApp();
    await authorConceptForCycle(reviewId, candidateVersionId);

    const put = await request(app)
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "questionable", reason: "moderator correction during refresh" });
    assert.equal(put.status, 200);

    const approve = await request(app)
      .post(`/admin/reviews/${reviewId}/approve-for-production`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ ...WAIVE_ALL_REQUIRED });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal(approve.body.refreshPromoted, true);

    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal((f.enrichment as FactEnrichment).overhypeFit, "questionable", "the candidate edit shipped");
    assert.equal(f.overhypeFit, "questionable", "projection column re-synced at promote");
    const ov = (f.enrichmentOverrides as Record<string, { value: unknown }>)["/overhypeFit"];
    assert.equal(ov?.value, "questionable", "the override layer carried over");
    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    assert.equal(candidate.status, "promoted");
  });
});

// ── The blocking Visual Concept gate, on every candidate SAVE path ────────────
//
// A moderator save must carry a non-empty Visual Concept. Three separate write
// paths enforce it — the PATCH gates on the SUBMITTED concept, the PUT and
// DELETE on the PERSISTED one — and until these ran, none of the three had a
// prover. The gate is load-bearing in the fixtures above (every write test calls
// authorConceptForCycle precisely because these endpoints refuse a concept-less
// candidate), which is exactly how a gate can be relied on everywhere and
// asserted nowhere.
//
// `seedReadyRefreshCycle` deliberately leaves the candidate scene-less, so a
// cycle that has NOT been through authorConceptForCycle is the blank case.
describe("candidate saves require a non-empty Visual Concept", () => {
  it("PATCH refuses a blank concept, a whitespace-only one, and an absent override — and persists nothing", async () => {
    const fact = await seedActiveFact();
    const { reviewId, candidateVersionId } = await seedReadyRefreshCycle(fact);
    const app = makeApp();

    const resolved = await request(app)
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    const effective = resolved.body.effective as FactEnrichment;

    const [beforeRow] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    const conceptBefore = (beforeRow.enrichment as FactEnrichment).visualPromptStrategyOverride ?? null;

    const blank = await request(app)
      .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: { ...effective, visualPromptStrategyOverride: { ...VSO_FIXTURE, coreSceneOverride: "" } } });
    assert.equal(blank.status, 400, JSON.stringify(blank.body));
    assert.equal(blank.body.error, "visual_concept_required");

    // Whitespace is not a concept — the gate trims before testing.
    const whitespace = await request(app)
      .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: { ...effective, visualPromptStrategyOverride: { ...VSO_FIXTURE, coreSceneOverride: "   \n\t  " } } });
    assert.equal(whitespace.status, 400, JSON.stringify(whitespace.body));
    assert.equal(whitespace.body.error, "visual_concept_required");

    // Omitting the override entirely must be refused too, not read as "unchanged".
    const absent = await request(app)
      .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: { ...effective, visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE } } });
    assert.equal(absent.status, 400, JSON.stringify(absent.body));
    assert.equal(absent.body.error, "visual_concept_required");

    // None of the three refused saves may have written any part of its payload:
    // the candidate's persisted concept must be byte-identical to the snapshot
    // taken before them. (The candidate legitimately carries the AI baseline's
    // scene — the point is that the REFUSED payloads did not replace it.)
    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    const saved = candidate.enrichment as FactEnrichment;
    assert.deepEqual(
      saved.visualPromptStrategyOverride ?? null,
      conceptBefore,
      "a refused save must persist nothing — the candidate's concept must be untouched",
    );
    assert.deepEqual(
      saved.visualPromptStrategyOverride?.requiredVisualDetails ?? [],
      [],
      `the refused payload's own fields (${JSON.stringify(VSO_FIXTURE.requiredVisualDetails)}) must not have leaked in`,
    );
  });

  it("PUT /candidate-overrides refuses a tracked-override write on a concept-less candidate, and writes no override", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await seedConceptLessRefreshCycle(fact);
    const app = makeApp();

    const res = await request(app)
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "questionable", reason: "should not land" });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "visual_concept_required");

    const resolved = await request(app)
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(
      "/overhypeFit" in (resolved.body.overrides as Record<string, unknown>),
      false,
      "the refused override must not have been written",
    );
  });

  it("DELETE /candidate-overrides refuses a reset on a concept-less candidate — a reset is still a save", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await seedConceptLessRefreshCycle(fact);
    const app = makeApp();

    // The candidate carries /visualComplexity from the seeded manual overrides;
    // a reset that slipped past the gate would remove it.
    const before = await request(app)
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(
      "/visualComplexity" in (before.body.overrides as Record<string, unknown>),
      true,
      "precondition: the candidate has an override for the reset to have something to remove",
    );

    const res = await request(app)
      .delete(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "visual_concept_required");

    const after = await request(app)
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.deepEqual(after.body.overrides, before.body.overrides, "the refused reset must have removed nothing");
  });

  // The gate sits AFTER the write-guard and tracked-field checks so it never
  // shadows them. Without this, moving it to the top of the handler — the
  // obvious "fail fast" refactor — would still pass every assertion above while
  // silently changing which error a moderator sees.
  it("does not shadow the tracked-field check: a tracked change on a concept-less candidate reports the tracked field", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await seedReadyRefreshCycle(fact);
    const app = makeApp();

    const resolved = await request(app)
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    const effective = resolved.body.effective as FactEnrichment;

    const res = await request(app)
      .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({
        enrichment: {
          ...effective,
          overhypeFit: "questionable",
          visualPromptStrategyOverride: { ...VSO_FIXTURE, coreSceneOverride: "" },
        },
      });
    assert.equal(res.status, 400);
    assert.ok(
      Array.isArray(res.body.trackedPaths) && res.body.trackedPaths.includes("/overhypeFit"),
      `tracked-field check must win over the concept gate, got: ${JSON.stringify(res.body)}`,
    );
  });
});
