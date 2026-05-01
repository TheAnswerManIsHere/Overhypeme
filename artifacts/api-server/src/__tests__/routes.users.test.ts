/**
 * Integration tests for routes/users.ts.
 *
 * Covers the public-shape, validation, and DB-write surface of every
 * endpoint that doesn't require an external service (Stripe, ObjectStorage
 * for delete success, hCaptcha-prod). Talks to the real test DB; isolates
 * via per-test UUIDs and cleans up at the end.
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
  ratingsTable,
  searchHistoryTable,
  commentsTable,
  pendingReviewsTable,
  memesTable,
  emailVerificationTokensTable,
  uploadImageMetadataTable,
  userAiImagesTable,
  userGenerationCostsTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import usersRouter from "../routes/users.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_routes_um_";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(usersRouter);
  return app;
}

interface CreateUserOpts {
  isAdmin?: boolean;
  membershipTier?: "unregistered" | "registered" | "legendary";
  displayName?: string | null;
  email?: string;
}

async function createTestUser(opts: CreateUserOpts = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: opts.email ?? `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
    membershipTier: opts.membershipTier ?? "registered",
    displayName: opts.displayName ?? null,
  });
  return id;
}

async function bearerForUser(userId: string): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
  };
  return createSession(sessionData, userId);
}

async function deleteFactsBy(userId: string) {
  await db.delete(factsTable).where(eq(factsTable.submittedById, userId));
}

async function cleanupUsers() {
  // Find every test user and clear their dependent rows that don't cascade,
  // then delete the users themselves.
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(commentsTable).where(eq(commentsTable.authorId, u.id));
    await db.delete(memesTable).where(eq(memesTable.createdById, u.id));
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await deleteFactsBy(u.id);
    await db.delete(userGenerationCostsTable).where(eq(userGenerationCostsTable.userId, u.id));
    await db.delete(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.userId, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanupUsers);
after(cleanupUsers);

describe("GET /users/me", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/users/me");
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
  });

  it("returns the canonical empty-state shape for a fresh user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/users/me")
      .set("authorization", `Bearer ${sid}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, userId);
    assert.equal(res.body.email, `${userId}@test.local`);
    assert.equal(res.body.emailVerified, false);
    assert.equal(res.body.membershipTier, "registered");
    assert.equal("isPremium" in res.body, false);
    assert.equal(res.body.hasPassword, false);
    assert.equal(res.body.avatarStyle, "bottts");
    assert.equal(res.body.avatarSource, "avatar");
    assert.deepEqual(res.body.submittedFacts, []);
    assert.deepEqual(res.body.likedFacts, []);
    assert.deepEqual(res.body.pendingSubmissions, []);
    assert.deepEqual(res.body.favoriteHashtags, []);
    assert.deepEqual(res.body.searchHistory, []);
    assert.deepEqual(res.body.myComments, []);
    // Non-admin users do NOT get the notification fields.
    assert.equal("adminNotifications" in res.body, false);
  });

  it("includes admin notification flags only for admin users", async () => {
    const userId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/users/me")
      .set("authorization", `Bearer ${sid}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.adminNotifications, true);
    assert.equal(res.body.disputeNotifications, true);
  });

  it("returns membershipTier='legendary' for legendary users (no isPremium field)", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/users/me")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.body.membershipTier, "legendary");
    assert.equal("isPremium" in res.body, false);
  });

  it("dedupes searchHistory keeping the most-recent occurrence", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    // Insert with explicit createdAt so we know the order.
    await db.insert(searchHistoryTable).values([
      { userId, query: "alpha", createdAt: new Date(Date.now() - 3000) },
      { userId, query: "beta",  createdAt: new Date(Date.now() - 2000) },
      { userId, query: "alpha", createdAt: new Date(Date.now() - 1000) },
    ]);

    const res = await request(makeApp())
      .get("/users/me")
      .set("authorization", `Bearer ${sid}`);

    // 'alpha' (most recent) comes first; 'beta' second; the older 'alpha' is dropped.
    assert.deepEqual(res.body.searchHistory, ["alpha", "beta"]);
  });
});

describe("PATCH /users/me — validation", () => {

  async function authedPatch(body: Record<string, unknown>) {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    return { userId, res: await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send(body) };
  }

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).patch("/users/me").send({ displayName: "x" });
    assert.equal(res.status, 401);
  });

  it("rejects an empty displayName", async () => {
    const { res } = await authedPatch({ displayName: "   " });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Display name cannot be empty" });
  });

  it("rejects a displayName longer than 80 characters", async () => {
    const { res } = await authedPatch({ displayName: "x".repeat(81) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Display name must be 80 characters or fewer" });
  });

  it("rejects a firstName / lastName longer than 80 characters", async () => {
    let r = await authedPatch({ firstName: "f".repeat(81) });
    assert.equal(r.res.status, 400);
    assert.deepEqual(r.res.body, { error: "First name must be 80 characters or fewer" });
    r = await authedPatch({ lastName: "l".repeat(81) });
    assert.equal(r.res.status, 400);
    assert.deepEqual(r.res.body, { error: "Last name must be 80 characters or fewer" });
  });

  it("rejects an unknown avatarStyle", async () => {
    const { res } = await authedPatch({ avatarStyle: "monkey" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid avatar style" });
  });

  it("rejects an avatarSource that isn't 'avatar' or 'photo'", async () => {
    const { res } = await authedPatch({ avatarSource: "drawing" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "avatarSource must be 'avatar' or 'photo'" });
  });

  it("rejects empty pronouns", async () => {
    const { res } = await authedPatch({ pronouns: "  " });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Pronouns cannot be empty" });
  });

  it("rejects pronouns longer than 80 characters", async () => {
    const { res } = await authedPatch({ pronouns: "p".repeat(81) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Pronouns must be 80 characters or fewer" });
  });

  it("rejects an email without an @", async () => {
    const { res } = await authedPatch({ email: "not-an-email" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "A valid email address is required" });
  });

  it("rejects a profileImageUrl when the user is not legendary", async () => {
    const { res } = await authedPatch({ profileImageUrl: "https://images.unsplash.com/photo-1" });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "Custom photo upload is a Legendary feature" });
  });

  it("rejects profileImageUrl on unknown hosts", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({ profileImageUrl: "https://evil.example.com/x.png" });
    assert.equal(res.status, 400);
  });

  it("rejects profileImageUrl with tracking-heavy query params", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({ profileImageUrl: "https://images.unsplash.com/photo-1?utm_source=a&utm_medium=b&utm_campaign=c" });
    assert.equal(res.status, 400);
  });

  it("rejects a profileImageUrl that isn't on a supported scheme", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({ profileImageUrl: "ftp://example.com/x.png" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid profile image URL" });
  });
});

describe("PATCH /users/me — success", () => {

  it("trims and persists string fields", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    const res = await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({
        displayName: "  Pat  ",
        firstName: "  Pat  ",
        lastName: "  Doe  ",
        pronouns: "  they/them  ",
        avatarStyle: "pixel-art",
        avatarSource: "avatar",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row.displayName, "Pat");
    assert.equal(row.firstName, "Pat");
    assert.equal(row.lastName, "Doe");
    assert.equal(row.pronouns, "they/them");
    assert.equal(row.avatarStyle, "pixel-art");
  });

  it("treats whitespace-only firstName/lastName as null", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({ firstName: "   ", lastName: "   " });
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row.firstName, null);
    assert.equal(row.lastName, null);
  });

  it("accepts and normalizes trusted remote profile image URLs", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({ profileImageUrl: "  https://images.unsplash.com/photo-1?w=128&h=128  " });
    assert.equal(res.status, 200);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row.profileImageUrl, "https://images.unsplash.com/photo-1?w=128&h=128");
  });

  it("hides legacy unsafe profileImageUrl values in /users/me", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    await db.update(usersTable).set({ profileImageUrl: "https://evil.example.com/tracker.png" }).where(eq(usersTable.id, userId));
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/users/me")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.profileImageUrl, null);
  });

  it("rejects an email already in use by another user", async () => {
    const otherId = await createTestUser({ email: `${USER_PREFIX}taken@test.local` });
    void otherId; // reserved
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    const res = await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({ email: `${USER_PREFIX}taken@test.local` });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "Email is already in use" });
  });

  it("changes the email by storing pendingEmail and creating a verification token", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    const newEmail = `${USER_PREFIX}new-${randomUUID()}@test.local`;
    const res = await request(makeApp())
      .patch("/users/me")
      .set("authorization", `Bearer ${sid}`)
      .send({ email: newEmail });

    assert.equal(res.status, 200);
    assert.equal(res.body.emailVerificationPending, true);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row.pendingEmail, newEmail);

    const tokens = await db
      .select()
      .from(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, userId));
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].pendingEmail, newEmail);
    assert.ok(tokens[0].expiresAt > new Date());
  });
});

describe("PATCH /users/me/notifications", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch("/users/me/notifications")
      .send({ adminNotifications: true });
    assert.equal(res.status, 401);
  });

  it("returns 403 for non-admin users", async () => {
    const userId = await createTestUser({ isAdmin: false });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .patch("/users/me/notifications")
      .set("authorization", `Bearer ${sid}`)
      .send({ adminNotifications: false });
    assert.equal(res.status, 403);
  });

  it("returns 400 when no valid fields are supplied", async () => {
    const userId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .patch("/users/me/notifications")
      .set("authorization", `Bearer ${sid}`)
      .send({ unrelated: "field" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "No valid fields to update" });
  });

  it("updates both flags for admin users", async () => {
    const userId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .patch("/users/me/notifications")
      .set("authorization", `Bearer ${sid}`)
      .send({ adminNotifications: false, disputeNotifications: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.adminNotifications, false);
    assert.equal(res.body.disputeNotifications, false);
  });
});

describe("POST /users/me/search-history", () => {

  it("silently 204s for unauthenticated callers", async () => {
    const res = await request(makeApp())
      .post("/users/me/search-history")
      .send({ query: "anything" });
    assert.equal(res.status, 204);
  });

  it("silently 204s when the body fails Zod validation", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/users/me/search-history")
      .set("authorization", `Bearer ${sid}`)
      .send({ query: "" });
    assert.equal(res.status, 204);
    const rows = await db
      .select()
      .from(searchHistoryTable)
      .where(eq(searchHistoryTable.userId, userId));
    assert.equal(rows.length, 0);
  });

  it("inserts a new search history row on first use", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/users/me/search-history")
      .set("authorization", `Bearer ${sid}`)
      .send({ query: "cats" });
    assert.equal(res.status, 204);
    const rows = await db
      .select()
      .from(searchHistoryTable)
      .where(eq(searchHistoryTable.userId, userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].query, "cats");
  });

  it("dedupes against the immediately-previous query", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    await request(makeApp()).post("/users/me/search-history")
      .set("authorization", `Bearer ${sid}`).send({ query: "cats" });
    await request(makeApp()).post("/users/me/search-history")
      .set("authorization", `Bearer ${sid}`).send({ query: "cats" });
    const rows = await db
      .select()
      .from(searchHistoryTable)
      .where(eq(searchHistoryTable.userId, userId));
    assert.equal(rows.length, 1, "second hit with same query should be deduped");
  });

  it("inserts again when the query differs from the last", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    await request(makeApp()).post("/users/me/search-history")
      .set("authorization", `Bearer ${sid}`).send({ query: "cats" });
    await request(makeApp()).post("/users/me/search-history")
      .set("authorization", `Bearer ${sid}`).send({ query: "dogs" });
    const rows = await db
      .select()
      .from(searchHistoryTable)
      .where(eq(searchHistoryTable.userId, userId));
    assert.equal(rows.length, 2);
  });
});

describe("GET /users/me/uploads", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/users/me/uploads");
    assert.equal(res.status, 401);
  });

  it("returns empty arrays + the configured limits for a fresh user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/users/me/uploads")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.uploads, []);
    assert.equal(res.body.uploadCount, 0);
    assert.equal(typeof res.body.maxUploads, "number");
    assert.equal(typeof res.body.displayLimit, "number");
  });

  it("returns the uploaded rows for the user, ordered newest-first", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    await db.insert(uploadImageMetadataTable).values([
      { objectPath: `t/${randomUUID()}/old.png`, width: 100, height: 100, fileSizeBytes: 1, userId, createdAt: new Date(Date.now() - 5000) },
      { objectPath: `t/${randomUUID()}/new.png`, width: 200, height: 200, fileSizeBytes: 2, userId, createdAt: new Date() },
    ]);

    const res = await request(makeApp())
      .get("/users/me/uploads")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.uploads.length, 2);
    assert.match(res.body.uploads[0].objectPath, /new\.png$/);
    assert.equal(res.body.uploadCount, 2);
  });
});

describe("GET /users/me/memes", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/users/me/memes");
    assert.equal(res.status, 401);
  });

  it("returns the user's non-deleted memes newest-first", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    // Need a fact to attach the memes to (factId is non-null in schema).
    const [fact] = await db.insert(factsTable).values({
      text: "test fact",
      submittedById: userId,
    }).returning();

    const slug = () => randomUUID().replace(/-/g, "").slice(0, 12);
    await db.insert(memesTable).values([
      { factId: fact.id, templateId: "tpl", imageUrl: "https://e/a.jpg",
        permalinkSlug: slug(), createdById: userId, createdAt: new Date(Date.now() - 5000) },
      { factId: fact.id, templateId: "tpl", imageUrl: "https://e/b.jpg",
        permalinkSlug: slug(), createdById: userId, createdAt: new Date() },
      // soft-deleted: should NOT appear
      { factId: fact.id, templateId: "tpl", imageUrl: "https://e/c.jpg",
        permalinkSlug: slug(), createdById: userId, deletedAt: new Date() },
    ]);

    const res = await request(makeApp())
      .get("/users/me/memes")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.memes.length, 2);
    assert.match(res.body.memes[0].imageUrl, /b\.jpg$/);
  });
});

describe("GET /users/me/ai-images", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/users/me/ai-images");
    assert.equal(res.status, 401);
  });

  it("returns 400 for a non-numeric factId", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/users/me/ai-images")
      .set("authorization", `Bearer ${sid}`)
      .query({ factId: "abc" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid factId" });
  });

  it("returns the user's AI images filtered by imageType (default 'reference')", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    const [fact] = await db.insert(factsTable).values({
      text: "test fact",
      submittedById: userId,
    }).returning();

    await db.insert(userAiImagesTable).values([
      { userId, factId: fact.id, gender: "male",   storagePath: "p/a.png", imageType: "reference" },
      { userId, factId: fact.id, gender: "female", storagePath: "p/b.png", imageType: "generic" },
    ]);

    const res = await request(makeApp())
      .get("/users/me/ai-images")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.images.length, 1);
    assert.equal(res.body.images[0].imageType, "reference");
  });
});

describe("DELETE /users/me/uploads", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).delete("/users/me/uploads");
    assert.equal(res.status, 401);
  });

  it("returns 400 when path query parameter is missing", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .delete("/users/me/uploads")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "path query parameter is required" });
  });

  it("returns 404 when the path doesn't belong to the user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .delete("/users/me/uploads")
      .set("authorization", `Bearer ${sid}`)
      .query({ path: "does/not/exist.png" });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Upload not found or does not belong to you" });
  });
});

describe("POST /users/me/complete-onboarding", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/users/me/complete-onboarding")
      .send({ captchaToken: "x" });
    assert.equal(res.status, 401);
  });

  it("returns 400 when captchaToken is missing", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/users/me/complete-onboarding")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "captchaToken is required" });
  });

  it("flips captchaVerified and returns success on the dev-bypass path", async () => {
    // captcha.ts bypasses verification when HCAPTCHA_SECRET is unset and
    // NODE_ENV !== 'production'. The test env satisfies both.
    delete process.env.HCAPTCHA_SECRET;

    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/users/me/complete-onboarding")
      .set("authorization", `Bearer ${sid}`)
      .send({ captchaToken: "irrelevant-in-dev" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row.captchaVerified, true);
  });
});

describe("GET /users/me/spend", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/users/me/spend");
    assert.equal(res.status, 401);
  });

  it("returns the canonical empty-state shape when the user has no costs", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/users/me/spend")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.history, []);
    assert.equal(res.body.lifetimeTotal, 0);
    assert.equal(res.body.current.totalUsd, 0);
    assert.equal(res.body.current.isCurrent, true);
  });

  it("aggregates costs by year/month and computes lifetimeTotal", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    const now = new Date();
    const baseCost = {
      jobType: "test",
      endpointId: "test/endpoint",
      unitPriceAtCreation: "0.001",
      billingUnits: "1",
      pricingFetchedAt: now,
    };
    await db.insert(userGenerationCostsTable).values([
      { userId, ...baseCost, computedCostUsd: "1.50", createdAt: now },
      { userId, ...baseCost, computedCostUsd: "0.50", createdAt: now },
    ]);

    const res = await request(makeApp())
      .get("/users/me/spend")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.lifetimeTotal, 2);
    assert.equal(res.body.current.totalUsd, 2);
    assert.equal(res.body.current.isCurrent, true);
  });
});
