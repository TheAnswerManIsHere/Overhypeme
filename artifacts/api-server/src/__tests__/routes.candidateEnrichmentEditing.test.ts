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
 * A refresh cycle whose candidate is GENUINELY concept-less, in the stage that
 * state really occurs in.
 *
 * Built entirely through the supported writers (Codex, #567 round 2):
 *   - `clearOverrides: true` makes `sendFactBackToReview` seed the candidate's
 *     `visualOverride` as null itself, instead of the test reaching in and
 *     clearing the column afterwards. Doing it by hand produced a row the normal
 *     writer cannot produce — `visualOverride` empty while `enrichment` still
 *     carried the scene — which violates the canonicality invariant this file
 *     header states, and would have failed a correct refactor that read the
 *     concept from the effective blob.
 *   - a scene-less classifier result keeps `enrichment.visualPromptStrategyOverride`
 *     empty too, so BOTH persisted representations agree.
 *
 * Stage: the candidate job leaves a cycle in `concept_review` (Step 2), which is
 * where a concept-less candidate is actually edited — a fact cannot reach
 * `production_review` without an approved non-empty concept. `canEditRefreshCandidate`
 * permits both stages, so a gate enforced only in Step 3 would leave the primary
 * Visual Concept editor unprotected; these fixtures therefore default to Step 2
 * and one test pins Step 3 explicitly.
 */
async function seedConceptLessRefreshCycle(
  fact: { id: number },
  opts: { stage?: "concept_review" | "production_review" } = {},
): Promise<{ reviewId: number; candidateVersionId: number }> {
  const { reviewId, candidateVersionId } = await sendFactBackToReview({
    factId: fact.id,
    adminId,
    clearOverrides: true,
  });
  const result = await runEnrichmentForCandidateVersion(candidateVersionId, {
    classify: async () => ({
      ...REFRESHED_AI_BASELINE,
      visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE },
    }) as FactEnrichment,
  });
  assert.equal(result.ok, true);

  const stage = opts.stage ?? "concept_review";
  if (stage !== "concept_review") {
    await db.update(pendingReviewsTable).set({ workflowStage: stage })
      .where(eq(pendingReviewsTable.id, reviewId));
  }

  // Preconditions: the gate's own inputs really are empty, and they AGREE — so a
  // 400 below can only come from the gate, and the row is one the product can
  // actually hold.
  const [seeded] = await db.select({
    visualOverride: factEnrichmentVersionsTable.visualOverride,
    enrichment: factEnrichmentVersionsTable.enrichment,
  }).from(factEnrichmentVersionsTable).where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
  assert.ok(
    !(seeded.visualOverride as { coreSceneOverride?: string } | null)?.coreSceneOverride?.trim(),
    "precondition: the candidate must have no persisted Visual Concept",
  );
  assert.ok(
    !(seeded.enrichment as FactEnrichment | null)?.visualPromptStrategyOverride?.coreSceneOverride?.trim(),
    "precondition: enrichment must agree with visualOverride — canonicality holds",
  );
  const [rev] = await db.select({ stage: pendingReviewsTable.workflowStage })
    .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
  assert.equal(rev.stage, stage, "precondition: the cycle must sit in the stage under test");
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
  // Each refused payload gets its OWN candidate, and persistence is asserted
  // immediately after its own request — never once at the end of a shared
  // sequence. (Codex, #567 round 3; David ruled to apply this.)
  //
  // The candidate deliberately carries a SAVED concept, authored through the real
  // PATCH route. That is what makes "persists nothing" falsifiable at all: the
  // PATCH gate reads the SUBMITTED concept, so the candidate's own state is free,
  // and starting concept-BEARING means a regression that writes before refusing
  // visibly destroys a real concept. Starting concept-less — as the shared-candidate
  // version did — made a refused write indistinguishable from the initial state for
  // the absent-override payload, and `fact_enrichment_versions` has no `updated_at`
  // to fall back on, so nothing else would have caught it.
  //
  // Stage stays the job-produced `concept_review`: authoring a concept does not
  // advance the cycle, so this keeps round 2's Step-2 coverage rather than
  // trading it back for Step 3.
  const REFUSED_CONCEPT_PAYLOADS: {
    label: string;
    build: (effective: FactEnrichment) => Record<string, unknown>;
  }[] = [
    {
      label: "a blank concept",
      build: (e) => ({ ...e, visualPromptStrategyOverride: { ...VSO_FIXTURE, coreSceneOverride: "" } }),
    },
    {
      // Whitespace is not a concept — the gate trims before testing.
      label: "a whitespace-only concept",
      build: (e) => ({ ...e, visualPromptStrategyOverride: { ...VSO_FIXTURE, coreSceneOverride: "   \n\t  " } }),
    },
    {
      label: "a present-but-empty override scaffold",
      build: (e) => ({ ...e, visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE } }),
    },
    {
      // A distinct branch from the scaffold above: that one is a truthy object, so
      // a guard regressed to `submittedVso && !submittedVso.coreSceneOverride?.trim()`
      // would still refuse it while accepting a schema-valid request that omits the
      // optional property outright. (Codex, #567 round 1.)
      label: "a genuinely absent override",
      build: (e) => {
        const { visualPromptStrategyOverride: _omitted, ...withoutConcept } = e;
        return withoutConcept;
      },
    },
  ];

  for (const payload of REFUSED_CONCEPT_PAYLOADS) {
    it(`PATCH refuses ${payload.label}, and that refused save persists nothing`, async () => {
      const fact = await seedActiveFact();
      const { reviewId, candidateVersionId } = await seedConceptLessRefreshCycle(fact);
      const app = makeApp();

      // Author a real concept through the real save path, so there is something
      // a refused write could destroy.
      await authorConceptForCycle(reviewId, candidateVersionId);

      const [beforeRow] = await db.select().from(factEnrichmentVersionsTable)
        .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
      const conceptBefore = (beforeRow.enrichment as FactEnrichment).visualPromptStrategyOverride ?? null;
      assert.ok(
        conceptBefore?.coreSceneOverride?.trim(),
        "precondition: the candidate must hold a real concept for this assertion to have teeth",
      );

      const resolved = await request(app)
        .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
        .set("authorization", `Bearer ${adminSid}`);
      const effective = resolved.body.effective as FactEnrichment;

      const res = await request(app)
        .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
        .set("authorization", `Bearer ${adminSid}`)
        .send({ enrichment: payload.build(effective) });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, "visual_concept_required");

      // Immediately, on this payload's own candidate — no later request can mask
      // a write, and no other payload can restore the state this one changed.
      const [afterRow] = await db.select().from(factEnrichmentVersionsTable)
        .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
      const after = afterRow.enrichment as FactEnrichment;
      assert.deepEqual(
        after.visualPromptStrategyOverride ?? null,
        conceptBefore,
        `a refused save must persist nothing — ${payload.label} must not have replaced the saved concept`,
      );
      assert.deepEqual(
        afterRow.visualOverride,
        beforeRow.visualOverride,
        "the canonical visual_override column must be untouched too",
      );
    });
  }

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

    // This candidate carries no overrides, and that is not a gap in the fixture:
    // `clearOverrides: true` is the ONLY supported way to a concept-less
    // candidate, and it clears the override seed in the same write. A
    // concept-less candidate that still holds overrides is not a state the
    // product can reach, so asserting "the reset removed nothing" here would be
    // comparing {} to {} — true whether or not the gate ran. What IS under test
    // is that the gate refuses the request at all, on both reset shapes.
    const resetAll = await request(app)
      .delete(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(resetAll.status, 400, JSON.stringify(resetAll.body));
    assert.equal(resetAll.body.error, "visual_concept_required");

    const resetOne = await request(app)
      .delete(`/admin/reviews/${reviewId}/candidate-overrides?path=/overhypeFit`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(resetOne.status, 400, JSON.stringify(resetOne.body));
    assert.equal(resetOne.body.error, "visual_concept_required");
  });

  // Everything above runs in `concept_review` (Step 2), where a concept-less
  // candidate actually lives. `canEditRefreshCandidate` also permits Step 3, so
  // this pins the other editable stage: a gate enforced in only one of them
  // would leave the other's editor unprotected. (Codex, #567 round 2.)
  it("holds in production_review too, not only in the concept_review stage", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await seedConceptLessRefreshCycle(fact, { stage: "production_review" });
    const app = makeApp();

    const resolved = await request(app)
      .get(`/admin/reviews/${reviewId}/candidate-enrichment-resolved`)
      .set("authorization", `Bearer ${adminSid}`);
    const effective = resolved.body.effective as FactEnrichment;

    const patch = await request(app)
      .patch(`/admin/reviews/${reviewId}/candidate-enrichment`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ enrichment: { ...effective, visualPromptStrategyOverride: { ...VSO_FIXTURE, coreSceneOverride: "" } } });
    assert.equal(patch.status, 400, JSON.stringify(patch.body));
    assert.equal(patch.body.error, "visual_concept_required");

    const put = await request(app)
      .put(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ path: "/overhypeFit", value: "questionable" });
    assert.equal(put.status, 400, JSON.stringify(put.body));
    assert.equal(put.body.error, "visual_concept_required");

    const del = await request(app)
      .delete(`/admin/reviews/${reviewId}/candidate-overrides`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(del.status, 400, JSON.stringify(del.body));
    assert.equal(del.body.error, "visual_concept_required");
  });

  // The gate sits AFTER the write-guard and tracked-field checks so it never
  // shadows them. Without this, moving it to the top of the handler — the
  // obvious "fail fast" refactor — would still pass every assertion above while
  // silently changing which error a moderator sees.
  it("does not shadow the tracked-field check: a tracked change on a concept-less candidate reports the tracked field", async () => {
    const fact = await seedActiveFact();
    const { reviewId } = await seedConceptLessRefreshCycle(fact);
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
