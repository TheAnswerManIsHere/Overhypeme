/**
 * Integration tests for routes/ai.ts — auth + body-validation surface.
 *
 * Each AI endpoint hits OpenAI on the success path, so this batch only
 * covers the parts that gate execution before the OpenAI call:
 *   - The custom requireAuth middleware on /ai/check-duplicate and
 *     /ai/suggest-hashtags (reads session directly via getSessionId).
 *   - Zod 400 on every endpoint.
 *   - The captcha bypass on /ai/tokenize-fact when no token is supplied.
 *
 * The OpenAI-call success paths (the actual duplicate / hashtag / token
 * logic) require live OPENAI_API_KEY and are out of scope.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import aiRouter from "../routes/ai.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";


const USER_PREFIX = "t_routes_ai_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(aiRouter);
  return app;
}

async function createTestUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    captchaVerified: true,
  });
  return id;
}

async function bearerForUser(userId: string): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
    captchaVerified: true,
  };
  return createSession(sessionData, userId);
}

async function cleanup() {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("POST /ai/check-duplicate — auth + validation", () => {

  it("returns 401 when no session is presented", async () => {
    const res = await request(makeApp())
      .post("/ai/check-duplicate")
      .send({ text: "this is a fact long enough" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Authentication required" });
  });

  it("returns 401 when the bearer token doesn't resolve to a session", async () => {
    const res = await request(makeApp())
      .post("/ai/check-duplicate")
      .set("authorization", "Bearer no-such-session")
      .send({ text: "this is a fact long enough" });
    assert.equal(res.status, 401);
  });

  it("returns 400 when text is too short (Zod min(10))", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/ai/check-duplicate")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "short" });
    assert.equal(res.status, 400);
  });

  it("returns 400 when text exceeds the max length (Zod max(1000))", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/ai/check-duplicate")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "x".repeat(1001) });
    assert.equal(res.status, 400);
  });
});

describe("POST /ai/suggest-hashtags — auth + validation", () => {

  it("returns 401 when no session is presented", async () => {
    const res = await request(makeApp())
      .post("/ai/suggest-hashtags")
      .send({ text: "fact text" });
    assert.equal(res.status, 401);
  });

  it("returns 400 when text is too short (Zod min(5))", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/ai/suggest-hashtags")
      .set("authorization", `Bearer ${sid}`)
      .send({ text: "abc" });
    assert.equal(res.status, 400);
  });
});

describe("POST /ai/tokenize-fact — body validation", () => {
  it("does not require auth (public)", async () => {
    // The endpoint is reachable without auth — it 400s on bad body, not 401.
    const res = await request(makeApp())
      .post("/ai/tokenize-fact")
      .send({ text: "longer-than-five-chars" });
    // 400 is acceptable (Zod success → would hit OpenAI), or any non-401.
    assert.notEqual(res.status, 401);
  });

  it("returns 400 when text is too short (Zod min(5))", async () => {
    const res = await request(makeApp())
      .post("/ai/tokenize-fact")
      .send({ text: "abc" });
    assert.equal(res.status, 400);
  });

  it("returns 400 when text is too long (Zod max(2000))", async () => {
    const res = await request(makeApp())
      .post("/ai/tokenize-fact")
      .send({ text: "x".repeat(2001) });
    assert.equal(res.status, 400);
  });
});

describe("POST /ai/suggest-pronouns — body validation", () => {
  it("does not require auth (public)", async () => {
    // Send a body that fails Zod (empty name) so the handler responds
    // with a 400 BEFORE invoking OpenAI. We only need to confirm the
    // request isn't bounced with 401 by the auth middleware — getting
    // a 400 from the Zod check inside the handler proves auth was
    // bypassed. Sending a valid body would trigger a 1+ second OpenAI
    // round trip in CI for no additional coverage.
    const res = await request(makeApp())
      .post("/ai/suggest-pronouns")
      .send({ name: "" });
    assert.notEqual(res.status, 401);
  });

  it("returns 400 when name is empty (Zod min(1))", async () => {
    const res = await request(makeApp())
      .post("/ai/suggest-pronouns")
      .send({ name: "" });
    assert.equal(res.status, 400);
  });

  it("returns 400 when name exceeds the max length (Zod max(200))", async () => {
    const res = await request(makeApp())
      .post("/ai/suggest-pronouns")
      .send({ name: "x".repeat(201) });
    assert.equal(res.status, 400);
  });
});
