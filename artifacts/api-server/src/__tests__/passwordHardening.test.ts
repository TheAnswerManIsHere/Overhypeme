/**
 * Password hardening (launch Phase 5, increment 2, #795): a reset token is
 * consumed atomically, and every password change ends the user's other
 * sessions in the same transaction as the write.
 *
 * @purpose Proves one reset token yields exactly one password change under concurrency, that the reset ends every session while set-password keeps only the caller's, that the admin password route ends them all, and that a refused reset changes nothing.
 * @subsystem accounts-auth
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";

import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import bcrypt from "bcryptjs";

import { db } from "@workspace/db";
import { usersTable, sessionsTable, passwordResetTokensTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import localAuthRouter from "../routes/localAuth.js";
import adminRouter from "../routes/admin.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { providerEmailVerified } from "../routes/auth.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "t_pwhard_";
const API_KEY = "test-admin-key-pwhard-only";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(localAuthRouter);
  return app;
}

async function createUser(password = "old-password-1"): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, passwordHash: await bcrypt.hash(password, 4) });
  return id;
}

async function sessionFor(userId: string): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t" };
  return createSession(data, userId);
}

async function sessionsOf(userId: string): Promise<string[]> {
  return (await db.select({ sid: sessionsTable.sid }).from(sessionsTable).where(eq(sessionsTable.userId, userId))).map((r) => r.sid);
}

async function issueResetToken(userId: string, expiresInMs = 60 * 60 * 1000): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  await db.insert(passwordResetTokensTable).values({
    userId,
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    expiresAt: new Date(Date.now() + expiresInMs),
  });
  return raw;
}

async function hashOf(userId: string): Promise<string | null> {
  const [u] = await db.select({ h: usersTable.passwordHash }).from(usersTable).where(eq(usersTable.id, userId));
  return u?.h ?? null;
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("POST /auth/reset-password — one token, one change", () => {
  it("two concurrent requests with the same token: exactly one succeeds", async () => {
    const userId = await createUser();
    const token = await issueResetToken(userId);
    const app = makeApp();
    const [a, b] = await Promise.all([
      request(app).post("/auth/reset-password").send({ token, newPassword: "first-new-pass" }),
      request(app).post("/auth/reset-password").send({ token, newPassword: "second-new-pass" }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 400], `got ${a.status} and ${b.status}`);
    const winner = a.status === 200 ? "first-new-pass" : "second-new-pass";
    const loser = a.status === 200 ? "second-new-pass" : "first-new-pass";
    const hash = (await hashOf(userId))!;
    assert.equal(await bcrypt.compare(winner, hash), true, "the winner's password is the one stored");
    assert.equal(await bcrypt.compare(loser, hash), false);
    const refused = a.status === 400 ? a : b;
    assert.match(refused.body.error, /already been used/);
  });

  it("a successful reset ends every session of the user", async () => {
    const userId = await createUser();
    await sessionFor(userId);
    await sessionFor(userId);
    const token = await issueResetToken(userId);
    const res = await request(makeApp()).post("/auth/reset-password").send({ token, newPassword: "brand-new-pass" });
    assert.equal(res.status, 200);
    assert.deepEqual(await sessionsOf(userId), []);
  });

  it("an expired or unknown token changes nothing: no hash, no sessions ended", async () => {
    const userId = await createUser();
    const sid = await sessionFor(userId);
    const before = await hashOf(userId);
    const expired = await issueResetToken(userId, -1000);
    const r1 = await request(makeApp()).post("/auth/reset-password").send({ token: expired, newPassword: "never-stored" });
    assert.equal(r1.status, 400);
    assert.match(r1.body.error, /expired/);
    const r2 = await request(makeApp()).post("/auth/reset-password").send({ token: "not-a-token", newPassword: "never-stored" });
    assert.equal(r2.status, 400);
    assert.match(r2.body.error, /invalid/);
    assert.equal(await hashOf(userId), before);
    assert.deepEqual(await sessionsOf(userId), [sid]);
  });
});

describe("POST /auth/set-password — ends the other sessions, keeps the caller's", () => {
  it("keeps the session that made the change and ends every other", async () => {
    const userId = await createUser("current-pass-1");
    const mine = await sessionFor(userId);
    await sessionFor(userId);
    await sessionFor(userId);
    const res = await request(makeApp())
      .post("/auth/set-password")
      .set("authorization", `Bearer ${mine}`)
      .send({ currentPassword: "current-pass-1", newPassword: "next-pass-22" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await sessionsOf(userId), [mine]);
    assert.equal(await bcrypt.compare("next-pass-22", (await hashOf(userId))!), true);
  });

  it("a wrong current password ends nothing", async () => {
    const userId = await createUser("current-pass-1");
    const mine = await sessionFor(userId);
    const other = await sessionFor(userId);
    const res = await request(makeApp())
      .post("/auth/set-password")
      .set("authorization", `Bearer ${mine}`)
      .send({ currentPassword: "wrong", newPassword: "next-pass-22" });
    assert.equal(res.status, 401);
    assert.deepEqual((await sessionsOf(userId)).sort(), [mine, other].sort());
  });
});

describe("POST /admin/users/set-password — ends every session of the user", () => {
  const saved = process.env.ADMIN_API_KEY;
  before(() => { process.env.ADMIN_API_KEY = API_KEY; });
  after(() => { if (saved === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = saved; });

  it("an operator-set password signs the user out everywhere", async () => {
    const userId = await createUser();
    await sessionFor(userId);
    await sessionFor(userId);
    const app = buildTestApp({ kind: "unauthenticated" }, adminRouter);
    const res = await request(app)
      .post("/api/admin/users/set-password")
      .set("x-api-key", API_KEY)
      .send({ email: `${userId}@test.local`, password: "operator-set-1" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await sessionsOf(userId), []);
  });
});

describe("providerEmailVerified — the two providers' claim shapes", () => {
  it("accepts Google's boolean and Apple's string, nothing else", () => {
    assert.equal(providerEmailVerified({ email_verified: true }), true);
    assert.equal(providerEmailVerified({ email_verified: "true" }), true);
    for (const v of [false, "false", "TRUE", 1, null, undefined]) {
      assert.equal(providerEmailVerified({ email_verified: v }), false, String(v));
    }
    assert.equal(providerEmailVerified({}), false);
  });
});
