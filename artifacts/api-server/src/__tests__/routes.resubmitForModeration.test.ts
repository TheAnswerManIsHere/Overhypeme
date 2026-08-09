/**
 * Integration tests for POST /admin/facts/:id/resubmit-for-moderation — the
 * reactivation-gap fix (Codex round 7, PR #242 Phase 2 fact-lifecycle
 * closure). Round 4 made the admin Active toggle deactivate-only (activation
 * is moderation-only, David-confirmed), but nothing put a deactivated fact
 * BACK through moderation — send-back-to-review is a refresh primitive that
 * requires the fact to already be active. This endpoint is the opposite case:
 * it re-enters an inactive fact at prep_pending, exactly like a first-time
 * staging fact, reusing the existing factId/history (no duplicate row).
 *
 * Same harness as routes.sendBackToReview.test.ts (real authMiddleware +
 * session bearer, real test DB, no OpenAI needed — we only assert a job got
 * queued, never that it classified).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, asyncJobsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_resub_";
const TEST_FILE_START = new Date();

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

async function seedInactiveFact(opts: { parentId?: number } = {}): Promise<typeof factsTable.$inferSelect> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: `{NAME} does a deactivated thing ${randomUUID()}.`,
      submittedById: adminId,
      isActive: false,
      parentId: opts.parentId,
      enrichment: buildPlaceholderFactEnrichment(),
    })
    .returning();
  insertedFactIds.push(fact.id);
  return fact;
}

async function enrichmentJobsForFact(factId: number) {
  return db
    .select({ id: asyncJobsTable.id })
    .from(asyncJobsTable)
    .where(and(eq(asyncJobsTable.queue, "enrichment"), sql`${asyncJobsTable.payload}->>'factId' = ${String(factId)}`));
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

describe("POST /admin/facts/:id/resubmit-for-moderation", () => {
  it("re-enters the SAME fact at prep_pending: no new fact, enrichment job queued", async () => {
    const fact = await seedInactiveFact();
    const res = await request(makeApp())
      .post(`/admin/facts/${fact.id}/resubmit-for-moderation`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.factId, fact.id);
    assert.equal(res.body.workflowStage, "prep_pending");
    assert.equal(typeof res.body.reviewId, "number");

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.equal(review.stagingFactId, fact.id, "reuses the existing fact id — no duplicate created");
    assert.equal(review.workflowStage, "prep_pending");
    assert.equal(review.submittedText, fact.text);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, fact.id));
    assert.equal(row.isActive, false, "stays inactive until re-approved through the pipeline");
    assert.equal(row.enrichmentStatus, "pending");

    const jobs = await enrichmentJobsForFact(fact.id);
    assert.equal(jobs.length, 1, "exactly one fact-backed enrichment job");
  });

  it("preserves the variant's parentId on the review row", async () => {
    const root = await seedInactiveFact();
    const variant = await seedInactiveFact({ parentId: root.id });
    const res = await request(makeApp())
      .post(`/admin/facts/${variant.id}/resubmit-for-moderation`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 200);

    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.equal(review.parentFactId, root.id);

    const [row] = await db.select({ parentId: factsTable.parentId }).from(factsTable).where(eq(factsTable.id, variant.id));
    assert.equal(row.parentId, root.id, "the fact's own parentId is untouched — activateFact revalidates it later");
  });

  it("404 for a missing fact; 409 ALREADY_ACTIVE", async () => {
    const missing = await request(makeApp())
      .post("/admin/facts/999999999/resubmit-for-moderation")
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(missing.status, 404);

    const [active] = await db.insert(factsTable)
      .values({ text: `{NAME} still live ${randomUUID()}`, submittedById: adminId, isActive: true, enrichment: buildPlaceholderFactEnrichment() })
      .returning();
    insertedFactIds.push(active.id);
    const res = await request(makeApp())
      .post(`/admin/facts/${active.id}/resubmit-for-moderation`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "ALREADY_ACTIVE");
  });

  it("409 ORPHANED_PARENT when the variant's parent row no longer exists (hard-delete orphan)", async () => {
    const root = await seedInactiveFact();
    const variant = await seedInactiveFact({ parentId: root.id });
    // Simulate the orphan state a hard delete leaves: facts.parent_id has no
    // FK, so deleting the root leaves the variant's parent_id dangling.
    await db.delete(factsTable).where(eq(factsTable.id, root.id));
    insertedFactIds.splice(insertedFactIds.indexOf(root.id), 1);

    const res = await request(makeApp())
      .post(`/admin/facts/${variant.id}/resubmit-for-moderation`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "ORPHANED_PARENT");

    const reviews = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.stagingFactId, variant.id));
    assert.equal(reviews.length, 0, "no review must have been written");
  });

  it("409 REVIEW_ALREADY_IN_PROGRESS naming the in-flight review on a second click", async () => {
    const fact = await seedInactiveFact();
    const first = await request(makeApp())
      .post(`/admin/facts/${fact.id}/resubmit-for-moderation`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(first.status, 200);

    const second = await request(makeApp())
      .post(`/admin/facts/${fact.id}/resubmit-for-moderation`)
      .set("authorization", `Bearer ${adminSid}`)
      .send({});
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "REVIEW_ALREADY_IN_PROGRESS");
    assert.equal(second.body.reviewId, first.body.reviewId);
  });
});
