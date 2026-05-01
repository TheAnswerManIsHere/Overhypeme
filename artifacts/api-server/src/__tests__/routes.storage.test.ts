/**
 * Integration tests for routes/storage.ts — auth + validation surface.
 *
 * Every success path inside this router calls into ObjectStorageService,
 * which talks to GCS and isn't reachable from the sandbox. Tests focus on
 * the gates that fire BEFORE the GCS call:
 *   - auth checks
 *   - membership-tier checks (avatar upload requires legendary)
 *   - content-type / body / size validation
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import storageRouter from "../routes/storage.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";


const USER_PREFIX = "t_routes_st2_";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(storageRouter);
  return app;
}

async function createTestUser(opts: {
  membershipTier?: "unregistered" | "registered" | "legendary";
} = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.membershipTier ?? "registered",
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

async function cleanup() {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("POST /storage/uploads/request-url — auth + body validation", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/storage/uploads/request-url")
      .send({ name: "x.png", size: 1, contentType: "image/png" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Authentication required" });
  });

  it("returns 400 when the body fails the Zod schema", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/storage/uploads/request-url")
      .set("authorization", `Bearer ${sid}`)
      .send({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Missing or invalid required fields" });
  });
});

describe("POST /storage/upload-avatar — pre-GCS gates", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/storage/upload-avatar")
      .set("content-type", "image/png")
      .send(Buffer.from("not really a png"));
    assert.equal(res.status, 401);
  });

  it("returns 403 for non-legendary users (Custom photo upload is a Legendary feature)", async () => {
    const userId = await createTestUser({ membershipTier: "registered" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/storage/upload-avatar")
      .set("authorization", `Bearer ${sid}`)
      .set("content-type", "image/png")
      .send(Buffer.from("anything"));
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Legendary feature/);
  });

  it("returns 400 for an unsupported content-type when caller is legendary", async () => {
    const userId = await createTestUser({ membershipTier: "legendary" });
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/storage/upload-avatar")
      .set("authorization", `Bearer ${sid}`)
      .set("content-type", "image/svg+xml")
      .send(Buffer.from("<svg/>"));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /JPEG, PNG, WebP, or GIF/);
  });
});

describe("POST /storage/upload-meme — pre-GCS gates", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/storage/upload-meme")
      .set("content-type", "image/jpeg")
      .send(Buffer.from("not a real jpeg"));
    assert.equal(res.status, 401);
  });

  it("returns 415 for non-JPEG content types", async () => {
    const userId = await createTestUser();
    const sid = await bearerForUser(userId);
    const res = await request(makeApp())
      .post("/storage/upload-meme")
      .set("authorization", `Bearer ${sid}`)
      .set("content-type", "image/png")
      .send(Buffer.from("anything"));
    assert.equal(res.status, 415);
    assert.match(res.body.error, /JPEG/);
  });

  // Note: a 'bogus jpeg → 422' test would be ideal, but sharp's behaviour on
  // random byte streams varies (sometimes throws → 422, sometimes passes the
  // header check and fails later in the GCS upload → 500). Both responses are
  // 'we refused the upload', but the boundary isn't deterministic enough to
  // assert on without a real malformed-JPEG fixture.
});
