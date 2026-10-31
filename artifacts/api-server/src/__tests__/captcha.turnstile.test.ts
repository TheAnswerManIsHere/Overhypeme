/**
 * Cloudflare Turnstile verification (launch Phase 5, increment 1, #795): the
 * shared verifier and every route it guards.
 *
 * Cloudflare's siteverify endpoint is never called: `globalThis.fetch` is
 * replaced for that one URL, answering as Cloudflare's documented test secrets
 * do (always passes, always fails, already spent). What these tests prove is
 * our side of the contract — what we send, how we read the answer, and that
 * each challenged route refuses a failing token and admits a passing one. The
 * live Cloudflare behaviour is a Post-merge verification step of the PR.
 *
 * @purpose Proves the Turnstile verifier's request shape, answer mapping and dev/production secret policy, and that tokenize, comment, share-by-email and onboarding each refuse a failing token and admit a passing one.
 * @subsystem security
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, commentsTable, asyncJobsTable, activityFeedTable } from "@workspace/db/schema";
import { and, eq, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { verifyCaptcha, TURNSTILE_SITEVERIFY_URL } from "../lib/captcha.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";
import usersRouter from "../routes/users.js";
import factsRouter from "../routes/facts.js";
import aiRouter from "../routes/ai.js";
import shareRouter, { __resetShareInviteGuardsForTests } from "../routes/share.js";

const USER_PREFIX = "t_turnstile_u_";
const RECIPIENT_PREFIX = "tturnstileem-";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

// ── The siteverify stand-in ─────────────────────────────────────────────────

type Answer = "pass" | "fail" | "spent" | "http500" | "throw" | "garbage";
let answer: Answer = "pass";
let calls: Array<{ url: string; body: Record<string, string>; contentType: string | null }> = [];

// The sharded runner loads every test file into ONE process
// (--test-isolation=none), and another file may have its own fetch stub in
// place for the whole run (falPricing.test.ts installs one in a root `before`).
// So the stub wraps and restores whatever fetch is current when it goes in —
// never a reference captured at module load, which would silently remove that
// other file's stub and send its requests to the real network.
let fetchBeforeStub: typeof fetch | null = null;

function installSiteverifyStub(): void {
  if (fetchBeforeStub) return;
  const previous = globalThis.fetch;
  fetchBeforeStub = previous;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== TURNSTILE_SITEVERIFY_URL) return previous(input, init);
    const headers = new Headers(init?.headers);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), contentType: headers.get("content-type") });
    switch (answer) {
      case "pass": return Response.json({ success: true, "error-codes": [] });
      case "fail": return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
      case "spent": return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
      case "http500": return new Response("upstream", { status: 500 });
      case "garbage": return new Response("<html>not json</html>", { status: 200 });
      case "throw": throw new TypeError("fetch failed");
    }
  }) as typeof fetch;
}

function uninstallSiteverifyStub(): void {
  if (!fetchBeforeStub) return;
  globalThis.fetch = fetchBeforeStub;
  fetchBeforeStub = null;
}

const savedSecret = process.env.TURNSTILE_SECRET_KEY;
const savedNodeEnv = process.env.NODE_ENV;

function restoreEnv(): void {
  // process.env coerces assigned values to strings, so an unset variable is
  // deleted rather than set to "undefined".
  if (savedSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = savedSecret;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
}

// ── The verifier ────────────────────────────────────────────────────────────

describe("verifyCaptcha — Turnstile siteverify", () => {
  beforeEach(() => { calls = []; answer = "pass"; installSiteverifyStub(); });
  afterEach(() => { uninstallSiteverifyStub(); restoreEnv(); });

  it("posts the secret and the token as JSON to Cloudflare's siteverify URL", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    assert.equal(await verifyCaptcha("tok-123", "203.0.113.9"), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(calls[0].contentType, "application/json");
    assert.deepEqual(calls[0].body, { secret: "test-secret", response: "tok-123", remoteip: "203.0.113.9" });
  });

  it("omits remoteip when the caller has none", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    await verifyCaptcha("tok-123");
    assert.deepEqual(calls[0].body, { secret: "test-secret", response: "tok-123" });
  });

  for (const [a, label] of [
    ["fail", "a rejected token"],
    ["spent", "an already-spent token"],
    ["http500", "a non-2xx answer"],
    ["garbage", "an answer that is not JSON"],
    ["throw", "an unreachable endpoint"],
  ] as const) {
    it(`fails closed on ${label}`, async () => {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      answer = a;
      assert.equal(await verifyCaptcha("tok"), false);
    });
  }

  it("refuses an empty token without calling Cloudflare", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    assert.equal(await verifyCaptcha(""), false);
    assert.equal(calls.length, 0);
  });

  it("fails closed in production when no secret is configured", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    process.env.NODE_ENV = "production";
    assert.equal(await verifyCaptcha("tok"), false);
    assert.equal(calls.length, 0);
  });

  it("skips verification outside production when no secret is configured", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    process.env.NODE_ENV = "test";
    assert.equal(await verifyCaptcha("tok"), true);
    assert.equal(calls.length, 0);
  });
});

// ── The challenged routes ───────────────────────────────────────────────────

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(usersRouter);
  app.use(factsRouter);
  app.use(aiRouter);
  app.use(shareRouter);
  return app;
}

async function createUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, membershipTier: "registered" });
  return id;
}

async function bearerFor(userId: string): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "test-token" };
  return createSession(data, userId);
}

let factId = 0;

async function cleanup(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    // Posting a comment writes an activity row fire-and-forget (logActivity).
    await db.delete(activityFeedTable).where(eq(activityFeedTable.userId, u.id));
    await db.delete(commentsTable).where(eq(commentsTable.authorId, u.id));
  }
  await db.delete(asyncJobsTable).where(and(
    eq(asyncJobsTable.queue, "email"),
    sql`${asyncJobsTable.payload}->>'to' LIKE ${`${RECIPIENT_PREFIX}%`}`,
  ));
  if (factId) await db.delete(factsTable).where(eq(factsTable.id, factId));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

describe("Turnstile at every challenged route (a secret configured)", () => {
  before(async () => {
    await cleanup();
    const [fact] = await db.insert(factsTable)
      .values({ text: "{NAME} can divide by zero.", canonicalText: "{NAME} can divide by zero.", isActive: true, enrichment: buildPlaceholderFactEnrichment() })
      .returning({ id: factsTable.id });
    factId = fact.id;
  });
  after(async () => { await cleanup(); uninstallSiteverifyStub(); restoreEnv(); });
  beforeEach(() => {
    calls = [];
    installSiteverifyStub();
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    __resetShareInviteGuardsForTests();
  });
  afterEach(() => { uninstallSiteverifyStub(); });

  const inviteBody = (captchaToken?: string) => ({
    recipientEmail: `${RECIPIENT_PREFIX}${randomUUID()}@test.local`,
    recipientName: "Pat",
    shareUrl: "https://example.com/share/abc",
    formStartedAt: Date.now() - 5000,
    ...(captchaToken === undefined ? {} : { captchaToken }),
  });

  it("share-by-email from a signed-out sender: no token or a failing one is refused, a passing one is admitted", async () => {
    const app = makeApp();
    answer = "fail";
    assert.equal((await request(app).post("/share/invite").send(inviteBody())).status, 403);
    __resetShareInviteGuardsForTests();
    assert.equal((await request(app).post("/share/invite").send(inviteBody("bad"))).status, 403);
    __resetShareInviteGuardsForTests();
    answer = "pass";
    const ok = await request(app).post("/share/invite").send(inviteBody("good"));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("onboarding completion: a failing token is refused and the flag stays off; a passing one sets it", async () => {
    const userId = await createUser();
    const sid = await bearerFor(userId);
    const app = makeApp();
    answer = "spent";
    const bad = await request(app).post("/users/me/complete-onboarding").set("authorization", `Bearer ${sid}`).send({ captchaToken: "used" });
    assert.equal(bad.status, 400);
    let [row] = await db.select({ v: usersTable.captchaVerified }).from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row.v, false);
    answer = "pass";
    const good = await request(app).post("/users/me/complete-onboarding").set("authorization", `Bearer ${sid}`).send({ captchaToken: "fresh" });
    assert.equal(good.status, 200);
    [row] = await db.select({ v: usersTable.captchaVerified }).from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(row.v, true);
  });

  it("a comment from a registered user without the bypass: refused on a failing token, posted on a passing one", async () => {
    const userId = await createUser();
    const sid = await bearerFor(userId);
    const app = makeApp();
    answer = "fail";
    const bad = await request(app).post(`/facts/${factId}/comments`).set("authorization", `Bearer ${sid}`).send({ text: "Nice one", captchaToken: "bad" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "CAPTCHA verification failed");
    answer = "pass";
    const good = await request(app).post(`/facts/${factId}/comments`).set("authorization", `Bearer ${sid}`).send({ text: "Nice one", captchaToken: "good" });
    assert.ok(good.status === 200 || good.status === 201, `${good.status} ${JSON.stringify(good.body)}`);
    const rows = await db.select({ id: commentsTable.id }).from(commentsTable).where(eq(commentsTable.authorId, userId));
    assert.equal(rows.length, 1);
  });

  it("fact tokenizing from a signed-out visitor: a missing or failing token is refused before any model call", async () => {
    const app = makeApp();
    answer = "fail";
    const none = await request(app).post("/ai/tokenize-fact").send({ text: "Chuck can count to infinity twice." });
    assert.equal(none.status, 400);
    assert.equal(none.body.error, "CAPTCHA verification failed");
    const bad = await request(app).post("/ai/tokenize-fact").send({ text: "Chuck can count to infinity twice.", captchaToken: "bad" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "CAPTCHA verification failed");
    assert.equal(calls.length, 1, "the missing token never reached Cloudflare; the failing one did, once");
  });
});
