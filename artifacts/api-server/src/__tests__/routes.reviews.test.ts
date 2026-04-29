/**
 * Integration tests for routes/reviews.ts.
 *
 * Covers:
 * - POST /facts/submit-review (auth + onboarding gate + Zod + grammar)
 * - GET /admin/reviews + /count (admin auth and read)
 * - GET /admin/reviews/:id (admin auth, 400 / 404 / success)
 * - POST /admin/reviews/:id/reject (admin auth, 404 / 409 / success)
 * - POST /admin/reviews/:id/approve-variant (admin auth, 404 / 409,
 *   parent-not-found, success)
 * - GET /activity-feed + /mark-read (user auth)
 *
 * The full /approve success path is left out — it kicks off the
 * Pexels + AI meme image pipelines, which need external API access.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  pendingReviewsTable,
  activityFeedTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import reviewsRouter from "../routes/reviews.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_routes_rv_";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(reviewsRouter);
  return app;
}

async function createTestUser(opts: {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
    membershipTier: opts.membershipTier ?? "registered",
    captchaVerified: true, // bypasses the onboarding gate by default
  });
  return id;
}

async function bearerForUser(userId: string, opts: {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
  captchaVerified?: boolean;
} = {}): Promise<string> {
  const sessionData: SessionData = {
    user: {
      id: userId,
      membershipTier: opts.membershipTier ?? "registered",
    } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: opts.isAdmin,
    captchaVerified: opts.captchaVerified ?? true,
  };
  return createSession(sessionData, userId);
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(activityFeedTable).where(eq(activityFeedTable.userId, u.id));
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("POST /facts/submit-review", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .send({ text: "hello world here is a fact" });
    assert.equal(res.status, 401);
  });

  it("returns 403 ONBOARDING_REQUIRED for non-admin/non-legendary/non-captcha users", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId, { captchaVerified: false });
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this fact is at least ten chars" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "ONBOARDING_REQUIRED");
  });

  it("returns 400 when text is too short", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "short" });
    assert.equal(res.status, 400);
  });

  it("returns 422 when the template has invalid grammar", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this fact uses a {NESTED}{FOO} bad token" });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /grammar validation failed/);
  });

  it("happy path: inserts a pending_reviews row and returns 201", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/submit-review")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "this is a perfectly fine fact for testing." });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.reviewId, "number");

    const [row] = await db
      .select()
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, res.body.reviewId));
    assert.ok(row);
    assert.equal(row.status, "pending");
    assert.equal(row.submittedById, userId);
  });
});

describe("GET /admin/reviews/count", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/reviews/count");
    assert.equal(res.status, 401);
  });

  it("returns 403 for non-admin users", async () => {
    const userId = await createTestUser({ isAdmin: false });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/admin/reviews/count")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 403);
  });

  it("returns the pending count for admins", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    await db.insert(pendingReviewsTable).values([
      { submittedText: "pending one", submittedById: submitterId, status: "pending" },
      { submittedText: "approved one", submittedById: submitterId, status: "approved" },
    ]);

    const res = await request(makeApp())
      .get("/admin/reviews/count")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 1);
  });
});

describe("GET /admin/reviews", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns paginated reviews for admins", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    await db.insert(pendingReviewsTable).values([
      { submittedText: `pending ${randomUUID()}`, submittedById: submitterId, status: "pending" },
    ]);

    const res = await request(makeApp())
      .get("/admin/reviews")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.reviews));
    assert.equal(typeof res.body.total, "number");
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 20);
  });
});

describe("GET /admin/reviews/:id", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 400 for a non-numeric id", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .get("/admin/reviews/abc")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
  });

  it("returns 404 when no review matches", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .get("/admin/reviews/999999")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 404);
  });

  it("returns the hydrated review on success", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "details please",
      submittedById: submitterId,
      status: "pending",
    }).returning();

    const res = await request(makeApp())
      .get(`/admin/reviews/${r.id}`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, r.id);
    assert.equal(res.body.submittedText, "details please");
    assert.equal(res.body.submitter?.id, submitterId);
  });
});

describe("POST /admin/reviews/:id/reject", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 404 when the review doesn't exist", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/999999/reject")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 404);
  });

  it("returns 409 when the review has already been decided", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "already approved",
      submittedById: submitterId,
      status: "approved",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already approved/);
  });

  it("happy path: marks the review rejected", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "to-be-rejected",
      submittedById: submitterId,
      status: "pending",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/reject`)
      .set("authorization", `Bearer ${sid}`)
      .send({ adminNote: "doesn't fit" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const [after] = await db
      .select()
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, r.id));
    assert.equal(after.status, "rejected");
    assert.equal(after.adminNote, "doesn't fit");
    assert.equal(after.reviewedById, adminId);
  });
});

describe("POST /admin/reviews/:id/approve-variant", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 400 when parentFactId is missing", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/1/approve-variant")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 400);
  });

  it("returns 404 when the review doesn't exist", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(adminId, { isAdmin: true });
    const res = await request(makeApp())
      .post("/admin/reviews/999999/approve-variant")
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 1 });
    assert.equal(res.status, 404);
  });

  it("returns 404 when the parent fact doesn't exist", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "variant attempt",
      submittedById: submitterId,
      status: "pending",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 999999 });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found or inactive/);
  });

  it("returns 409 when the review has already been decided", async () => {
    const adminId = await createTestUser({ isAdmin: true });
    const submitterId = await createTestUser();
    const sid = await bearerForUser(adminId, { isAdmin: true });

    const [r] = await db.insert(pendingReviewsTable).values({
      submittedText: "already-approved",
      submittedById: submitterId,
      status: "approved",
    }).returning();

    const res = await request(makeApp())
      .post(`/admin/reviews/${r.id}/approve-variant`)
      .set("authorization", `Bearer ${sid}`)
      .send({ parentFactId: 1 });
    assert.equal(res.status, 409);
  });
});

describe("GET /activity-feed", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/activity-feed");
    assert.equal(res.status, 401);
  });

  it("returns the canonical empty-state for a new user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/activity-feed")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.entries, []);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.unread, 0);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 20);
  });

  it("returns seeded entries newest-first with unread count", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    await db.insert(activityFeedTable).values([
      { userId, actionType: "fact_submitted", message: "old", read: true,  createdAt: new Date(Date.now() - 5000) },
      { userId, actionType: "fact_submitted", message: "new", read: false, createdAt: new Date() },
    ]);

    const res = await request(makeApp())
      .get("/activity-feed")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.unread, 1);
    assert.equal(res.body.entries[0].message, "new");
  });
});

describe("POST /activity-feed/mark-read", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post("/activity-feed/mark-read").send({});
    assert.equal(res.status, 401);
  });

  it("flips unread entries to read for the calling user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    await db.insert(activityFeedTable).values([
      { userId, actionType: "fact_submitted", message: "u1", read: false },
      { userId, actionType: "fact_submitted", message: "u2", read: false },
    ]);

    const res = await request(makeApp())
      .post("/activity-feed/mark-read")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);

    const rows = await db
      .select()
      .from(activityFeedTable)
      .where(eq(activityFeedTable.userId, userId));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.read === true));
  });
});
