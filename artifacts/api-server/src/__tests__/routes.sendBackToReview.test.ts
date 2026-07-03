/**
 * Integration tests for the PR2 admin endpoints of the stale-fact refresh
 * feature:
 *
 *   POST /admin/facts/:id/send-back-to-review  (thin wrapper over the primitive)
 *   GET  /admin/facts/:id/enrichment-versions  (metadata-only version history)
 *
 * Includes the REAL unique-violation race for REFRESH_ALREADY_IN_PROGRESS: a
 * concurrent transaction inserts a candidate row without taking the fact lock,
 * so the endpoint's pre-check misses it and the partial-unique index fires —
 * the catch path must return the same in-flight ids as the pre-check path.
 *
 * Same harness as enrichmentVersioning.refresh.test.ts (real authMiddleware +
 * session bearer, real test DB, classify stubbed — no OpenAI).
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
  asyncJobsTable,
} from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { materializeEnrichment } from "../lib/factEnrichment.js";
import { runEnrichmentForCandidateVersion } from "../lib/enrichmentJobs.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_sbr_";
const TEST_FILE_START = new Date();

const AI_BASELINE: FactEnrichment = {
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

const MANUAL_OVERRIDES = {
  "/visualComplexity": {
    value: "high",
    overriddenFrom: "medium",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    createdBy: "admin",
    reason: "test",
  },
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(adminRouter);
  return app;
}

let adminId: string;
let adminSid: string;
const insertedFactIds: number[] = [];

async function seedActiveFact(): Promise<typeof factsTable.$inferSelect> {
  const { columns } = materializeEnrichment({ aiDerived: AI_BASELINE, overrides: MANUAL_OVERRIDES });
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: "{NAME} bench-presses the Earth.",
      submittedById: adminId,
      isActive: true,
      ...columns,
      enrichmentStatus: "ok",
    } as typeof factsTable.$inferInsert)
    .returning();
  insertedFactIds.push(fact.id);
  return fact;
}

async function cleanup() {
  if (insertedFactIds.length) {
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
  await db.insert(usersTable).values({
    id: adminId,
    email: `${adminId}@test.local`,
    isAdmin: true,
    membershipTier: "legendary",
    captchaVerified: true,
  });
  const sessionData: SessionData = {
    user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
    captchaVerified: true,
  };
  adminSid = await createSession(sessionData, adminId);
});

after(async () => {
  await cleanup();
  await db.delete(asyncJobsTable).where(
    and(eq(asyncJobsTable.queue, "enrichment"), gte(asyncJobsTable.createdAt, TEST_FILE_START)),
  );
});

describe("POST /admin/facts/:id/send-back-to-review", () => {
  it("starts a refresh cycle: candidate + new review, createdBy = the admin, ids echoed", async () => {
    const fact = await seedActiveFact();
    const res = await request(makeApp())
      .post(`/admin/facts/${fact.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.reviewId, "number");
    assert.equal(typeof res.body.candidateVersionId, "number");
    assert.equal(res.body.versionNo, 1);

    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, res.body.candidateVersionId));
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.createdBy, adminId);
    assert.equal(candidate.sourceReviewId, res.body.reviewId);
    // Default: manual-edit layers seeded from the ACTIVE version.
    assert.deepEqual(candidate.enrichmentOverrides, MANUAL_OVERRIDES);

    const [review] = await db.select().from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.equal(review.workflowStage, "prep_pending");
    assert.equal(review.candidateVersionId, res.body.candidateVersionId);
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(f.isActive, true, "the fact never leaves the site");
    assert.equal(f.enrichmentStatus, "pending");
  });

  it("clearOverrides: true wipes the CANDIDATE's seed only", async () => {
    const fact = await seedActiveFact();
    const res = await request(makeApp())
      .post(`/admin/facts/${fact.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({ clearOverrides: true });
    assert.equal(res.status, 200);
    const [candidate] = await db.select().from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, res.body.candidateVersionId));
    assert.deepEqual(candidate.enrichmentOverrides, {});
    assert.equal(candidate.visualOverride, null);
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.deepEqual(f.enrichmentOverrides, MANUAL_OVERRIDES, "fact-level overrides untouched");
  });

  it("404 for a missing fact; 409 NOT_ACTIVE; 409 HAS_ACTIVE_VARIANTS", async () => {
    const missing = await request(makeApp())
      .post("/admin/facts/999999999/send-back-to-review")
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(missing.status, 404);

    const [inactive] = await db.insert(factsTable)
      .values({ text: "{NAME} inactive", submittedById: adminId, isActive: false })
      .returning();
    insertedFactIds.push(inactive.id);
    const notActive = await request(makeApp())
      .post(`/admin/facts/${inactive.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(notActive.status, 409);
    assert.equal(notActive.body.code, "NOT_ACTIVE");

    const root = await seedActiveFact();
    const [variant] = await db.insert(factsTable)
      .values({ text: "{NAME} variant", submittedById: adminId, isActive: true, parentId: root.id })
      .returning();
    insertedFactIds.push(variant.id);
    const withVariants = await request(makeApp())
      .post(`/admin/facts/${root.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(withVariants.status, 409);
    assert.equal(withVariants.body.code, "HAS_ACTIVE_VARIANTS");
  });

  it("pre-check duplicate → 409 REFRESH_ALREADY_IN_PROGRESS naming the in-flight cycle", async () => {
    const fact = await seedActiveFact();
    const first = await request(makeApp())
      .post(`/admin/facts/${fact.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(first.status, 200);

    const second = await request(makeApp())
      .post(`/admin/facts/${fact.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "REFRESH_ALREADY_IN_PROGRESS");
    assert.equal(second.body.reviewId, first.body.reviewId);
    assert.equal(second.body.candidateVersionId, first.body.candidateVersionId);
  });

  it("RACE (unique-violation path) → 409 with the winner's ids", async () => {
    const fact = await seedActiveFact();
    // A concurrent transaction inserts the winning candidate WITHOUT taking the
    // fact lock, holding its transaction open long enough that the endpoint's
    // pre-check can't see it and its insert must wait on the partial-unique
    // index — the true backstop path.
    const [winnerReview] = await db.insert(pendingReviewsTable).values({
      submittedText: fact.text,
      status: "pending",
      workflowStage: "prep_pending",
      stagingFactId: fact.id,
    }).returning({ id: pendingReviewsTable.id });

    let winnerCandidateId = 0;
    const blocker = db.transaction(async (tx) => {
      const [winner] = await tx.insert(factEnrichmentVersionsTable).values({
        factId: fact.id,
        versionNo: 1,
        status: "candidate",
        enrichmentOverrides: {},
        source: "refresh_candidate",
        sourceReviewId: winnerReview.id,
        factTextHash: "race-winner",
      }).returning({ id: factEnrichmentVersionsTable.id });
      winnerCandidateId = winner.id;
      // Keep the transaction open while the endpoint runs into the index.
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    // Give the blocker time to insert before the endpoint call starts.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const raceRes = await request(makeApp())
      .post(`/admin/facts/${fact.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    await blocker;

    assert.equal(raceRes.status, 409, JSON.stringify(raceRes.body));
    assert.equal(raceRes.body.code, "REFRESH_ALREADY_IN_PROGRESS");
    assert.equal(raceRes.body.candidateVersionId, winnerCandidateId, "race path names the winner");
    assert.equal(raceRes.body.reviewId, winnerReview.id);
  });
});

describe("GET /admin/facts/:id/enrichment-versions", () => {
  it("returns metadata-only history: current from facts.*, inFlight cycle, versions desc", async () => {
    const fact = await seedActiveFact();
    const sendBack = await request(makeApp())
      .post(`/admin/facts/${fact.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(sendBack.status, 200);
    const { reviewId, candidateVersionId } = sendBack.body;

    let res = await request(makeApp())
      .get(`/admin/facts/${fact.id}/enrichment-versions`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.current, { hasEnrichment: true, enrichmentStatus: "pending", hasOverrides: true });
    assert.deepEqual(res.body.inFlight, { candidateVersionId, reviewId });
    assert.equal(res.body.versions.length, 1);
    const v = res.body.versions[0];
    assert.equal(v.status, "candidate");
    assert.equal(v.enrichmentReady, false, "job hasn't classified yet");
    assert.ok(!("enrichment" in v) && !("enrichmentAiDerived" in v) && !("enrichmentOverrides" in v),
      "metadata only — no jsonb blobs");

    // Candidate job completes → enrichmentReady flips.
    const jobResult = await runEnrichmentForCandidateVersion(candidateVersionId, {
      classify: async () => AI_BASELINE,
    });
    assert.equal(jobResult.ok, true);
    res = await request(makeApp())
      .get(`/admin/facts/${fact.id}/enrichment-versions`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.body.versions[0].enrichmentReady, true);
    assert.equal(res.body.current.enrichmentStatus, "ok");

    // Reject (same terminal writes the reject route performs) → inFlight null,
    // candidate retained as rejected history, newest-first ordering holds.
    await db.transaction(async (tx) => {
      await tx.update(pendingReviewsTable)
        .set({ status: "rejected", workflowStage: "production_rejected" })
        .where(eq(pendingReviewsTable.id, reviewId));
      await tx.update(factEnrichmentVersionsTable)
        .set({ status: "rejected", rejectedAt: new Date() })
        .where(eq(factEnrichmentVersionsTable.id, candidateVersionId));
    });
    const second = await request(makeApp())
      .post(`/admin/facts/${fact.id}/send-back-to-review`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(second.status, 200);

    res = await request(makeApp())
      .get(`/admin/facts/${fact.id}/enrichment-versions`)
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.body.versions.length, 2);
    assert.equal(res.body.versions[0].id, second.body.candidateVersionId, "newest first");
    assert.equal(res.body.versions[1].status, "rejected");
    assert.deepEqual(res.body.inFlight, {
      candidateVersionId: second.body.candidateVersionId,
      reviewId: second.body.reviewId,
    });
  });

  it("404 for a missing fact", async () => {
    const res = await request(makeApp())
      .get("/admin/facts/999999999/enrichment-versions")
      .set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 404);
  });
});
