/**
 * Integration tests for routes/localAuth.ts.
 *
 * Covers email/password registration, login, password reset,
 * email-verification, set-password, and unlink-provider.
 *
 * The forgot-password and resend-verification rate limiters are DB-backed
 * (rate_limit_counters). Forgot-password tests vary the X-Forwarded-For
 * header so each gets its own bucket. The before() hook clears any stale
 * rate-limit rows so back-to-back validation runs start from a clean state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

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
} from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";

import localAuthRouter from "../routes/localAuth.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_routes_la_";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

function makeApp(): Express {
  const app = express();
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
  oauthProvider?: string | null;
} = {}): Promise<{ id: string; email: string; password: string }> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  const password = opts.password ?? "supersecret123";
  const email = opts.email ?? `${id}@test.local`;
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(usersTable).values({
    id,
    email,
    passwordHash,
    oauthProvider: opts.oauthProvider ?? null,
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
  await cleanupUsers();
});
after(async () => {
  await cleanupRateLimitCounters();
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
      .send({ email: uniqueEmail(), password: "longenough", displayName: "  " });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Display name is required" });
  });

  it("rejects displayName longer than 100 characters", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "x".repeat(101) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Display name must be 100 characters or fewer" });
  });

  it("rejects an email that's already in use", async () => {
    const { email } = await createUserWithPassword();
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email, password: "longenough", displayName: "Pat", firstName: "f", lastName: "l" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "Email is already in use" });
  });

  it("requires firstName", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "Pat", lastName: "l" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "First Name is required." });
  });

  it("requires lastName", async () => {
    const res = await request(makeApp())
      .post("/auth/register")
      .send({ email: uniqueEmail(), password: "longenough", displayName: "Pat", firstName: "f" });
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
        displayName: "Pat",
        firstName: "Pat",
        lastName: "Doe",
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
    assert.equal(row.displayName, "Pat");
    assert.equal(row.firstName, "Pat");
    assert.equal(row.lastName, "Doe");
    assert.equal(row.pronouns, "they/them");
    assert.ok(row.passwordHash, "passwordHash should be set");
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
    await db.insert(usersTable).values({ id, email, oauthProvider: "google" });
    const res = await request(makeApp())
      .post("/auth/local-login")
      .send({ email, password: "doesnt-matter" });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Google sign-in/);
  });

  it("returns 401 with an Apple-specific message for Apple-only accounts", async () => {
    const id = `${USER_PREFIX}${randomUUID()}`;
    const email = `${id}@test.local`;
    await db.insert(usersTable).values({ id, email, oauthProvider: "apple" });
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
      .set("X-Forwarded-For", ipFor("missing"))
      .send({});
    assert.equal(res.status, 200);
    assert.match(res.body.message, /If an account/);
  });

  it("returns the generic 200 reply when no user matches", async () => {
    const res = await request(makeApp())
      .post("/auth/forgot-password")
      .set("X-Forwarded-For", ipFor("none"))
      .send({ email: uniqueEmail() });
    assert.equal(res.status, 200);
  });

  it("inserts a reset token row for users with a local password", async () => {
    const { email, id } = await createUserWithPassword();
    const res = await request(makeApp())
      .post("/auth/forgot-password")
      .set("X-Forwarded-For", ipFor("happy"))
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
      oauthProvider: "google",
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
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No linked social account/);
  });

  it("returns 400 when the user has no password set (would lock them out)", async () => {
    const id = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id,
      email: `${id}@test.local`,
      oauthProvider: "google",
    });
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .delete("/auth/unlink-provider")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must set a password/);
  });

  it("happy path: clears oauthProvider", async () => {
    const { id } = await createUserWithPassword();
    await db.update(usersTable).set({ oauthProvider: "google" }).where(eq(usersTable.id, id));
    const sid = await bearerForUser(id);
    const res = await request(makeApp())
      .delete("/auth/unlink-provider")
      .set("authorization", `Bearer ${sid}`);
    assert.equal(res.status, 200);
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.equal(row.oauthProvider, null);
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
