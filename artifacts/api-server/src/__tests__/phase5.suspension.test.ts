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
import { asyncJobsTable, emailVerificationTokensTable, passwordResetTokensTable, sessionsTable, usersTable } from "@workspace/db/schema";
import { and, eq, like, sql } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { requireEligibleActor } from "../middlewares/requireEligibleActor.js";
import localAuthRouter from "../routes/localAuth.js";
import authRouter from "../routes/auth.js";
import usersRouter from "../routes/users.js";
import accountSuspensionRouter, { __setSuspensionNoticeSeamsForTests } from "../routes/accountSuspension.js";
import { buildAccountSuspendedEmail } from "../lib/email.js";
import adminRouter from "../routes/admin.js";
import { isReachableAdminSql } from "../lib/adminIdentity.js";
import { createSession, revokeUserSessions, type SessionData } from "../lib/auth.js";
import { suspendAccount } from "../lib/accountSuspension.js";
import { acceptCurrentLegal } from "./helpers/legalAcceptance.js";

const PREFIX = "t-p5susp-";
const PASSWORD = "correct horse battery staple";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(requireEligibleActor);
  app.use("/api", localAuthRouter, authRouter, usersRouter, accountSuspensionRouter, adminRouter);
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
  await acceptCurrentLegal(id);
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

  it("password recovery is closed while suspended: no reset link is issued, an earlier one is refused unused, and it works again after unsuspend", async () => {
    const admin = await createUser({ admin: true });
    const adminSid = await sessionFor(admin.id, { isAdmin: true });
    const member = await createUser();
    const providerOnly = await createUser();
    await db.update(usersTable).set({ passwordHash: null, googleLinked: true }).where(eq(usersTable.id, providerOnly.id));
    const app = makeApp();
    const tokensOf = async (id: string) => db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, id));
    const hashOf = async (id: string) => (await db.select({ h: usersTable.passwordHash }).from(usersTable).where(eq(usersTable.id, id)))[0]!.h;

    // A link issued before the suspension.
    const rawToken = randomUUID().replace(/-/g, "");
    await db.insert(passwordResetTokensTable).values({ userId: member.id, tokenHash: createHash("sha256").update(rawToken).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000) });
    for (const u of [member, providerOnly]) {
      assert.equal((await request(app).post(`/api/admin/users/${u.id}/suspend`).set("authorization", `Bearer ${adminSid}`).send({ reason: "x" })).status, 200);
    }

    // Asking for a link: the same reply as for any address, and nothing issued.
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: `${PREFIX}nobody@test.local` });
    for (const u of [member, providerOnly]) {
      const asked = await request(app).post("/api/auth/forgot-password").send({ email: u.email });
      assert.equal(asked.status, 200);
      assert.deepEqual(asked.body, unknown.body, "the reply tells nobody the account is suspended");
    }
    assert.equal((await tokensOf(member.id)).length, 1, "no new link for the suspended member");
    assert.equal((await tokensOf(providerOnly.id)).length, 0, "no first-password link either");

    // Using the earlier link: refused, the link unused, the password unchanged.
    const before = await hashOf(member.id);
    const reset = await request(app).post("/api/auth/reset-password").send({ token: rawToken, newPassword: "a brand new password" });
    assert.equal(reset.status, 403);
    assert.equal(reset.body.code, "ACCOUNT_SUSPENDED");
    assert.equal((await tokensOf(member.id))[0]!.usedAt, null, "the link stays unused");
    assert.equal(await hashOf(member.id), before, "the password is unchanged");

    // After unsuspend the same link works.
    assert.equal((await request(app).post(`/api/admin/users/${member.id}/unsuspend`).set("authorization", `Bearer ${adminSid}`)).status, 200);
    assert.equal((await request(app).post("/api/auth/reset-password").send({ token: rawToken, newPassword: "a brand new password" })).status, 200);
    assert.equal((await login(member.email, "a brand new password")).status, 200);
  });

  it("a sign-in and a suspension that overlap serialize: whichever commits first, no session survives the suspension", async () => {
    const sessionsOf = async (id: string) => db.select().from(sessionsTable).where(eq(sessionsTable.userId, id));
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Suspension first: it holds the row and has revoked, but not committed,
    // while a password sign-in (correct password) reaches the mint. The
    // sign-in must wait for it and then refuse.
    const member = await createUser();
    let signIn!: Promise<request.Response>;
    await db.transaction(async (tx) => {
      await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, member.id)).for("update");
      await tx.update(usersTable).set({ suspendedAt: new Date(), suspendedReason: "race" }).where(eq(usersTable.id, member.id));
      await revokeUserSessions(tx, member.id);
      signIn = login(member.email).then((r) => r);
      await pause(500);
    });
    const refused = await signIn;
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.body.code, "ACCOUNT_SUSPENDED");
    assert.equal((await sessionsOf(member.id)).length, 0, "no session minted after the suspension");

    // Sign-in first: a session is minted under the share lock and not yet
    // committed when an admin suspends. The suspension waits for it and then
    // revokes it, so the session (an admin's, here) reads nothing afterwards.
    const admin = await createUser({ admin: true });
    await createUser({ admin: true }); // so the target is never the last admin
    let suspending!: Promise<unknown>;
    let sid!: string;
    await db.transaction(async (tx) => {
      await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, admin.id)).for("share");
      sid = await createSession({ user: { id: admin.id } as unknown as SessionData["user"], access_token: "t", isAdmin: true }, admin.id, tx);
      suspending = suspendAccount(admin.id, { by: null, reason: "race" });
      await pause(500);
    });
    assert.equal(((await suspending) as { outcome: string }).outcome, "suspended");
    assert.equal((await sessionsOf(admin.id)).length, 0, "the suspension revoked the session minted before it");
    const adminList = await request(makeApp()).get("/api/admin/users").set("authorization", `Bearer ${sid}`);
    assert.equal(adminList.status, 401, "the revoked session reads nothing, the admin console included");
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

// Issue #1110 (Q7): each real transition queues one notice to the member,
// after the change commits; the admin's note to the member is in it and the
// internal reason never is. Run with RESEND_API_KEY set (the test runner sets
// a re_test_ key); the route opts in to the outbox insert under it.
describe("suspension notices (Issue #1110)", () => {
  type Job = { to: string; kind: string | null; subject: string; text: string; html: string | null };
  async function noticesTo(email: string): Promise<Job[]> {
    const rows = await db.select({ payload: asyncJobsTable.payload }).from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "email"), sql`${asyncJobsTable.payload}->>'to' = ${email}`));
    return rows.map((r) => r.payload as unknown as Job);
  }
  async function clearNotices(): Promise<void> {
    await db.delete(asyncJobsTable).where(and(eq(asyncJobsTable.queue, "email"), sql`${asyncJobsTable.payload}->>'to' like ${PREFIX + "%"}`));
  }
  const suspend = (sid: string, id: string, body: Record<string, unknown>) =>
    request(makeApp()).post(`/api/admin/users/${id}/suspend`).set("authorization", `Bearer ${sid}`).send(body);
  const unsuspend = (sid: string, id: string) =>
    request(makeApp()).post(`/api/admin/users/${id}/unsuspend`).set("authorization", `Bearer ${sid}`);

  before(async () => { await cleanup(); await clearNotices(); __setSuspensionNoticeSeamsForTests({ deliveryAvailable: () => true }); });
  after(async () => { __setSuspensionNoticeSeamsForTests({ deliveryAvailable: null, send: null }); await clearNotices(); await cleanup(); });

  it("a suspension with a note queues one email carrying the note and what suspension means, never the internal reason", async () => {
    const admin = await createUser({ admin: true });
    const sid = await sessionFor(admin.id, { isAdmin: true });
    const member = await createUser();
    const res = await suspend(sid, member.id, { reason: "INTERNAL-REASON-fraud-ring", memberNote: "Your posts broke the spam rules." });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.notice, { status: "queued" });
    const jobs = await noticesTo(member.email);
    assert.equal(jobs.length, 1);
    const [job] = jobs;
    assert.equal(job!.kind, "account_suspended");
    assert.equal(job!.subject, "Your Overhype.me account is suspended");
    for (const body of [job!.text, job!.html ?? ""]) {
      assert.match(body, /Your posts broke the spam rules\./, "the note to the member is in the email");
      assert.match(body, /can(&#39;|')t sign in/, "it says what suspension means");
      assert.match(body, /recurring charges continue/);
      assert.match(body, /support@overhype\.me/);
      assert.ok(!body.includes("INTERNAL-REASON"), "the internal reason never reaches the member");
    }
    assert.ok(!JSON.stringify(res.body).includes("INTERNAL-REASON"));
  });

  it("without a note, the email has no note block", async () => {
    const admin = await createUser({ admin: true });
    const sid = await sessionFor(admin.id, { isAdmin: true });
    const member = await createUser();
    assert.equal((await suspend(sid, member.id, { reason: "x", memberNote: "   " })).status, 200);
    const [job] = await noticesTo(member.email);
    assert.ok(job);
    assert.ok(!job.text.includes("A note from the team"));
    assert.ok(!(job.html ?? "").includes("A note from the team"));
  });

  it("only a real transition sends: a repeat or a concurrent pair queues one; unsuspend queues one reinstated email; a later suspension queues another", async () => {
    const admin = await createUser({ admin: true });
    const sid = await sessionFor(admin.id, { isAdmin: true });
    const member = await createUser();
    const [a, b] = await Promise.all([suspend(sid, member.id, { reason: "x" }), suspend(sid, member.id, { reason: "y" })]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal([a.body.notice.status, b.body.notice.status].sort().join(","), "not_owed,queued");
    const repeat = await suspend(sid, member.id, { reason: "z" });
    assert.equal(repeat.body.alreadySuspended, true);
    assert.deepEqual(repeat.body.notice, { status: "not_owed" });
    assert.equal((await noticesTo(member.email)).filter((j) => j.kind === "account_suspended").length, 1);

    const lifted = await unsuspend(sid, member.id);
    assert.deepEqual(lifted.body.notice, { status: "queued" });
    const again = await unsuspend(sid, member.id);
    assert.equal(again.body.wasSuspended, false);
    assert.deepEqual(again.body.notice, { status: "not_owed" });
    const reinstated = (await noticesTo(member.email)).filter((j) => j.kind === "account_reinstated");
    assert.equal(reinstated.length, 1);
    assert.equal(reinstated[0]!.subject, "Your Overhype.me account is active again");
    assert.match(reinstated[0]!.text, /You can sign in again/);

    assert.deepEqual((await suspend(sid, member.id, { reason: "again" })).body.notice, { status: "queued" });
    assert.equal((await noticesTo(member.email)).filter((j) => j.kind === "account_suspended").length, 2);
  });

  it("when nothing can be queued, both changes still stand and the admin is told why", async () => {
    const admin = await createUser({ admin: true });
    const sid = await sessionFor(admin.id, { isAdmin: true });

    // No email transport.
    const m1 = await createUser();
    await sessionFor(m1.id);
    __setSuspensionNoticeSeamsForTests({ deliveryAvailable: () => false });
    try {
      const s1 = await suspend(sid, m1.id, { reason: "x" });
      assert.deepEqual(s1.body.notice, { status: "not_queued", why: "email_unavailable" });
      const [row] = await db.select().from(usersTable).where(eq(usersTable.id, m1.id));
      assert.ok(row!.suspendedAt, "suspended regardless");
      assert.equal((await db.select().from(sessionsTable).where(eq(sessionsTable.userId, m1.id))).length, 0, "sessions ended regardless");
      const u1 = await unsuspend(sid, m1.id);
      assert.deepEqual(u1.body.notice, { status: "not_queued", why: "email_unavailable" });
      assert.equal(u1.body.wasSuspended, true);
    } finally {
      __setSuspensionNoticeSeamsForTests({ deliveryAvailable: () => true });
    }
    assert.equal((await noticesTo(m1.email)).length, 0);

    // The insert fails.
    const m2 = await createUser();
    await sessionFor(m2.id);
    __setSuspensionNoticeSeamsForTests({ send: async () => { throw new Error("outbox down"); } });
    try {
      const s2 = await suspend(sid, m2.id, { reason: "x" });
      assert.equal(s2.status, 200);
      assert.deepEqual(s2.body.notice, { status: "not_queued", why: "failed" });
      assert.equal((await db.select().from(sessionsTable).where(eq(sessionsTable.userId, m2.id))).length, 0);
      const u2 = await unsuspend(sid, m2.id);
      assert.equal(u2.status, 200);
      assert.deepEqual(u2.body.notice, { status: "not_queued", why: "failed" });
      const [row] = await db.select().from(usersTable).where(eq(usersTable.id, m2.id));
      assert.equal(row!.suspendedAt, null, "unsuspended regardless");
    } finally {
      __setSuspensionNoticeSeamsForTests({ send: null });
    }

    // No address on the account.
    const m3 = await createUser();
    await db.update(usersTable).set({ email: null }).where(eq(usersTable.id, m3.id));
    assert.deepEqual((await suspend(sid, m3.id, { reason: "x" })).body.notice, { status: "not_queued", why: "no_address" });
    assert.deepEqual((await unsuspend(sid, m3.id)).body.notice, { status: "not_queued", why: "no_address" });
  });

  it("refuses a note over 1,000 characters and changes nothing", async () => {
    const admin = await createUser({ admin: true });
    const sid = await sessionFor(admin.id, { isAdmin: true });
    const member = await createUser();
    const res = await suspend(sid, member.id, { reason: "x", memberNote: "a".repeat(1001) });
    assert.equal(res.status, 400);
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, member.id));
    assert.equal(row!.suspendedAt, null);
    assert.equal((await noticesTo(member.email)).length, 0);
  });

  it("the note is escaped in the email's HTML", () => {
    const { html, text } = buildAccountSuspendedEmail("https://example.test", { memberNote: "<script>alert(1)</script>" });
    assert.ok(!(html ?? "").includes("<script>"));
    assert.ok((html ?? "").includes("&lt;script&gt;"));
    assert.ok(text.includes("<script>alert(1)</script>"), "plain text carries it as written");
  });
});
