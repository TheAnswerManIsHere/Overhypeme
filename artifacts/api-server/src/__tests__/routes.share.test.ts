/**
 * Integration tests for routes/share.ts (POST /share/invite).
 *
 * Talks to the real test DB. Uses supertest to drive the mounted Router with
 * the express.json() body parser in front of it.
 *
 * RESEND_API_KEY is set to a dummy value so sendEmail's isEnabled() check
 * passes and the email-outbox row gets inserted (instead of just being
 * console-logged). Inserted rows are tagged via recipient prefix
 * "trouteshareem-" and cleaned up before/after each test.
 *
 * Prefixes use `-` (not `_`) so SQL LIKE wildcards in the cleanup can't
 * accidentally match other test files' rows during parallel runs. See
 * authMiddleware.test.ts for the full convention.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, emailOutboxTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import shareRouter from "../routes/share.js";
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
  // Prefixes use `-` (not `_`) so SQL LIKE wildcards can't match other test
  // files' rows during parallel runs. See the file header comment.
  await db
    .delete(emailOutboxTable)
    .where(like(emailOutboxTable.to, `${RECIPIENT_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

const validBody = () => ({
  recipientEmail: `${RECIPIENT_PREFIX}${randomUUID()}@test.local`,
  recipientName: "Pat",
  shareUrl: "https://example.com/share/abc",
});

describe("POST /share/invite — input validation", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 400 when recipientEmail is missing", async () => {
    const { recipientEmail: _omit, ...body } = validBody();
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "recipientEmail is required" });
  });

  it("returns 400 when recipientName is missing", async () => {
    const { recipientName: _omit, ...body } = validBody();
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "recipientName is required" });
  });

  it("returns 400 when shareUrl is missing", async () => {
    const { shareUrl: _omit, ...body } = validBody();
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "shareUrl is required" });
  });

  it("returns 400 when any field is the wrong type", async () => {
    const res = await request(makeApp())
      .post("/share/invite")
      .send({ ...validBody(), recipientEmail: 42 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "recipientEmail is required" });
  });

  it("returns 400 when recipientEmail is not a valid address", async () => {
    const res = await request(makeApp())
      .post("/share/invite")
      .send({ ...validBody(), recipientEmail: "not-an-email" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid email address" });
  });
});

describe("POST /share/invite — success path", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns 200 and queues an email row tagged with the recipient", async () => {
    const body = validBody();
    const res = await request(makeApp()).post("/share/invite").send(body);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true });

    const [row] = await db
      .select()
      .from(emailOutboxTable)
      .where(eq(emailOutboxTable.to, body.recipientEmail));
    assert.ok(row, "outbox row should exist");
    // The default sender phrase shows up in the subject line.
    assert.match(row.subject, /Someone thinks/);
    assert.match(row.text ?? "", /SOMEONE THINKS/);
    assert.match(row.text ?? "", /https:\/\/example\.com\/share\/abc/);
  });

  it("uses the authed user's displayName as the sender when a session is presented", async () => {
    const userId = await createTestUser("Alex");
    const sessionData: SessionData = {
      user: { id: userId } as unknown as SessionData["user"],
      access_token: "test-token",
    };
    const sid = await createSession(sessionData, userId);

    const body = validBody();
    const res = await request(makeApp())
      .post("/share/invite")
      .set("authorization", `Bearer ${sid}`)
      .send(body);

    assert.equal(res.status, 200);

    const [row] = await db
      .select()
      .from(emailOutboxTable)
      .where(eq(emailOutboxTable.to, body.recipientEmail));
    assert.ok(row);
    assert.match(row.subject, /Alex thinks/);
    assert.match(row.text ?? "", /ALEX THINKS/);
  });

  it("falls back to the default sender when the session resolves but has no displayName", async () => {
    const userId = await createTestUser(null);
    const sessionData: SessionData = {
      user: { id: userId } as unknown as SessionData["user"],
      access_token: "test-token",
    };
    const sid = await createSession(sessionData, userId);

    const body = validBody();
    const res = await request(makeApp())
      .post("/share/invite")
      .set("authorization", `Bearer ${sid}`)
      .send(body);

    assert.equal(res.status, 200);

    const [row] = await db
      .select()
      .from(emailOutboxTable)
      .where(eq(emailOutboxTable.to, body.recipientEmail));
    assert.ok(row);
    assert.match(row.subject, /Someone thinks/);
  });

  it("trims whitespace from recipientEmail and recipientName before use", async () => {
    const recipient = `${RECIPIENT_PREFIX}${randomUUID()}@test.local`;
    const res = await request(makeApp()).post("/share/invite").send({
      recipientEmail: `   ${recipient}   `,
      recipientName: "  Casey  ",
      shareUrl: "https://example.com/share/xyz",
    });
    assert.equal(res.status, 200);

    const [row] = await db
      .select()
      .from(emailOutboxTable)
      .where(eq(emailOutboxTable.to, recipient));
    assert.ok(row, "row should be inserted under the trimmed recipient");
  });
});
