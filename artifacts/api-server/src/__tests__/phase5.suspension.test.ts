/**
 * @purpose T10, account suspension (launch Phase 5, plan *Suspension*, S19): an admin suspends with a reason (never themselves), every session ends at once; a suspended account is refused at password sign-in and the verification link with ACCOUNT_SUSPENDED, and a session it still holds can write nothing but sign out; unsuspending restores all of it; a legacy deactivated account is moved to suspension by 0120 and unsuspends cleanly; a suspended administrator no longer counts as one who can reach the console.
 * @subsystem accounts-auth
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import request from "supertest";
import bcrypt from "bcryptjs";

import { db } from "@workspace/db";
import { emailVerificationTokensTable, sessionsTable, usersTable } from "@workspace/db/schema";
import { and, eq, like, sql } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { requireEligibleActor } from "../middlewares/requireEligibleActor.js";
import localAuthRouter from "../routes/localAuth.js";
import authRouter from "../routes/auth.js";
import usersRouter from "../routes/users.js";
import accountSuspensionRouter from "../routes/accountSuspension.js";
import { isReachableAdminSql } from "../lib/adminIdentity.js";
import { createSession, type SessionData } from "../lib/auth.js";

const PREFIX = "t-p5susp-";
const PASSWORD = "correct horse battery staple";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(requireEligibleActor);
  app.use("/api", localAuthRouter, authRouter, usersRouter, accountSuspensionRouter);
  return app;
}

async function createUser(opts: { admin?: boolean; verified?: boolean } = {}): Promise<{ id: string; email: string }> {
  const id = `${PREFIX}${randomUUID()}`;
  const email = `${id}@test.local`;
  await db.insert(usersTable).values({
    id, email, displayName: "Member", pronouns: "they/them",
    emailVerifiedAt: opts.verified === false ? null : new Date(), onboardingCompletedAt: new Date(), dateOfBirth: "1990-01-01",
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    isAdmin: opts.admin ?? false,
  });
  return { id, email };
}

async function sessionFor(userId: string, opts: { isAdmin?: boolean } = {}): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t", isAdmin: opts.isAdmin };
  return createSession(data, userId);
}

const login = (email: string, password = PASSWORD) => request(makeApp()).post("/api/auth/local-login").send({ email, password });

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

describe("account suspension (T10)", () => {
  before(cleanup);
  after(cleanup);

  it("an admin suspends with a reason; every session ends; sign-in and the verification link are refused; unsuspending restores them", async () => {
    const admin = await createUser({ admin: true });
    const adminSid = await sessionFor(admin.id, { isAdmin: true });
    const member = await createUser();
    await sessionFor(member.id);
    await sessionFor(member.id);

    assert.equal((await request(makeApp()).post(`/api/admin/users/${member.id}/suspend`).set("authorization", `Bearer ${adminSid}`).send({})).status, 400, "a reason is required");
    const memberSid = await sessionFor(member.id);
    assert.equal((await request(makeApp()).post(`/api/admin/users/${member.id}/suspend`).set("authorization", `Bearer ${memberSid}`).send({ reason: "x" })).status, 403, "a member cannot suspend");
    assert.equal((await request(makeApp()).post(`/api/admin/users/${admin.id}/suspend`).set("authorization", `Bearer ${adminSid}`).send({ reason: "x" })).status, 409, "never yourself");

    const res = await request(makeApp()).post(`/api/admin/users/${member.id}/suspend`).set("authorization", `Bearer ${adminSid}`).send({ reason: "spam comments" });
    assert.equal(res.status, 200, res.text);
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, member.id));
    assert.ok(row!.suspendedAt);
    assert.equal(row!.suspendedReason, "spam comments");
    assert.equal(row!.suspendedBy, admin.id);
    assert.equal(row!.isActive, true, "suspension never writes is_active");
    assert.equal((await db.select().from(sessionsTable).where(eq(sessionsTable.userId, member.id))).length, 0, "every session ended");

    // Password sign-in: refused before a session exists; a wrong password learns nothing.
    assert.equal((await login(member.email, "wrong")).status, 401);
    const refused = await login(member.email);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "ACCOUNT_SUSPENDED");
    assert.ok(!JSON.stringify(refused.body).includes("spam"), "the reason is never shown to the person");
    assert.equal((await db.select().from(sessionsTable).where(eq(sessionsTable.userId, member.id))).length, 0);

    // The verification link verifies nothing and signs nobody in.
    const rawToken = randomUUID().replace(/-/g, "");
    await db.insert(emailVerificationTokensTable).values({ userId: member.id, tokenHash: createHash("sha256").update(rawToken).digest("hex"), expiresAt: new Date(Date.now() + 86_400_000) });
    const link = await request(makeApp()).get("/api/auth/verify-email").query({ token: rawToken });
    assert.equal(link.status, 403);
    assert.equal(link.body.code, "ACCOUNT_SUSPENDED");

    // A session it still holds can write nothing but sign out.
    const held = await sessionFor(member.id);
    const write = await request(makeApp()).post("/api/users/me/search-history").set("authorization", `Bearer ${held}`).send({ query: "x" });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, "ACCOUNT_SUSPENDED");
    assert.notEqual((await request(makeApp()).post("/api/auth/logout").set("authorization", `Bearer ${held}`)).status, 403, "signing out still works");

    // Unsuspending restores sign-in and writes.
    assert.equal((await request(makeApp()).post(`/api/admin/users/${member.id}/unsuspend`).set("authorization", `Bearer ${adminSid}`)).status, 200);
    const [lifted] = await db.select().from(usersTable).where(eq(usersTable.id, member.id));
    assert.equal(lifted!.suspendedAt, null);
    assert.equal(lifted!.suspendedReason, null);
    assert.equal((await login(member.email)).status, 200, "sign-in works again");
    const again = await sessionFor(member.id);
    assert.notEqual((await request(makeApp()).post("/api/users/me/search-history").set("authorization", `Bearer ${again}`).send({ query: "y" })).status, 403);
  });

  it("a suspended administrator no longer counts as one who can reach the console", async () => {
    const admin = await createUser({ admin: true });
    const other = await createUser({ admin: true });
    const otherSid = await sessionFor(other.id, { isAdmin: true });
    const reachable = async () => (await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, admin.id), isReachableAdminSql()))).length;
    assert.equal(await reachable(), 1);
    assert.equal((await request(makeApp()).post(`/api/admin/users/${admin.id}/suspend`).set("authorization", `Bearer ${otherSid}`).send({ reason: "compromised" })).status, 200);
    assert.equal(await reachable(), 0);
  });

  it("0120 moves a legacy deactivated account to suspension, idempotently, and it unsuspends cleanly", async () => {
    const legacy = await createUser();
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, legacy.id));
    const migration = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../lib/db/migrations/0120_account_suspension.sql"),
      "utf8",
    );
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration));
    const [moved] = await db.select().from(usersTable).where(eq(usersTable.id, legacy.id));
    assert.ok(moved!.suspendedAt, "suspended");
    assert.equal(moved!.suspendedReason, "legacy deactivation");
    assert.equal(moved!.isActive, true, "is_active is back to its one meaning");
    assert.equal((await login(legacy.email)).body.code, "ACCOUNT_SUSPENDED");

    const admin = await createUser({ admin: true });
    const adminSid = await sessionFor(admin.id, { isAdmin: true });
    assert.equal((await request(makeApp()).post(`/api/admin/users/${legacy.id}/unsuspend`).set("authorization", `Bearer ${adminSid}`)).status, 200);
    assert.equal((await login(legacy.email)).status, 200);
  });
});
