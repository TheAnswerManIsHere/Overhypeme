/**
 * @purpose Increment 5b of the account deletion work (launch Phase 5, plan S14; David's answer 6): a self-registration still not onboarded 30 days after it was created is scheduled for deletion through the one engine — and an account from before the onboarding flow, an onboarded one, a younger one, or one that kept itself once is never selected — with the selection re-checked on the locked row; the admin deletion panel lists every request in progress, stuck purges first, and every kept account whose billing clean-up is unfinished; an admin can keep an account on its owner's behalf; the scheduled email names what is hidden.
 * @subsystem security
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { accountDeletionRequestsTable, usersTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { requireEligibleActor } from "../middlewares/requireEligibleActor.js";
import accountDeletionRouter from "../routes/accountDeletion.js";
import usersRouter from "../routes/users.js";
import { acceptAccountDeletion, NEVER_ONBOARDED_AFTER_DAYS, runAccountDeletionWorker } from "../lib/accountDeletion.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { buildAccountDeletionScheduledEmail, buildUnfinishedAccountDeletionEmail } from "../lib/email.js";

const PREFIX = "t-p5del5b-";
const DAY = 86_400_000;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(requireEligibleActor);
  app.use("/api", accountDeletionRouter, usersRouter);
  return app;
}

async function createUser(opts: { registered?: boolean | null; onboarded?: boolean; ageDays?: number; admin?: boolean } = {}): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, displayName: "Starter",
    emailVerifiedAt: new Date(),
    onboardingCompletedAt: opts.onboarded ? new Date() : null,
    dateOfBirth: opts.onboarded ? "1990-01-01" : null,
    registeredUnderOnboarding: opts.registered === undefined ? true : opts.registered,
    createdAt: new Date(Date.now() - (opts.ageDays ?? 0) * DAY),
    isAdmin: opts.admin ?? false,
  });
  return id;
}

async function sessionFor(userId: string, opts: { isAdmin?: boolean } = {}): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t", isAdmin: opts.isAdmin };
  return createSession(data, userId);
}

async function requestOf(userId: string) {
  const [row] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
  return row ?? null;
}

async function cleanup(): Promise<void> {
  await db.delete(accountDeletionRequestsTable).where(like(accountDeletionRequestsTable.userId, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

describe("account deletion, increment 5b", () => {
  before(cleanup);
  after(cleanup);

  it("a sign-up left unfinished for 30 days is scheduled for deletion; younger, older-flow, onboarded and once-kept accounts are not", async () => {
    const due = await createUser({ ageDays: NEVER_ONBOARDED_AFTER_DAYS + 1 });
    const young = await createUser({ ageDays: NEVER_ONBOARDED_AFTER_DAYS - 1 });
    const legacy = await createUser({ registered: null, ageDays: 400 });
    const adminMade = await createUser({ registered: null, ageDays: 60 });
    const onboarded = await createUser({ onboarded: true, ageDays: 60 });
    const keptOnce = await createUser({ ageDays: 60 });
    await acceptAccountDeletion(keptOnce, { requestedBy: "self", kick: false });
    await db.update(accountDeletionRequestsTable).set({ cancelledAt: new Date() }).where(eq(accountDeletionRequestsTable.userId, keptOnce));
    const all = [due, young, legacy, adminMade, onboarded, keptOnce];

    const counts = await runAccountDeletionWorker({ userIds: all });
    assert.equal(counts.opened, 1, JSON.stringify(counts));
    const opened = await requestOf(due);
    assert.equal(opened?.requestedBy, "unonboarded");
    assert.equal(opened?.stage, "notified", "the same run emails it and waits out the window");
    const days = (opened!.purgeAfter.getTime() - Date.now()) / DAY;
    assert.ok(days > 13.9 && days <= 14, "the ordinary 14-day window");
    for (const id of [young, legacy, adminMade, onboarded]) assert.equal(await requestOf(id), null, `${id} is not selected`);
    assert.ok((await requestOf(keptOnce))?.cancelledAt, "an account that kept itself once is not scheduled again");

    assert.equal((await runAccountDeletionWorker({ userIds: all })).opened, 0, "a second run schedules nothing new");

    // Keeping it sends the person back to finish setting up.
    const sid = await sessionFor(due);
    assert.equal((await request(makeApp()).post("/api/users/me/deletion/cancel").set("authorization", `Bearer ${sid}`)).status, 200);
    const write = await request(makeApp()).post("/api/users/me/search-history").set("authorization", `Bearer ${sid}`).send({ query: "x" });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, "ONBOARDING_REQUIRED");
    assert.equal((await runAccountDeletionWorker({ userIds: [due] })).opened, 0, "and it is not scheduled again");
  });

  it("the selection is re-checked on the locked row: an account onboarded since it was read is left alone", async () => {
    const id = await createUser({ onboarded: true, ageDays: 60 });
    const outcome = await acceptAccountDeletion(id, { requestedBy: "unonboarded", kick: false });
    assert.equal(outcome.status, "not_found");
    assert.equal(await requestOf(id), null, "nothing written");
    const sessions = await sessionFor(id);
    const status = await request(makeApp()).get("/api/users/me/deletion").set("authorization", `Bearer ${sessions}`);
    assert.equal(status.body.pending, false, "and the account was not signed out or confined");
  });

  it("the admin panel lists requests in progress, stuck ones first, and kept accounts whose billing clean-up is unfinished", async () => {
    const admin = await createUser({ onboarded: true, admin: true });
    const adminSid = await sessionFor(admin, { isAdmin: true });
    const pending = await createUser({ onboarded: true });
    const stuck = await createUser({ onboarded: true });
    const unsettled = await createUser({ onboarded: true });
    const settled = await createUser({ onboarded: true });
    for (const id of [pending, stuck, unsettled, settled]) await acceptAccountDeletion(id, { requestedBy: "self", kick: false });
    await db.update(accountDeletionRequestsTable).set({ stage: "purging", lastError: "storage refused", attempts: 3, purgeAfter: new Date(Date.now() - DAY) })
      .where(eq(accountDeletionRequestsTable.userId, stuck));
    await db.update(accountDeletionRequestsTable).set({ cancelledAt: new Date(), billingUnsettled: true }).where(eq(accountDeletionRequestsTable.userId, unsettled));
    await db.update(accountDeletionRequestsTable).set({ cancelledAt: new Date() }).where(eq(accountDeletionRequestsTable.userId, settled));

    const memberSid = await sessionFor(await createUser({ onboarded: true }));
    assert.equal((await request(makeApp()).get("/api/admin/account-deletions").set("authorization", `Bearer ${memberSid}`)).status, 403);

    const res = await request(makeApp()).get("/api/admin/account-deletions").set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200, res.text);
    type Row = { userId: string; stage: string; lastError: string | null; attempts: number; requestedBy: string; email: string; keptWithBillingUnsettled: boolean };
    const mine = (res.body.requests as Row[]).filter((r) => r.userId.startsWith(PREFIX));
    assert.equal(mine[0]!.userId, stuck, "a request with an error comes first");
    assert.equal(mine[0]!.lastError, "storage refused");
    assert.equal(mine[0]!.attempts, 3);
    const ids = new Set(mine.map((r) => r.userId));
    assert.ok(ids.has(pending) && ids.has(unsettled), "pending and kept-unsettled are listed");
    assert.ok(!ids.has(settled), "a kept account with nothing left to do is not");
    assert.equal(mine.find((r) => r.userId === unsettled)!.keptWithBillingUnsettled, true);
    assert.equal(mine.find((r) => r.userId === pending)!.keptWithBillingUnsettled, false);
    assert.equal(mine.find((r) => r.userId === pending)!.email, `${pending}@test.local`);
  });

  it("an admin can keep an account on its owner's behalf, not once its purge has begun", async () => {
    const admin = await createUser({ onboarded: true, admin: true });
    const adminSid = await sessionFor(admin, { isAdmin: true });
    const target = await createUser({ onboarded: true });
    await acceptAccountDeletion(target, { requestedBy: "self", kick: false });

    const kept = await request(makeApp()).post(`/api/admin/users/${target}/deletion/cancel`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(kept.status, 200, kept.text);
    assert.ok((await requestOf(target))?.cancelledAt);
    assert.equal((await request(makeApp()).post(`/api/admin/users/${target}/deletion/cancel`).set("authorization", `Bearer ${adminSid}`)).status, 404, "nothing pending now");

    const purging = await createUser({ onboarded: true });
    await acceptAccountDeletion(purging, { requestedBy: "self", kick: false });
    await db.update(accountDeletionRequestsTable).set({ stage: "purging" }).where(eq(accountDeletionRequestsTable.userId, purging));
    const late = await request(makeApp()).post(`/api/admin/users/${purging}/deletion/cancel`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "DELETION_IN_PROGRESS");
  });

  it("the emails say what is hidden, and an unfinished sign-up is told why it is going", () => {
    const scheduled = buildAccountDeletionScheduledEmail(new Date(Date.now() + 14 * DAY), "https://example.test/account/deletion");
    assert.ok(!scheduled.text.includes("your content is hidden"));
    assert.ok(scheduled.text.includes("memes, photos and images are hidden"));
    const unfinished = buildUnfinishedAccountDeletionEmail(new Date(Date.now() + 14 * DAY), "https://example.test/account/deletion");
    assert.ok(unfinished.text.includes("never finished setting it up"));
    assert.match(unfinished.text, /^https:\/\/example\.test\/account\/deletion$/m, "the keep link stands on its own line");
    assert.ok(unfinished.html?.includes("Keep My Account"));
  });
});
