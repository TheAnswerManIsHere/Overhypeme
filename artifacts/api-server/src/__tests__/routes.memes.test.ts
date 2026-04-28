/**
 * Integration tests for routes/memes.ts.
 *
 * Covers the public read surface (GET /memes/templates,
 * GET /memes/:slug, GET /facts/:factId/memes), the user preference
 * round-trip (GET/PUT /facts/:factId/ai-meme-preference), and the
 * soft-delete endpoint (DELETE /memes/:slug).
 *
 * The image-rendering, Zazzle-export, and AI-generation paths require
 * sharp/canvas + external APIs and are out of scope for this batch.
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
  memesTable,
  userFactPreferencesTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import memesRouter from "../routes/memes.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_routes_m_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(memesRouter);
  return app;
}

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local` });
  return id;
}

async function bearerForUser(userId: string): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
  };
  return createSession(sessionData, userId);
}

async function insertFact(text: string, opts: { submittedById?: string } = {}): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text, submittedById: opts.submittedById, isActive: true, canonicalText: text })
    .returning();
  return row.id;
}

function slug() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

async function insertMeme(opts: {
  factId: number;
  createdById?: string;
  imageUrl?: string;
  isPublic?: boolean;
  deletedAt?: Date | null;
}): Promise<{ id: number; permalinkSlug: string }> {
  const [row] = await db
    .insert(memesTable)
    .values({
      factId: opts.factId,
      templateId: "tpl",
      imageUrl: opts.imageUrl ?? "https://e/x.jpg",
      permalinkSlug: slug(),
      createdById: opts.createdById,
      isPublic: opts.isPublic ?? true,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning();
  return { id: row.id, permalinkSlug: row.permalinkSlug };
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    // user_fact_preferences cascades on user delete; memes don't (created_by_id has no cascade).
    await db.delete(memesTable).where(eq(memesTable.createdById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("GET /memes/templates", () => {
  it("returns the static list of meme templates", async () => {
    const res = await request(makeApp()).get("/memes/templates");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.templates));
    assert.ok(res.body.templates.length > 0);
    const t = res.body.templates[0];
    assert.equal(typeof t.id, "string");
    assert.equal(typeof t.name, "string");
    assert.match(t.previewImageUrl, /^\/api\/memes\/.*\/preview$/);
  });
});

describe("GET /memes/:slug", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 404 when the slug doesn't exist", async () => {
    const res = await request(makeApp()).get("/memes/no-such-slug");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Meme not found" });
  });

  it("returns 410 (Gone) for a soft-deleted meme", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("a fact", { submittedById: userId });
    const meme = await insertMeme({ factId, createdById: userId, deletedAt: new Date() });

    const res = await request(makeApp()).get(`/memes/${meme.permalinkSlug}`);
    assert.equal(res.status, 410);
    assert.equal(res.body.deleted, true);
  });

  it("returns the meme on success", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("a fact", { submittedById: userId });
    const meme = await insertMeme({ factId, createdById: userId });

    const res = await request(makeApp()).get(`/memes/${meme.permalinkSlug}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, meme.id);
    assert.equal(res.body.permalinkSlug, meme.permalinkSlug);
    assert.equal(res.body.factId, factId);
  });
});

describe("GET /facts/:factId/memes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 400 for a non-numeric factId", async () => {
    const res = await request(makeApp()).get("/facts/not-a-number/memes");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid factId" });
  });

  it("returns 401 when the auth-gated visibility is requested without a session", async () => {
    const res = await request(makeApp())
      .get("/facts/1/memes")
      .query({ visibility: "mine" });
    assert.equal(res.status, 401);
  });

  it("falls back to community visibility for unknown values", async () => {
    const res = await request(makeApp())
      .get("/facts/1/memes")
      .query({ visibility: "garbage" });
    // 200 — falls back to "community" silently.
    assert.equal(res.status, 200);
  });

  it("returns the user's own memes under visibility=mine", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("seed", { submittedById: userId });
    await insertMeme({ factId, createdById: userId, isPublic: false });

    const res = await request(makeApp())
      .get(`/facts/${factId}/memes`)
      .set("authorization", `Bearer ${sid}`)
      .query({ visibility: "mine" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.memes));
    assert.ok(res.body.memes.length >= 1);
  });
});

describe("GET /facts/:factId/ai-meme-preference", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns aiMemeImageIndex=0 for unauthenticated callers (no error)", async () => {
    const res = await request(makeApp()).get("/facts/1/ai-meme-preference");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { aiMemeImageIndex: 0 });
  });

  it("returns 400 for a non-numeric factId when authenticated", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/facts/abc/ai-meme-preference")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
  });

  it("returns the user's saved preference when one exists", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("for-preference", { submittedById: userId });
    await db
      .insert(userFactPreferencesTable)
      .values({ userId, factId, aiMemeImageIndex: 2 });

    const res = await request(makeApp())
      .get(`/facts/${factId}/ai-meme-preference`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.body.aiMemeImageIndex, 2);
  });

  it("returns 0 (default) when no preference row exists for the user", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("no-pref-yet", { submittedById: userId });
    const res = await request(makeApp())
      .get(`/facts/${factId}/ai-meme-preference`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.body.aiMemeImageIndex, 0);
  });
});

describe("PUT /facts/:factId/ai-meme-preference", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .put("/facts/1/ai-meme-preference")
      .send({ aiMemeImageIndex: 1 });
    assert.equal(res.status, 401);
  });

  it("returns 400 for non-numeric factId", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .put("/facts/abc/ai-meme-preference")
      .set("authorization", `Bearer ${sid}`)
      .send({ aiMemeImageIndex: 1 });
    assert.equal(res.status, 400);
  });

  it("returns 400 for an out-of-range index", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("oor", { submittedById: userId });
    const res = await request(makeApp())
      .put(`/facts/${factId}/ai-meme-preference`)
      .set("authorization", `Bearer ${sid}`)
      .send({ aiMemeImageIndex: 5 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must be 0, 1, or 2/);
  });

  it("upserts the preference for the user/fact pair", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("upsertable", { submittedById: userId });

    let res = await request(makeApp())
      .put(`/facts/${factId}/ai-meme-preference`)
      .set("authorization", `Bearer ${sid}`)
      .send({ aiMemeImageIndex: 1 });
    assert.equal(res.status, 200);

    res = await request(makeApp())
      .put(`/facts/${factId}/ai-meme-preference`)
      .set("authorization", `Bearer ${sid}`)
      .send({ aiMemeImageIndex: 2 });
    assert.equal(res.status, 200);

    const [row] = await db
      .select()
      .from(userFactPreferencesTable)
      .where(eq(userFactPreferencesTable.userId, userId));
    assert.equal(row.aiMemeImageIndex, 2);
  });
});

describe("DELETE /memes/:slug", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).delete("/memes/some-slug");
    assert.equal(res.status, 401);
  });

  it("returns 404 when the slug doesn't exist", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .delete("/memes/no-such-slug")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 404);
  });

  it("returns 403 when trying to delete someone else's meme", async () => {
    const ownerId = await createTestUser();
    const otherId = await createTestUser();
    const sid = await bearerForUser(otherId);
    const factId = await insertFact("yours", { submittedById: ownerId });
    const meme = await insertMeme({ factId, createdById: ownerId });

    const res = await request(makeApp())
      .delete(`/memes/${meme.permalinkSlug}`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 403);
  });

  it("returns 410 when the meme is already soft-deleted", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("already-gone", { submittedById: userId });
    const meme = await insertMeme({ factId, createdById: userId, deletedAt: new Date() });

    const res = await request(makeApp())
      .delete(`/memes/${meme.permalinkSlug}`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 410);
  });

  it("happy path: soft-deletes the meme by setting deletedAt", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("to-soft-delete", { submittedById: userId });
    const meme = await insertMeme({ factId, createdById: userId });

    const res = await request(makeApp())
      .delete(`/memes/${meme.permalinkSlug}`)
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const [row] = await db.select().from(memesTable).where(eq(memesTable.id, meme.id));
    assert.ok(row.deletedAt);
  });
});
