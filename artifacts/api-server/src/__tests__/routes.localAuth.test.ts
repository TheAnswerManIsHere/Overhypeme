/**
 * Integration tests for routes/localAuth.ts.
 *
 * Covers email/password registration, login, password reset,
 * email-verification, the check-email screen's link (#868), set-password,
 * and unlink-provider.
 *
 * The forgot-password and resend-verification rate limiters are DB-backed
 * (rate_limit_counters). Forgot-password tests vary the CF-Connecting-IP
 * header so each gets its own bucket. The before() hook clears any stale
 * rate-limit rows so back-to-back validation runs start from a clean state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";
import bcrypt from "bcryptjs";

import { db } from "@workspace/db";
import {
  usersTable,
  passwordResetTokensTable,
  emailVerificationTokensTable,
  sessionsTable,
  rateLimitCountersTable,
  asyncJobsTable,
} from "@workspace/db/schema";
import { eq, like, sql, and } from "drizzle-orm";

import localAuthRouter from "../routes/localAuth.js";
import { createApp } from "../app.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData, BOOTSTRAP_ADMIN_EMAIL } from "../lib/auth.js";


const USER_PREFIX = "t_routes_la_";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

let _testIpCounter = 0;
function makeApp(): Express {
  const app = express();
  // local-login / register / forgot-password are per-IP rate limited via
  // ipFromRequest(), which trusts CF-Connecting-IP. Every supertest request
  // otherwise shares one socket IP, which would exhaust the bucket across the
  // file. Give each request a distinct CF-Connecting-IP unless the test set one
  // explicitly (forgot-password tests set their own).
  app.use((req, _res, next) => {
    if (!req.headers["cf-connecting-ip"]) {
      _testIpCounter += 1;
      req.headers["cf-connecting-ip"] = `172.16.${(_testIpCounter >> 8) & 255}.${_testIpCounter & 255}`;
    }
    next();
  });
  app.use(express.json());
  app.use(authMiddleware);
  app.use(localAuthRouter);
  return app;
}

function uniqueEmail() {
  return `${USER_PREFIX}${randomUUID()}@test.local`;
}

async function createUserWithPassword(opts: {
  password?: string;
  email?: string;
} = {}): Promise<{ id: string; email: string; password: string }> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  const password = opts.password ?? "supersecret123";
  const email = opts.email ?? `${id}@test.local`;
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(usersTable).values({
    id,
    email,
    passwordHash,
  });
  return { id, email, password };
}

async function bearerForUser(userId: string): Promise<string> {
  const sessionData: SessionData = {
    user: { id: userId } as unknown as SessionData["user"],
    access_token: "test-token",
  };
  return createSession(sessionData, userId);
}

async function cleanupRateLimitCounters() {
  await db
    .delete(rateLimitCountersTable)
    .where(sql`${rateLimitCountersTable.keyRaw} LIKE 'rl|auth.forgot-password|%'`);
  await db
    .delete(rateLimitCountersTable)
    .where(sql`${rateLimitCountersTable.keyRaw} LIKE 'rl|auth.resend-verification|%'`);
  await db
    .delete(rateLimitCountersTable)
    .where(sql`${rateLimitCountersTable.keyRaw} LIKE 'rl|auth.local-login|%'`);
  await db
    .delete(rateLimitCountersTable)
    .where(sql`${rateLimitCountersTable.keyRaw} LIKE 'rl|auth.register|%'`);
}

async function cleanupOutbox() {
  await db.delete(asyncJobsTable).where(and(
    eq(asyncJobsTable.queue, "email"),
    sql`${asyncJobsTable.payload}->>'to' LIKE ${`${USER_PREFIX}%`}`,
  ));
}

async function cleanupUsers() {
  // Clean dependent rows first, then users.
  await db
    .delete(emailVerificationTokensTable)
    .where(like(emailVerificationTokensTable.userId, `${USER_PREFIX}%`));
  await db
    .delete(passwordResetTokensTable)
    .where(like(passwordResetTokensTable.userId, `${USER_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.email, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanupRateLimitCounters();
  await cleanupOutbox();
  await cleanupUsers();
});
after(async () => {
  await cleanupRateLimitCounters();
  await cleanupOutbox();
  await cleanupUsers();
});

describe("POST /auth/register — validation", () => {

  it("rejects missing email or password", async () => {
    const r1 = await request(makeApp()).post("/auth/register").send({ password: "x" });
    assert.equal(r1.status, 400);
    assert.deepEqual(r1.body, { error: "Email and password are required" });

    const r2 = await request(makeApp()).post("/auth/register").send({ email: "a@b.c" });
    assert.equal(r2.status, 400);
  });

  it("rejects malformed emails", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: "not-an-email", password: "longenough", displayName: "x", firstName: "f", lastName: "l" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "A valid email address is required" });
  });

  it("rejects passwords shorter than 8 characters", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "short" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Password must be at least 8 characters" });
  });

  it("rejects passwords longer than 128 characters", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "x".repeat(129) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Password must be 128 characters or fewer" });
  });

  it("rejects an empty displayName", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "  ", firstName: "Alex", lastName: "Franklin" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Name cannot be empty");
  });

  // The shared name rule (identity-flow Phase 2): 50 visible characters,
  // no word cap, and a disallowed character refused rather than stripped.
  it("rejects a displayName over 50 characters", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "x".repeat(51) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /50 characters or fewer/);
  });

  it("rejects a displayName with an emoji instead of stripping it", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "Alex 🦊", firstName: "Alex", lastName: "Franklin" });
    assert.equal(res.status, 400);
  });

  it("rejects an email that's already in use", async () => {
    const { email } = await createUserWithPassword();
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email, password: "longenough", displayName: "Alex", firstName: "f", lastName: "l" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "Email is already in use" });
  });

  it("requires firstName", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "Alex", lastName: "l" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "First Name is required." });
  });

  it("requires lastName", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "Alex", firstName: "f" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Last Name is required." });
  });
});

describe("POST /auth/register — success", () => {

  it("creates the user and returns a session", async () => {
    const email = uniqueEmail();
    const res = await request(makeApp())
      .post("/auth/register")
      .send({
        email,
        password: "supersecret",
        displayName: "Alex",
        firstName: "Alex",
        lastName: "Franklin",
        pronouns: "they/them",
      });
    assert.equal(res.status, 201);
    assert.equal("sid" in res.body, false);
    assert.equal(res.body.user.email, email);
    const rawCookies1 = res.headers["set-cookie"];
    const setCookie1: string[] = Array.isArray(rawCookies1) ? rawCookies1 : rawCookies1 ? [rawCookies1] : [];
    assert.ok(setCookie1.some((c) => c.startsWith("sid=")), "sid cookie should be set");

    const [row] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    assert.ok(row);
    assert.equal(row.displayName, "Alex");
    assert.equal(row.firstName, "Alex");
    assert.equal(row.lastName, "Franklin");
    assert.equal(row.pronouns, "they/them");
    assert.ok(row.passwordHash, "passwordHash should be set");
  });
});

// Issue #1203 (Q6): an email-and-password sign-up returns to the page it
// started from. The page is stored on the account at registration, handed
// back once when the registration email is verified, and never read by an
// email-change confirmation.
describe("sign-up return destination (Issue #1203)", () => {
  async function register(returnTo: unknown): Promise<string> {
    const email = uniqueEmail();
    const res = await request(makeApp()).post("/auth/register")
      .send({ email, password: "supersecret", displayName: "Alex", firstName: "Alex", lastName: "Franklin", returnTo });
    assert.equal(res.status, 201, res.text);
    const [row] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
    return row!.id;
  }
  async function stored(id: string): Promise<string | null> {
    const [row] = await db.select({ v: usersTable.signupReturnTo }).from(usersTable).where(eq(usersTable.id, id));
    return row!.v;
  }
  async function token(id: string, opts: { expired?: boolean; pendingEmail?: string } = {}): Promise<string> {
    const raw = randomBytes(32).toString("hex");
    await db.insert(emailVerificationTokensTable).values({
      userId: id,
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 24 * 60 * 60_000)),
      pendingEmail: opts.pendingEmail ?? null,
    });
    return raw;
  }
  const verify = (raw: string) => request(makeApp()).get("/auth/verify-email").query({ token: raw });

  it("stores the page at registration, hands it back once on verification, then clears it", async () => {
    const id = await register("/fact/42?name=Alex#top");
    assert.equal(await stored(id), "/fact/42?name=Alex#top");
    const raw = await token(id);
    const res = await verify(raw);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.returnTo, "/fact/42?name=Alex#top");
    assert.equal(await stored(id), null, "cleared once handed back");
    const again = await verify(raw);
    assert.equal(again.body.message, "Email already verified.");
  });

  it("stores nothing for an unsafe, home or sign-in-flow destination, and verification returns null", async () => {
    for (const bad of ["https://evil.com/x", "//evil.com", "/\\evil.com", "javascript:alert(1)", "/", "/login?from=%2Ffact%2F1", "/onboard", "/verify-email?token=x", "/check-email", 42]) {
      const id = await register(bad);
      assert.equal(await stored(id), null, `nothing stored for ${String(bad)}`);
      const res = await verify(await token(id));
      assert.equal(res.status, 200);
      assert.equal(res.body.returnTo, null);
    }
  });

  it("a registration with no page verifies to null, so the page falls back to the profile", async () => {
    const id = await register(undefined);
    assert.equal(await stored(id), null);
    assert.equal((await verify(await token(id))).body.returnTo, null);
  });

  it("an expired first link leaves the page for its replacement, whatever sent it", async () => {
    const id = await register("/memes/abc");
    const first = await token(id, { expired: true });
    assert.equal((await verify(first)).status, 400, "the expired link is refused");
    assert.equal(await stored(id), "/memes/abc", "and the page is still kept");
    const res = await verify(await token(id));
    assert.equal(res.body.returnTo, "/memes/abc");
  });

  it("keeps a destination longer than 2,048 characters intact", async () => {
    const long = `/search?q=${encodeURIComponent("é".repeat(350))}`;
    assert.ok(long.length > 2048);
    const id = await register(long);
    assert.equal(await stored(id), long);
    assert.equal((await verify(await token(id))).body.returnTo, long);
  });

  // The two cases PR #1222's build report found the plan listed and the PR
  // left out: links made by the real resend paths, not inserted by hand. The
  // test run's re_test_ key suppresses the outbox row (sendVerificationEmail
  // passes insertUnderTestKey: false), so the raw token is never readable.
  // The test therefore takes the token row the real path created and re-keys
  // it to a known value. The row, and the account it belongs to, are the
  // resend's own; only its secret is replaced.
  async function newestTokenFromRealSend(userId: string): Promise<string> {
    const rows = await db.select({ id: emailVerificationTokensTable.id }).from(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, userId));
    const newest = rows.sort((a, b) => b.id - a.id)[0];
    assert.ok(newest, "the resend created a link");
    const raw = randomBytes(32).toString("hex");
    await db.update(emailVerificationTokensTable)
      .set({ tokenHash: createHash("sha256").update(raw).digest("hex") })
      .where(eq(emailVerificationTokensTable.id, newest.id));
    return raw;
  }
  async function registerWithSession(returnTo: string): Promise<{ id: string; sid: string }> {
    const id = await register(returnTo);
    return { id, sid: await bearerForUser(id) };
  }

  it("a link from the real resend request returns the stored page", async () => {
    const { id, sid } = await registerWithSession("/fact/99");
    const res = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200, res.text);
    await new Promise((r) => setTimeout(r, 150)); // the normal resend sends without awaiting
    const before = (await db.select({ id: emailVerificationTokensTable.id }).from(emailVerificationTokensTable).where(eq(emailVerificationTokensTable.userId, id))).length;
    assert.ok(before >= 2, "the resend made a second link beside registration's");
    const verified = await verify(await newestTokenFromRealSend(id));
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.returnTo, "/fact/99");
    assert.equal(await stored(id), null);
  });

  it("after a failed first send, the check-email screen's own send returns the stored page", async () => {
    const { id, sid } = await registerWithSession("/memes/xyz?ref=1");
    await new Promise((r) => setTimeout(r, 150));
    // The first send failed: no link exists for the account.
    await db.delete(emailVerificationTokensTable).where(eq(emailVerificationTokensTable.userId, id));
    const res = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`).send({ ifNoneOut: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, "sent");
    const verified = await verify(await newestTokenFromRealSend(id));
    assert.equal(verified.body.returnTo, "/memes/xyz?ref=1");
  });

  it("an email-change confirmation neither reads nor clears the sign-up page", async () => {
    const id = await register("/fact/7");
    await db.update(usersTable).set({ emailVerifiedAt: new Date() }).where(eq(usersTable.id, id));
    const newEmail = uniqueEmail();
    await db.update(usersTable).set({ pendingEmail: newEmail }).where(eq(usersTable.id, id));
    const res = await verify(await token(id, { pendingEmail: newEmail }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.returnTo, null);
    assert.equal(await stored(id), "/fact/7", "left untouched");
  });
});

describe("POST /auth/local-login", () => {

  it("returns 400 when email or password is missing", async () => {
    const res = await request(makeApp()).post("/auth/local-login").send({});
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Email and password are required" });
  });

  it("returns 400 when types are wrong", async () => {
    const res = await request(makeApp())
      .post("/auth/local-login")
      .send({ email: 1, password: 1 });
    assert.equal(res.status, 400);
  });

  it("returns 401 when no user matches the email", async () => {
    const res = await request(makeApp())
      .post("/auth/local-login")
      .send({ email: uniqueEmail(), password: "anything-long-enough" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Invalid email or password" });
  });

  it("returns 401 with a Google-specific message for Google-only accounts", async () => {
    const id = `${USER_PREFIX}${randomUUID()}`;
    const email = `${id}@test.local`;
    await db.insert(usersTable).values({ id, email, googleLinked: true });
    const res = await request(makeApp())
      .post("/auth/local-login")
      .send({ email, password: "doesnt-matter" });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Google sign-in/);
  });

  it("returns 401 with an Apple-specific message for Apple-only accounts", async () => {
    const id = `${USER_PREFIX}${randomUUID()}`;
    const email = `${id}@test.local`;
    await db.insert(usersTable).values({ id, email, appleLinked: true });
    const res = await request(makeApp())
      .post("/auth/local-login")
      .send({ email, password: "doesnt-matter" });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Apple sign-in/);
  });

  it("returns 401 when the password is wrong", async () => {
    const { email } = await createUserWithPassword({ password: "right-password" });
    const res = await request(makeApp())
      .post("/auth/local-login")
      .send({ email, password: "wrong-password" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Invalid email or password" });
  });

  it("returns a session on the happy path", async () => {
    const { email, password } = await createUserWithPassword();
    const res = await request(makeApp())
      .post("/auth/local-login")
      .send({ email, password });
    assert.equal(res.status, 200);
    assert.equal("sid" in res.body, false);
    assert.equal(res.body.user.email, email);
    const rawCookies2 = res.headers["set-cookie"];
    const setCookie2: string[] = Array.isArray(rawCookies2) ? rawCookies2 : rawCookies2 ? [rawCookies2] : [];
    assert.ok(setCookie2.some((c) => c.startsWith("sid=")), "sid cookie should be set");
  });
});

describe("POST /auth/forgot-password", () => {

  function ipFor(testName: string): string {
    return `10.${(testName.length * 13) % 256}.${(testName.length * 17) % 256}.1`;
  }

  it("returns the generic 200 reply when email is missing", async () => {
    const res = await request(makeApp())
      .post("/auth/forgot-password")
      .set("CF-Connecting-IP", ipFor("missing"))
      .send({});
    assert.equal(res.status, 200);
    assert.match(res.body.message, /If an account/);
  });

  it("returns the generic 200 reply when no user matches", async () => {
    const res = await request(makeApp())
      .post("/auth/forgot-password")
      .set("CF-Connecting-IP", ipFor("none"))
      .send({ email: uniqueEmail() });
    assert.equal(res.status, 200);
  });

  it("inserts a reset token row for users with a local password", async () => {
    const { email, id } = await createUserWithPassword();
    const res = await request(makeApp())
      .post("/auth/forgot-password")
      .set("CF-Connecting-IP", ipFor("happy"))
      .send({ email });
    assert.equal(res.status, 200);
    const tokens = await db
      .select()
      .from(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.userId, id));
    assert.equal(tokens.length, 1);
    assert.ok(tokens[0].expiresAt > new Date());
  });
});

// Issue #800: an account made by Google or Apple sign-in has no password. When
// its provider does not vouch for the email, sign-in is refused and the person
// is sent to password reset (PR #798); the link must reach them, and following
// it sets their first password.
describe("POST /auth/forgot-password — an account with no password yet (#800)", () => {
  it("sends a reset link, and the link sets a first password that signs in", async () => {
    const email = uniqueEmail();
    const [user] = await db.insert(usersTable).values({ email, googleLinked: true }).returning({ id: usersTable.id });
    const app = makeApp();
    const res = await request(app).post("/auth/forgot-password").set("CF-Connecting-IP", "198.51.100.80").send({ email });
    assert.equal(res.status, 200);
    const tokens = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, user!.id));
    assert.equal(tokens.length, 1, "a passwordless account gets a reset link");
    // Replay the emailed token: issue a known one for the same account and use it.
    const raw = randomBytes(32).toString("hex");
    await db.insert(passwordResetTokensTable).values({
      userId: user!.id,
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const reset = await request(app).post("/auth/reset-password").send({ token: raw, newPassword: "first-password-1" });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const login = await request(app).post("/auth/local-login").send({ email, password: "first-password-1" });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const [after] = await db.select({ googleLinked: usersTable.googleLinked }).from(usersTable).where(eq(usersTable.id, user!.id));
    assert.equal(after!.googleLinked, true, "the provider link is kept");
  });
});

describe("POST /auth/reset-password", () => {

  it("returns 400 for missing token", async () => {
    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ newPassword: "longenough" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid or missing token" });
  });

  it("returns 400 for missing newPassword", async () => {
    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ token: "abc" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "New password is required" });
  });

  it("returns 400 for short newPassword", async () => {
    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ token: "abc", newPassword: "x" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Password must be at least 8 characters" });
  });

  it("returns 400 for too-long newPassword", async () => {
    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ token: "abc", newPassword: "x".repeat(129) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Password must be 128 characters or fewer" });
  });

  it("returns 400 for an unknown token", async () => {
    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ token: "no-such-token", newPassword: "longenough" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid or has expired/);
  });

  it("rejects an expired token", async () => {
    const { id } = await createUserWithPassword();
    const rawToken = randomUUID().replace(/-/g, "");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(passwordResetTokensTable).values({
      userId: id,
      tokenHash,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ token: rawToken, newPassword: "newpassword1" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /expired/);
  });

  it("rejects a reused token", async () => {
    const { id } = await createUserWithPassword();
    const rawToken = randomUUID().replace(/-/g, "");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(passwordResetTokensTable).values({
      userId: id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      usedAt: new Date(),
    });
    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ token: rawToken, newPassword: "newpassword1" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already been used/);
  });

  it("happy path: updates the password and marks the token used", async () => {
    const { id, email } = await createUserWithPassword({ password: "old-password" });
    const rawToken = randomUUID().replace(/-/g, "");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(passwordResetTokensTable).values({
      userId: id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    const res = await request(makeApp())
      .post("/auth/reset-password")
      .send({ token: rawToken, newPassword: "brand-new-password" });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /Password reset successfully/);

    // The new password should now log in
    const login = await request(makeApp())
      .post("/auth/local-login")
      .send({ email, password: "brand-new-password" });
    assert.equal(login.status, 200);

    // Token row marked as used
    const [t] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.tokenHash, tokenHash));
    assert.ok(t.usedAt);
  });
});

describe("GET /auth/verify-email", () => {

  it("returns 400 for missing token", async () => {
    const res = await request(makeApp()).get("/auth/verify-email");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Invalid or missing token" });
  });

  it("returns 400 for an unknown token", async () => {
    const res = await request(makeApp())
      .get("/auth/verify-email")
      .query({ token: "nope" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid or has expired/);
  });

  it("happy path: marks the user as verified", async () => {
    const { id } = await createUserWithPassword();
    const rawToken = randomUUID().replace(/-/g, "");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(emailVerificationTokensTable).values({
      userId: id,
      tokenHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });

    const res = await request(makeApp())
      .get("/auth/verify-email")
      .query({ token: rawToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.ok(row.emailVerifiedAt);
  });

  it("promotes pendingEmail to email when the token carries a pending change", async () => {
    const { id } = await createUserWithPassword();
    const newEmail = uniqueEmail();
    const rawToken = randomUUID().replace(/-/g, "");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.update(usersTable).set({ pendingEmail: newEmail }).where(eq(usersTable.id, id));
    await db.insert(emailVerificationTokensTable).values({
      userId: id,
      tokenHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      pendingEmail: newEmail,
    });

    const res = await request(makeApp())
      .get("/auth/verify-email")
      .query({ token: rawToken });
    assert.equal(res.status, 200);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.equal(row.email, newEmail);
    assert.equal(row.pendingEmail, null);
  });

  // Round 2 of PR #425's review: this promotion is a SECOND path (besides
  // PATCH /admin/users/:id) that can cross the bootstrap-admin-email
  // boundary, and it wasn't wired into the lockout guard at all. This proves
  // the wiring doesn't wrongly block the common case — an admin who is
  // independently `is_admin` confirming a normal email change — the same
  // false-rejection shape the admin.ts route-level fix closes. The
  // population-sensitive rejection path itself (target has NO other
  // admin mechanism) is exercised at the unit level in
  // adminLockout.integration.test.ts against the shared guard, which this
  // route now calls rather than duplicating.
  it("promotes pendingEmail across the bootstrap boundary when the admin is independently is_admin", async () => {
    const { id } = await createUserWithPassword({ email: BOOTSTRAP_ADMIN_EMAIL });
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, id));
    const newEmail = uniqueEmail();
    const rawToken = randomUUID().replace(/-/g, "");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.update(usersTable).set({ pendingEmail: newEmail }).where(eq(usersTable.id, id));
    await db.insert(emailVerificationTokensTable).values({
      userId: id,
      tokenHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      pendingEmail: newEmail,
    });

    const res = await request(makeApp())
      .get("/auth/verify-email")
      .query({ token: rawToken });
    assert.equal(
      res.status,
      200,
      `expected 200, got ${res.status} (body: ${JSON.stringify(res.body)})`,
    );

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.equal(row.email, newEmail);
    assert.equal(row.pendingEmail, null);
  });
});

describe("GET /auth/email-status", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/auth/email-status");
    assert.equal(res.status, 401);
  });

  it("returns the user's email and verified state", async () => {
    const { id, email } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .get("/auth/email-status")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email, email);
    assert.equal(res.body.verified, false);
  });
});

describe("POST /auth/set-password", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/auth/set-password")
      .send({ newPassword: "longenough" });
    assert.equal(res.status, 401);
  });

  it("returns 400 when newPassword is missing or invalid", async () => {
    const { id } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    let res = await request(makeApp())
      .post("/auth/set-password").set("authorization", `Bearer ${sid}`).send({});
    assert.equal(res.status, 400);
    res = await request(makeApp())
      .post("/auth/set-password").set("authorization", `Bearer ${sid}`)
      .send({ newPassword: "short" });
    assert.equal(res.status, 400);
  });

  it("requires currentPassword when the user already has one", async () => {
    const { id } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .post("/auth/set-password")
      .set("authorization", `Bearer ${sid}`)
      .send({ newPassword: "newpassword1" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Current password is required/);
  });

  it("returns 401 when currentPassword is wrong", async () => {
    const { id } = await createUserWithPassword({ password: "old" });
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .post("/auth/set-password")
      .set("authorization", `Bearer ${sid}`)
      .send({ currentPassword: "wrong", newPassword: "longenough" });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Current password is incorrect/);
  });

  it("happy path with currentPassword", async () => {
    const { id, email, password } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .post("/auth/set-password")
      .set("authorization", `Bearer ${sid}`)
      .send({ currentPassword: password, newPassword: "another-strong-pw" });
    assert.equal(res.status, 200);

    const login = await request(makeApp())
      .post("/auth/local-login")
      .send({ email, password: "another-strong-pw" });
    assert.equal(login.status, 200);
  });

  it("happy path for OAuth-only users (no current password required)", async () => {
    const id = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id,
      email: `${id}@test.local`,
      googleLinked: true,
    });
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .post("/auth/set-password")
      .set("authorization", `Bearer ${sid}`)
      .send({ newPassword: "first-time-password" });
    assert.equal(res.status, 200);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.ok(row.passwordHash);
  });
});

describe("DELETE /auth/unlink-provider", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).delete("/auth/unlink-provider");
    assert.equal(res.status, 401);
  });

  it("returns 400 when no provider is linked", async () => {
    const { id } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .delete("/auth/unlink-provider")
      .set("authorization", `Bearer ${sid}`)
      .set("content-type", "application/json")
      .send({ provider: "google" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No linked social account/);
  });

  it("returns 400 when the user has no password set (would lock them out)", async () => {
    const id = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id,
      email: `${id}@test.local`,
      googleLinked: true,
    });
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .delete("/auth/unlink-provider")
      .set("authorization", `Bearer ${sid}`)
      .set("content-type", "application/json")
      .send({ provider: "google" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must set a password/);
  });

  it("happy path: clears googleLinked and returns success message", async () => {
    const { id } = await createUserWithPassword();
    await db.update(usersTable).set({ googleLinked: true }).where(eq(usersTable.id, id));
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .delete("/auth/unlink-provider")
      .set("authorization", `Bearer ${sid}`)
      .set("content-type", "application/json")
      .send({ provider: "google" });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /Sign-in method unlinked successfully/);
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.equal(row.googleLinked, false);
  });
});

describe("POST /auth/resend-verification", () => {

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post("/auth/resend-verification").send({});
    assert.equal(res.status, 401);
  });

  it("returns the already-verified message when the user has a verified email", async () => {
    const { id } = await createUserWithPassword();
    await db.update(usersTable).set({ emailVerifiedAt: new Date() }).where(eq(usersTable.id, id));
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .post("/auth/resend-verification")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.match(res.body.message, /already verified/);
  });

  it("returns the sent message and inserts a new token for an unverified user", async () => {
    const { id } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .post("/auth/resend-verification")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    assert.match(res.body.message, /Verification email sent/);

    // sendVerificationEmail runs async — give it a moment to insert the token row.
    await new Promise((r) => setTimeout(r, 100));
    const tokens = await db
      .select()
      .from(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, id));
    assert.ok(tokens.length >= 1);
  });
});

describe("POST /auth/resend-verification { ifNoneOut: true } — the check-email screen's link (#868)", () => {
  async function liveTokens(userId: string) {
    return db
      .select()
      .from(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, userId));
  }

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post("/auth/resend-verification").send({ ifNoneOut: true });
    assert.equal(res.status, 401);
  });

  it("sends a link to an unverified account that has none — the reported case: signed in without registering", async () => {
    const { id } = await createUserWithPassword();
    assert.equal((await liveTokens(id)).length, 0);
    const sid = await bearerForUser(id);
    const res = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`).send({ ifNoneOut: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "sent");
    // Awaited, so the link's token exists when the answer lands (with no
    // email provider in tests, sendEmail logs instead of queuing).
    assert.equal((await liveTokens(id)).length, 1);
  });

  it("sends no second link while one is live — a just-registered account keeps its one", async () => {
    const { id } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    const first = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`).send({ ifNoneOut: true });
    assert.equal(first.body.status, "sent");
    const again = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`).send({ ifNoneOut: true });
    assert.equal(again.status, 200);
    assert.equal(again.body.status, "already-sent");
    assert.equal((await liveTokens(id)).length, 1);
  });

  it("sends a fresh link when the only one has expired or been used", async () => {
    const { id } = await createUserWithPassword();
    await db.insert(emailVerificationTokensTable).values([
      { userId: id, tokenHash: randomBytes(16).toString("hex"), expiresAt: new Date(Date.now() - 1000) },
      { userId: id, tokenHash: randomBytes(16).toString("hex"), expiresAt: new Date(Date.now() + 3600_000), usedAt: new Date() },
    ]);
    const sid = await bearerForUser(id);
    const res = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`).send({ ifNoneOut: true });
    assert.equal(res.body.status, "sent");
  });

  it("sends nothing to a verified account", async () => {
    const { id } = await createUserWithPassword();
    await db.update(usersTable).set({ emailVerifiedAt: new Date() }).where(eq(usersTable.id, id));
    const sid = await bearerForUser(id);
    const res = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`).send({ ifNoneOut: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "verified");
    assert.equal((await liveTokens(id)).length, 0);
  });

  it("reaches an unverified account through the full app, verified-actor gate included", async () => {
    const { id } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    const res = await request(createApp())
      .post("/api/auth/resend-verification")
      .set("authorization", `Bearer ${sid}`)
      .send({ ifNoneOut: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "sent");
  });

  it("shares resend's limit, so it cannot widen it", async () => {
    const { id } = await createUserWithPassword();
    const sid = await bearerForUser(id);
    for (let i = 0; i < 3; i++) {
      await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`);
    }
    await new Promise((r) => setTimeout(r, 100));
    await db.update(emailVerificationTokensTable).set({ usedAt: new Date() }).where(eq(emailVerificationTokensTable.userId, id));
    const res = await request(makeApp()).post("/auth/resend-verification").set("authorization", `Bearer ${sid}`).send({ ifNoneOut: true });
    assert.equal(res.status, 429);
  });
});
