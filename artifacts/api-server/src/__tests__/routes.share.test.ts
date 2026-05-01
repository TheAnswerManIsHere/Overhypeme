import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, emailOutboxTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import shareRouter, { __resetShareInviteGuardsForTests } from "../routes/share.js";
import { createSession, type SessionData } from "../lib/auth.js";

const RECIPIENT_PREFIX = "trouteshareem-";
const USER_PREFIX = "trouteshareu-";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(shareRouter);
  return app;
}

async function createTestUser(displayName: string | null): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    displayName,
  });
  return id;
}

async function cleanup(): Promise<void> {
  await db.delete(emailOutboxTable).where(like(emailOutboxTable.to, `${RECIPIENT_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

const validBody = () => ({
  recipientEmail: `${RECIPIENT_PREFIX}${randomUUID()}@test.local`,
  recipientName: "Pat",
  shareUrl: "https://example.com/share/abc",
  formStartedAt: Date.now() - 5000,
  captchaToken: "captcha-token",
});

describe("POST /share/invite", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(async () => {
    __resetShareInviteGuardsForTests();
    await cleanup();
  });
  afterEach(async () => {
    __resetShareInviteGuardsForTests();
    await cleanup();
  });

  it("returns 400 when recipientEmail is missing", async () => {
    const { recipientEmail: _omit, ...body } = validBody();
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 400);
  });

  it("returns 403 when anonymous request is missing captchaToken", async () => {
    const body = validBody();
    delete (body as { captchaToken?: string }).captchaToken;
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "CAPTCHA required" });
  });

  it("returns 400 when shareUrl host/path is not allowlisted", async () => {
    const res = await request(makeApp())
      .post("/share/invite")
      .send({ ...validBody(), shareUrl: "https://evil.example.net/phish" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "shareUrl host/path not allowed" });
  });

  it("returns 429 when route-level rate limit is exceeded", async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      const response = await request(app).post("/share/invite").send({
        ...validBody(),
        recipientEmail: `${RECIPIENT_PREFIX}${randomUUID()}@test.local`,
        shareUrl: `https://example.com/share/${randomUUID()}`,
      });
      lastStatus = response.status;
    }
    assert.equal(lastStatus, 429);
  });

  it("returns 200 and queues invite email", async () => {
    const body = validBody();
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 200);

    const [row] = await db.select().from(emailOutboxTable).where(eq(emailOutboxTable.to, body.recipientEmail));
    assert.ok(row);
  });

  it("uses authed displayName as sender", async () => {
    const userId = await createTestUser("Alex");
    const sid = await createSession({ user: { id: userId } as SessionData["user"], access_token: "x" }, userId);
    const body = validBody();
    const res = await request(makeApp()).post("/share/invite").set("authorization", `Bearer ${sid}`).send(body);
    assert.equal(res.status, 200);
  });
});
