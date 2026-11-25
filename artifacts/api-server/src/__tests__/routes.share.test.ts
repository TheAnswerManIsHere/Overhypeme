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
 * accidentally match other test files' rows during parallel runs.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, asyncJobsTable } from "@workspace/db/schema";
import { eq, like, sql, and } from "drizzle-orm";

type EmailJobPayload = { to: string; subject: string; text: string; html?: string | null; kind?: string | null };
function emailPayload(row: { payload: unknown }): EmailJobPayload {
  return row.payload as EmailJobPayload;
}
function whereEmailTo(to: string) {
  return and(eq(asyncJobsTable.queue, "email"), sql`${asyncJobsTable.payload}->>'to' = ${to}`);
}

import shareRouter, { __resetShareInviteGuardsForTests } from "../routes/share.js";
import { createSession, type SessionData } from "../lib/auth.js";


const RECIPIENT_PREFIX = "trouteshareem-";
const USER_PREFIX = "trouteshareu-";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

// Ensure TURNSTILE_SECRET_KEY is unset so verifyCaptcha uses its dev-bypass path.
// In CI / local dev the secret may be injected by the environment; unset it
// here so dummy captcha tokens are accepted without a real API call.
const _savedTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
delete process.env.TURNSTILE_SECRET_KEY;

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
  await db.delete(asyncJobsTable).where(and(
    eq(asyncJobsTable.queue, "email"),
    sql`${asyncJobsTable.payload}->>'to' LIKE ${`${RECIPIENT_PREFIX}%`}`,
  ));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

const validBody = () => ({
  recipientEmail: `${RECIPIENT_PREFIX}${randomUUID()}@test.local`,
  recipientName: "Alex",
  // The shape ShareModal really sends (#374): the visitor's own origin, a fact
  // page, and the two personalisation fields.
  shareUrl: "https://whatever.replit.dev/facts/12?displayName=Alex&pronouns=they%2Fthem",
  formStartedAt: Date.now() - 5000,
  captchaToken: "captcha-token",
});

describe("POST /share/invite", () => {
  before(cleanup);
  after(async () => {
    await cleanup();
    if (_savedTurnstileSecret !== undefined) process.env.TURNSTILE_SECRET_KEY = _savedTurnstileSecret;
  });
  beforeEach(async () => {
    __resetShareInviteGuardsForTests();
    await cleanup();
  });
  afterEach(async () => {
    __resetShareInviteGuardsForTests();
    await cleanup();
  });

  // ── Input validation (field presence / type) ──────────────────────────────

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

  // ── Security guards (origin additions) ───────────────────────────────────

  it("returns 403 when anonymous request is missing captchaToken", async () => {
    const body = validBody();
    delete (body as { captchaToken?: string }).captchaToken;
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "CAPTCHA required" });
  });

  it("returns 400 when shareUrl names a page a share may not point at", async () => {
    for (const shareUrl of [
      "https://evil.example.net/phish",
      "https://overhype.me/share/abc",
      "https://overhype.me/facts/12/extra",
      "https://overhype.me/facts/0",
      "javascript:alert(1)",
      "not a url",
    ]) {
      __resetShareInviteGuardsForTests();
      const res = await request(makeApp())
        .post("/share/invite")
        .send({ ...validBody(), shareUrl });
      assert.equal(res.status, 400, shareUrl);
      assert.deepEqual(res.body, { error: "shareUrl host/path not allowed" }, shareUrl);
    }
  });

  // #374: the link is rebuilt on our own address. The client's host, extra
  // parameters and fragment never reach the email, and the name is the
  // validated recipient name, not the URL's.
  it("rebuilds the emailed link on the site's own address from the page and the two fields", async () => {
    const body = {
      ...validBody(),
      shareUrl: "https://evil.example.net/facts/7/?displayName=Raena&pronouns=she%2Fher&next=https%3A%2F%2Fevil.example.net#x",
    };
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 200);
    const [row] = await db.select().from(asyncJobsTable).where(whereEmailTo(body.recipientEmail));
    const text = emailPayload(row!).text ?? "";
    assert.match(text, /https:\/\/overhype\.me\/facts\/7\?displayName=Alex&pronouns=she%2Fher/);
    assert.doesNotMatch(text, /evil\.example\.net|Raena|next=/);
  });

  it("accepts the home page as a share target", async () => {
    const body = { ...validBody(), shareUrl: "https://overhype.me/?displayName=Alex&pronouns=he%2Fhim" };
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 200);
    const [row] = await db.select().from(asyncJobsTable).where(whereEmailTo(body.recipientEmail));
    assert.match(emailPayload(row!).text ?? "", /https:\/\/overhype\.me\/\?displayName=Alex&pronouns=he%2Fhim/);
  });

  it("returns 429 when route-level rate limit is exceeded", async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      const response = await request(app).post("/share/invite").send({
        ...validBody(),
        recipientEmail: `${RECIPIENT_PREFIX}${randomUUID()}@test.local`,
        shareUrl: `https://overhype.me/facts/${1 + Math.floor(Math.random() * 1e6)}`,
      });
      lastStatus = response.status;
    }
    assert.equal(lastStatus, 429);
  });

  it("caps invites per page, whatever name or pronouns the sender types", async () => {
    const app = makeApp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await request(app).post("/share/invite").send({
        ...validBody(),
        recipientEmail: `${RECIPIENT_PREFIX}${randomUUID()}@test.local`,
        recipientName: `Alex${String.fromCharCode(97 + i)}`,
        shareUrl: `https://overhype.me/facts/77?displayName=x&pronouns=p${i}`,
      });
      statuses.push(response.status);
      if (i === 10) assert.deepEqual(response.body, { error: "Origin throttle exceeded" });
    }
    assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  });

  // ── Success path ──────────────────────────────────────────────────────────

  it("returns 200 and queues invite email", async () => {
    const body = validBody();
    const res = await request(makeApp()).post("/share/invite").send(body);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true });

    const [row] = await db.select().from(asyncJobsTable).where(whereEmailTo(body.recipientEmail));
    assert.ok(row, "outbox row should exist");
    const p = emailPayload(row);
    assert.match(p.subject, /Someone thinks/);
    assert.match(p.text ?? "", /SOMEONE THINKS/);
    // Rebuilt on the site's own address, whatever host the client sent.
    assert.match(p.text ?? "", /https:\/\/overhype\.me\/facts\/12\?displayName=Alex&pronouns=they%2Fthem/);
    assert.doesNotMatch(p.text ?? "", /replit\.dev/);
  });

  it("uses authed displayName as sender", async () => {
    const userId = await createTestUser("Alex");
    const sid = await createSession({ user: { id: userId } as SessionData["user"], access_token: "x" }, userId);
    const body = validBody();
    const res = await request(makeApp()).post("/share/invite").set("authorization", `Bearer ${sid}`).send(body);
    assert.equal(res.status, 200);

    const [row] = await db
      .select()
      .from(asyncJobsTable)
      .where(whereEmailTo(body.recipientEmail));
    assert.ok(row);
    const p = emailPayload(row);
    assert.match(p.subject, /Alex thinks/);
    assert.match(p.text ?? "", /ALEX THINKS/);
  });

  it("falls back to the default sender when the session resolves but has no displayName", async () => {
    const userId = await createTestUser(null);
    const sid = await createSession({ user: { id: userId } as SessionData["user"], access_token: "x" }, userId);
    const body = validBody();
    const res = await request(makeApp()).post("/share/invite").set("authorization", `Bearer ${sid}`).send(body);
    assert.equal(res.status, 200);

    const [row] = await db
      .select()
      .from(asyncJobsTable)
      .where(whereEmailTo(body.recipientEmail));
    assert.ok(row);
    assert.match(emailPayload(row).subject, /Someone thinks/);
  });

  it("trims whitespace from recipientEmail and recipientName before use", async () => {
    const recipient = `${RECIPIENT_PREFIX}${randomUUID()}@test.local`;
    const res = await request(makeApp()).post("/share/invite").send({
      ...validBody(),
      recipientEmail: `   ${recipient}   `,
      recipientName: "  Alex  ",
      shareUrl: "https://overhype.me/facts/12?displayName=Alex",
    });
    assert.equal(res.status, 200);

    const [row] = await db
      .select()
      .from(asyncJobsTable)
      .where(whereEmailTo(recipient));
    assert.ok(row, "row should be inserted under the trimmed recipient");
  });
});
