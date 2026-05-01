/**
 * Integration tests for routes/affiliate.ts.
 *
 * Three endpoints:
 * - POST /affiliate/click       (public; validates body, inserts a click row,
 *                                returns a built Zazzle URL)
 * - GET  /affiliate/zazzle-url  (admin-only; URL preview, no DB write)
 * - GET  /affiliate/stats       (admin-only; aggregated counts + totals)
 *
 * Talks to the real test DB. Click rows are tagged via `sourceId` prefix
 * "t_routes_aff_" and cleaned up before/after each test. Test users use the
 * same USER_PREFIX pattern as other route tests.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, affiliateClicksTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import affiliateRouter from "../routes/affiliate.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";


const SOURCE_PREFIX = "t_routes_aff_";
const USER_PREFIX = "t_routes_au_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(affiliateRouter);
  return app;
}

async function createTestUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
  });
  return id;
}

async function bearerForUser(userId: string, opts: { sessionIsAdmin?: boolean } = {}): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId, isAdmin: opts.sessionIsAdmin } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: opts.sessionIsAdmin,
  };
  return createSession(sessionData, userId);
}

async function cleanup(): Promise<void> {
  await db.delete(affiliateClicksTable).where(like(affiliateClicksTable.sourceId, `${SOURCE_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

const validClick = () => ({
  sourceType: "fact" as const,
  sourceId: `${SOURCE_PREFIX}${randomUUID()}`,
  destination: "zazzle" as const,
  text: "GO LEGENDARY",
});

describe("POST /affiliate/click — input validation", () => {
  before(cleanup);
  after(cleanup);

  it("returns 400 when any required field is missing", async () => {
    for (const omit of ["sourceType", "sourceId", "destination", "text"] as const) {
      const body = { ...validClick() } as Record<string, unknown>;
      delete body[omit];
      const res = await request(makeApp()).post("/affiliate/click").send(body);
      assert.equal(res.status, 400, `expected 400 when ${omit} is missing`);
      assert.equal(
        res.body.error,
        "sourceType, sourceId, destination, and text are required",
      );
    }
  });

  it("returns 400 when text is not a string", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), text: 42 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "text must be a string" });
  });

  it("returns 400 when sourceId is neither a string nor a number", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), sourceId: { id: 1 } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "sourceId must be a string or number" });
  });

  it("returns 400 when imageUrl is supplied as a non-string", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), imageUrl: 42 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "imageUrl must be a string" });
  });

  it("returns 400 when sourceType is not 'fact' or 'meme'", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), sourceType: "tweet" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "sourceType must be 'fact' or 'meme'" });
  });

  it("returns 400 when destination is not 'zazzle'", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), destination: "amazon" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "destination must be 'zazzle'" });
  });

  it("returns 400 when text is longer than 1000 characters", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), text: "x".repeat(1001) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "text must be 1000 characters or fewer" });
  });

  it("returns 400 when imageUrl is longer than 2048 characters", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), imageUrl: `https://e/${"x".repeat(2050)}` });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "imageUrl must be 2048 characters or fewer" });
  });

  it("returns 400 when sourceId stringifies to longer than 255 characters", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), sourceId: "y".repeat(256) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "sourceId must be 255 characters or fewer" });
  });
});

describe("POST /affiliate/click — success path", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("inserts a click row (with null userId for unauthenticated callers) and returns a Zazzle URL", async () => {
    const body = validClick();
    const res = await request(makeApp()).post("/affiliate/click").send(body);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.url, "string");
    assert.match(res.body.url, /^https:\/\/www\.zazzle\.com\/api\/create\/at-/);

    const rows = await db
      .select()
      .from(affiliateClicksTable)
      .where(like(affiliateClicksTable.sourceId, `${SOURCE_PREFIX}%`));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceId, body.sourceId);
    assert.equal(rows[0].sourceType, "fact");
    assert.equal(rows[0].destination, "zazzle");
    assert.equal(rows[0].userId, null);
  });

  it("attaches the userId when the caller has a valid session", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);

    const body = validClick();
    const res = await request(makeApp())
      .post("/affiliate/click")
      .set("authorization", `Bearer ${sid}`)
      .send(body);
    assert.equal(res.status, 200);

    const rows = await db
      .select()
      .from(affiliateClicksTable)
      .where(like(affiliateClicksTable.sourceId, `${SOURCE_PREFIX}%`));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, userId);
  });

  it("accepts a numeric sourceId by stringifying it", async () => {
    const body = { ...validClick(), sourceId: 12345 };
    const res = await request(makeApp()).post("/affiliate/click").send(body);
    assert.equal(res.status, 200);

    const rows = await db
      .select()
      .from(affiliateClicksTable)
      .where(like(affiliateClicksTable.sourceId, `${SOURCE_PREFIX}%`));
    // Numeric sourceId 12345 doesn't carry the prefix, so the prefix LIKE
    // misses it. Instead verify by exact-match.
    const all = await db.select().from(affiliateClicksTable);
    const ours = all.filter((r) => r.sourceId === "12345");
    assert.equal(ours.length, 1);
    await db.delete(affiliateClicksTable).where(like(affiliateClicksTable.sourceId, "12345"));
    void rows; // stash to silence unused warning — covered by the all/ours check
  });

  it("propagates returnUrl into the built Zazzle URL as continueUrl", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), returnUrl: "https://example.com/back" });
    assert.equal(res.status, 200);
    assert.match(res.body.url, /continueUrl=https%3A%2F%2Fexample\.com%2Fback/);
  });

  it("derives imageName from a valid imageUrl's path", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), imageUrl: "https://cdn.example.com/foo/bar/cool.png" });
    assert.equal(res.status, 200);
    assert.match(res.body.url, /ic=cool\.png/);
  });

  it("derives imageName from a malformed imageUrl by string split", async () => {
    const res = await request(makeApp())
      .post("/affiliate/click")
      .send({ ...validClick(), imageUrl: "/relative/path/img.jpg" });
    assert.equal(res.status, 200);
    assert.match(res.body.url, /ic=img\.jpg/);
  });
});

describe("GET /affiliate/zazzle-url — admin-only", () => {
  before(cleanup);
  after(cleanup);

  it("returns 403 for unauthenticated callers", async () => {
    const res = await request(makeApp()).get("/affiliate/zazzle-url");
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "Forbidden" });
  });

  it("returns 403 when authenticated as a non-admin user", async () => {
    const userId = await createTestUser({ isAdmin: false });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/affiliate/zazzle-url")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 403);
  });

  it("returns 200 with a Zazzle URL when authenticated as admin via session", async () => {
    const userId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(userId, { sessionIsAdmin: true });
    const res = await request(makeApp())
      .get("/affiliate/zazzle-url")
      .set("authorization", `Bearer ${sid}`)
      .query({ imageUrl: "https://cdn.example.com/x.png" });
    assert.equal(res.status, 200);
    assert.match(res.body.url, /ic=x\.png/);
  });
});

describe("GET /affiliate/stats — admin-only", () => {
  before(cleanup);
  after(cleanup);

  it("returns 401 for unauthenticated callers (via requireAdmin)", async () => {
    const res = await request(makeApp()).get("/affiliate/stats");
    assert.equal(res.status, 401);
  });

  it("returns 403 for non-admin authenticated callers", async () => {
    const userId = await createTestUser({ isAdmin: false });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .get("/affiliate/stats")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 403);
  });

  it("returns 400 for an unparseable ?from date", async () => {
    const userId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(userId, { sessionIsAdmin: true });
    const res = await request(makeApp())
      .get("/affiliate/stats")
      .set("authorization", `Bearer ${sid}`)
      .query({ from: "not-a-date" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid 'from' date" });
  });

  it("returns 400 for an unparseable ?to date", async () => {
    const userId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(userId, { sessionIsAdmin: true });
    const res = await request(makeApp())
      .get("/affiliate/stats")
      .set("authorization", `Bearer ${sid}`)
      .query({ to: "still-not-a-date" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid 'to' date" });
  });

  it("returns aggregated rows + totals for admin callers", async () => {
    const userId = await createTestUser({ isAdmin: true });
    const sid = await bearerForUser(userId, { sessionIsAdmin: true });

    const sourceId = `${SOURCE_PREFIX}${randomUUID()}`;
    await db.insert(affiliateClicksTable).values([
      { userId: null, sourceType: "fact", sourceId, destination: "zazzle" },
      { userId: null, sourceType: "fact", sourceId, destination: "zazzle" },
    ]);

    const res = await request(makeApp())
      .get("/affiliate/stats")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);

    const ours = (res.body.rows as Array<{ sourceId: string; clicks: number }>)
      .find((r) => r.sourceId === sourceId);
    assert.ok(ours, "our grouped row should be present");
    assert.equal(ours!.clicks, 2);

    assert.ok(Array.isArray(res.body.totals));
  });
});
