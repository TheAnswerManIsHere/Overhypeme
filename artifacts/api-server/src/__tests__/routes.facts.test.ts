/**
 * Integration tests for routes/facts.ts.
 *
 * Covers the read surface (GET /facts, GET /facts/:factId, GET
 * /facts/:factId/comments, GET /facts/:factId/links) and the rating
 * write surface (POST /facts/:factId/rating).
 *
 * The admin POST /facts and POST /comments endpoints touch AI
 * moderation, embeddings, and captcha — out of scope for this batch.
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
  hashtagsTable,
  factHashtagsTable,
  ratingsTable,
  commentsTable,
  externalLinksTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import factsRouter from "../routes/facts.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";


const USER_PREFIX = "t_routes_f_";
const HASHTAG_PREFIX = "t_routes_f_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(factsRouter);
  return app;
}

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
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

async function insertFact(text: string, opts: { submittedById?: string } = {}): Promise<number> {
  const [row] = await db.insert(factsTable).values({
    text,
    submittedById: opts.submittedById,
    isActive: true,
    canonicalText: text,
  }).returning();
  return row.id;
}

async function cleanup() {
  // Cascade unwinds: comments, ratings, factHashtags, externalLinks, etc.
  // are all FK to facts with cascade. Just delete facts whose submitter is
  // a test user (or nothing — facts can be submitter-less). We track our own
  // facts/hashtags by prefix or the submittedById match.
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  // Hashtags created by tests also get cleaned up by prefix.
  await db.delete(hashtagsTable).where(like(hashtagsTable.name, `${HASHTAG_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("GET /facts", () => {

  it("returns empty arrays when nothing matches", async () => {
    const res = await request(makeApp()).get("/facts").query({ search: "no-such-text-anywhere-zzz" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.facts, []);
    assert.equal(res.body.total, 0);
  });

  it("returns 400 for invalid query params (bad sort)", async () => {
    const res = await request(makeApp()).get("/facts").query({ sort: "garbage" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid query params" });
  });

  it("includes our seeded fact and reports a non-zero total", async () => {
    const userId = await createTestUser();
    const id = await insertFact(`unique-fact-${randomUUID()}`, { submittedById: userId });
    const res = await request(makeApp())
      .get("/facts")
      .query({ search: "unique-fact" });
    assert.equal(res.status, 200);
    const ids = (res.body.facts as Array<{ id: number }>).map((f) => f.id);
    assert.ok(ids.includes(id), "seeded fact id should be in results");
    assert.ok(res.body.total >= 1);
  });

  it("returns empty when filtering by an unknown hashtag", async () => {
    const res = await request(makeApp())
      .get("/facts")
      .query({ hashtag: `${HASHTAG_PREFIX}does-not-exist-${randomUUID()}` });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.facts, []);
    assert.equal(res.body.total, 0);
  });

  it("filters by hashtag when there's a match", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("hashtag-test-fact", { submittedById: userId });
    const tagName = `${HASHTAG_PREFIX}${randomUUID()}`.replace(/[^a-z0-9_]/g, "").slice(0, 80);
    const [tag] = await db.insert(hashtagsTable).values({ name: tagName, factCount: 1 }).returning();
    await db.insert(factHashtagsTable).values({ factId, hashtagId: tag.id });

    const res = await request(makeApp())
      .get("/facts")
      .query({ hashtag: tagName });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.facts[0].id, factId);
  });
});

describe("GET /facts/:factId", () => {

  it("returns 400 for a non-numeric factId", async () => {
    const res = await request(makeApp()).get("/facts/not-a-number");
    assert.equal(res.status, 400);
  });

  it("returns 404 for a missing factId", async () => {
    const res = await request(makeApp()).get("/facts/999999999");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Fact not found" });
  });

  it("returns the fact, its rank, and link/variant arrays on success", async () => {
    const userId = await createTestUser();
    const id = await insertFact("solo-fact", { submittedById: userId });
    const res = await request(makeApp()).get(`/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
    assert.equal(res.body.text, "solo-fact");
    assert.ok("rank" in res.body);
    assert.ok(Array.isArray(res.body.links));
    assert.ok(Array.isArray(res.body.variants));
  });

  it("includes inserted external links on the detail response", async () => {
    const userId = await createTestUser();
    const id = await insertFact("with-links", { submittedById: userId });
    await db.insert(externalLinksTable).values({
      factId: id,
      url: "https://example.com/article",
      title: "Cool article",
    });
    const res = await request(makeApp()).get(`/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.links.length, 1);
    assert.equal(res.body.links[0].url, "https://example.com/article");
  });
});

describe("GET /facts/:factId/related", () => {

  it("returns 400 for a non-numeric factId", async () => {
    const res = await request(makeApp()).get("/facts/not-a-number/related");
    assert.equal(res.status, 400);
  });

  it("returns 404 when the source fact does not exist", async () => {
    const res = await request(makeApp()).get("/facts/999999999/related");
    assert.equal(res.status, 404);
  });

  it("ranks candidates by tag overlap, then Wilson score as tiebreak", async () => {
    const userId = await createTestUser();
    const sourceId = await insertFact("source-fact", { submittedById: userId });

    // Two tags on the source.
    const tagA = `${HASHTAG_PREFIX}${randomUUID()}`.replace(/[^a-z0-9_]/g, "").slice(0, 70);
    const tagB = `${HASHTAG_PREFIX}${randomUUID()}`.replace(/[^a-z0-9_]/g, "").slice(0, 70);
    const [tA] = await db.insert(hashtagsTable).values({ name: tagA }).returning();
    const [tB] = await db.insert(hashtagsTable).values({ name: tagB }).returning();
    await db.insert(factHashtagsTable).values([
      { factId: sourceId, hashtagId: tA.id },
      { factId: sourceId, hashtagId: tB.id },
    ]);

    // Three other facts:
    //   doubleOverlap — shares both tagA + tagB (overlap=2), low Wilson
    //   singleOverlapHigh — shares tagA only (overlap=1), high Wilson
    //   singleOverlapLow — shares tagA only (overlap=1), low Wilson
    const doubleOverlap = await insertFact("double", { submittedById: userId });
    const singleOverlapHigh = await insertFact("single-high", { submittedById: userId });
    const singleOverlapLow = await insertFact("single-low", { submittedById: userId });
    await db.insert(factHashtagsTable).values([
      { factId: doubleOverlap, hashtagId: tA.id },
      { factId: doubleOverlap, hashtagId: tB.id },
      { factId: singleOverlapHigh, hashtagId: tA.id },
      { factId: singleOverlapLow, hashtagId: tA.id },
    ]);
    await db.update(factsTable).set({ wilsonScore: 0.1 }).where(eq(factsTable.id, doubleOverlap));
    await db.update(factsTable).set({ wilsonScore: 0.9 }).where(eq(factsTable.id, singleOverlapHigh));
    await db.update(factsTable).set({ wilsonScore: 0.05 }).where(eq(factsTable.id, singleOverlapLow));

    const res = await request(makeApp())
      .get(`/facts/${sourceId}/related`)
      .query({ limit: 3 });
    assert.equal(res.status, 200);
    const ids = (res.body.facts as Array<{ id: number }>).map((f) => f.id);
    assert.equal(ids[0], doubleOverlap, "highest overlap wins regardless of Wilson");
    assert.equal(ids[1], singleOverlapHigh, "Wilson breaks single-overlap tie");
    assert.equal(ids[2], singleOverlapLow);
  });

  it("excludes the source fact and its variants from the results", async () => {
    const userId = await createTestUser();
    const parentId = await insertFact("parent", { submittedById: userId });
    const [variant] = await db.insert(factsTable).values({
      text: "variant", canonicalText: "variant", isActive: true,
      submittedById: userId, parentId,
    }).returning();

    const tag = `${HASHTAG_PREFIX}${randomUUID()}`.replace(/[^a-z0-9_]/g, "").slice(0, 70);
    const [t] = await db.insert(hashtagsTable).values({ name: tag }).returning();
    await db.insert(factHashtagsTable).values([
      { factId: parentId, hashtagId: t.id },
      { factId: variant.id, hashtagId: t.id },
    ]);

    const res = await request(makeApp()).get(`/facts/${parentId}/related`);
    assert.equal(res.status, 200);
    const ids = (res.body.facts as Array<{ id: number }>).map((f) => f.id);
    assert.ok(!ids.includes(parentId), "source must be excluded");
    assert.ok(!ids.includes(variant.id), "variant must be excluded");
  });

  it("falls back to top-Wilson facts when the source has no hashtags", async () => {
    const userId = await createTestUser();
    const sourceId = await insertFact("untagged-source", { submittedById: userId });
    const filler = await insertFact("filler-target", { submittedById: userId });
    await db.update(factsTable).set({ wilsonScore: 0.99 }).where(eq(factsTable.id, filler));

    const res = await request(makeApp())
      .get(`/facts/${sourceId}/related`)
      .query({ limit: 1 });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.facts));
    // Top-Wilson winner must include our high-Wilson filler.
    assert.equal(res.body.facts[0]?.id, filler);
  });
});

describe("POST /facts/:factId/rating", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post("/facts/1/rating").send({ rating: "up" });
    assert.equal(res.status, 401);
  });

  it("returns 400 when the body fails Zod validation", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/1/rating")
      .set("authorization", `Bearer ${sid}`)
      .send({ rating: "sideways" });
    assert.equal(res.status, 400);
  });

  it("returns 404 when the fact doesn't exist", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/facts/999999/rating")
      .set("authorization", `Bearer ${sid}`)
      .send({ rating: "up" });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Fact not found" });
  });

  it("creates an upvote and increments upvotes/score", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("ratable-fact", { submittedById: userId });

    const res = await request(makeApp())
      .post(`/facts/${factId}/rating`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rating: "up" });
    assert.equal(res.status, 200);
    assert.equal(res.body.upvotes, 1);
    assert.equal(res.body.userRating, "up");

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(row.upvotes, 1);
    assert.equal(row.score, 1);
  });

  it("flips an existing rating and adjusts both counters", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("flippable-fact", { submittedById: userId });

    await request(makeApp()).post(`/facts/${factId}/rating`)
      .set("authorization", `Bearer ${sid}`).send({ rating: "up" });
    const res = await request(makeApp())
      .post(`/facts/${factId}/rating`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rating: "down" });
    assert.equal(res.body.upvotes, 0);
    assert.equal(res.body.downvotes, 1);
    assert.equal(res.body.userRating, "down");
  });

  it("removes an existing rating when 'none' is sent", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const factId = await insertFact("removable-rating", { submittedById: userId });

    await request(makeApp()).post(`/facts/${factId}/rating`)
      .set("authorization", `Bearer ${sid}`).send({ rating: "up" });
    const res = await request(makeApp())
      .post(`/facts/${factId}/rating`)
      .set("authorization", `Bearer ${sid}`)
      .send({ rating: "none" });
    assert.equal(res.body.upvotes, 0);
    assert.equal(res.body.userRating, null);

    const ratings = await db
      .select()
      .from(ratingsTable)
      .where(eq(ratingsTable.factId, factId));
    assert.equal(ratings.length, 0);
  });
});

describe("GET /facts/:factId/comments", () => {

  it("returns 400 for a non-numeric factId", async () => {
    const res = await request(makeApp()).get("/facts/not-a-number/comments");
    assert.equal(res.status, 400);
  });

  it("returns empty arrays when no approved comments exist", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("no-comments", { submittedById: userId });
    const res = await request(makeApp()).get(`/facts/${factId}/comments`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.comments, []);
    assert.equal(res.body.total, 0);
  });

  it("returns approved non-flagged comments only, paginated", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("comment-test", { submittedById: userId });

    await db.insert(commentsTable).values([
      { factId, authorId: userId, text: "approved-1", status: "approved", flagged: false, createdAt: new Date(Date.now() - 3000) },
      { factId, authorId: userId, text: "approved-2", status: "approved", flagged: false, createdAt: new Date(Date.now() - 2000) },
      { factId, authorId: userId, text: "pending",    status: "pending",  flagged: false },
      { factId, authorId: userId, text: "flagged",    status: "approved", flagged: true  },
    ]);

    const res = await request(makeApp()).get(`/facts/${factId}/comments`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    const texts = (res.body.comments as Array<{ text: string }>).map((c) => c.text);
    assert.deepEqual(texts, ["approved-1", "approved-2"]);
  });
});

describe("GET /facts/:factId/links", () => {

  it("returns 400 for a non-numeric factId", async () => {
    const res = await request(makeApp()).get("/facts/abc/links");
    assert.equal(res.status, 400);
  });

  it("returns an empty array when no links exist", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("no-links", { submittedById: userId });
    const res = await request(makeApp()).get(`/facts/${factId}/links`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.links, []);
  });

  it("returns inserted links newest-first", async () => {
    const userId = await createTestUser();
    const factId = await insertFact("links-test", { submittedById: userId });
    await db.insert(externalLinksTable).values([
      { factId, url: "https://e/old", createdAt: new Date(Date.now() - 5000) },
      { factId, url: "https://e/new", createdAt: new Date() },
    ]);
    const res = await request(makeApp()).get(`/facts/${factId}/links`);
    assert.equal(res.status, 200);
    assert.equal(res.body.links.length, 2);
    assert.match(res.body.links[0].url, /new$/);
  });
});
