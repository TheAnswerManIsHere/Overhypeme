/**
 * @purpose Launch Phase 7, increment 1 (plan PLAN_PHASE7_IMAGE_OFFERING.md §1): an account's credits are an append-only ledger whose balance is the sum of its rows; the first verification grants one free credit, once, by every route; an admin adjusts with a note, a debit draws on the oldest lots and never overdraws, and a retried adjustment changes nothing.
 * @subsystem membership
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { creditLedgerTable, usersTable } from "@workspace/db/schema";
import { asc, eq, like } from "drizzle-orm";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { requireEligibleActor } from "../middlewares/requireEligibleActor.js";
import adminRouter from "../routes/admin.js";
import adminCreditsRouter from "../routes/adminCredits.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { applyAdminAdjustment, creditBalance, creditEntries } from "../lib/credits/ledger.js";
import { acceptCurrentLegal } from "./helpers/legalAcceptance.js";

const PREFIX = "t-p7cred-";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(requireEligibleActor);
  app.use("/api", adminRouter, adminCreditsRouter);
  return app;
}

async function createUser(opts: { admin?: boolean; verified?: boolean } = {}): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, displayName: opts.admin ? "Admin Tester" : "Member", pronouns: "they/them",
    emailVerifiedAt: opts.verified === false ? null : new Date(), onboardingCompletedAt: new Date(), dateOfBirth: "1990-01-01",
    isAdmin: opts.admin ?? false,
  });
  await acceptCurrentLegal(id);
  return id;
}

async function sessionFor(userId: string, isAdmin = false): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t", isAdmin };
  return createSession(data, userId);
}

const rowsOf = (userId: string) =>
  db.select().from(creditLedgerTable).where(eq(creditLedgerTable.userId, userId)).orderBy(asc(creditLedgerTable.id));

const admin = { id: "", label: "Admin Tester" };

/** Drizzle wraps the database's error; the guard's words are on its cause. */
const appendOnlyRefusal = (err: Error & { cause?: { message?: string } }) => /append-only/.test(err.cause?.message ?? err.message);

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

describe("credits (launch Phase 7, increment 1)", () => {
  before(async () => {
    await cleanup();
    admin.id = await createUser({ admin: true });
  });
  after(cleanup);

  it("an account created verified holds one free credit; an unverified one holds none", async () => {
    const verified = await createUser();
    const unverified = await createUser({ verified: false });
    assert.equal(await creditBalance(verified), 1);
    assert.deepEqual((await rowsOf(verified)).map((r) => [r.kind, r.credits, r.lotId]), [["free_grant", 1, null]]);
    assert.equal(await creditBalance(unverified), 0);
    assert.equal((await rowsOf(unverified)).length, 0);
  });

  it("the first verification grants the free credit once, however often the account is verified again", async () => {
    const id = await createUser({ verified: false });
    await db.update(usersTable).set({ emailVerifiedAt: new Date() }).where(eq(usersTable.id, id));
    await db.update(usersTable).set({ emailVerifiedAt: null }).where(eq(usersTable.id, id));
    await db.update(usersTable).set({ emailVerifiedAt: new Date() }).where(eq(usersTable.id, id));
    await db.update(usersTable).set({ emailVerifiedAt: new Date() }).where(eq(usersTable.id, id));
    assert.equal(await creditBalance(id), 1);
    assert.equal((await rowsOf(id)).length, 1);
  });

  it("an admin's \"verify email\" grants the free credit", async () => {
    const id = await createUser({ verified: false });
    const sid = await sessionFor(admin.id, true);
    const res = await request(makeApp()).post(`/api/admin/users/${id}/verify-email`).set("authorization", `Bearer ${sid}`).send({});
    assert.equal(res.status, 200);
    assert.equal(await creditBalance(id), 1);
  });

  it("the ledger is append-only: a row is never updated or deleted, and goes only with its account", async () => {
    const id = await createUser();
    await assert.rejects(db.update(creditLedgerTable).set({ credits: 5 }).where(eq(creditLedgerTable.userId, id)), appendOnlyRefusal);
    await assert.rejects(db.delete(creditLedgerTable).where(eq(creditLedgerTable.userId, id)), appendOnlyRefusal);
    await applyAdminAdjustment({ userId: id, credits: 2, note: "test", requestId: randomUUID(), admin });
    await applyAdminAdjustment({ userId: id, credits: -2, note: "test", requestId: randomUUID(), admin });
    await db.delete(usersTable).where(eq(usersTable.id, id));
    assert.equal((await rowsOf(id)).length, 0, "the account's deletion takes its ledger, lots and draws alike");
  });

  it("deleting the admin who made an adjustment keeps the member's ledger, attributed by label", async () => {
    const departing = await createUser({ admin: true });
    const member = await createUser();
    await applyAdminAdjustment({ userId: member, credits: 2, note: "before leaving", requestId: randomUUID(), admin: { id: departing, label: "Departing Admin" } });
    await db.delete(usersTable).where(eq(usersTable.id, departing));
    const grant = (await rowsOf(member)).find((r) => r.kind === "admin_grant")!;
    assert.equal(grant.actorLabel, "Departing Admin");
    assert.equal(await creditBalance(member), 3);
  });

  it("a debit draws on the oldest lots first and never takes the balance below zero", async () => {
    const id = await createUser(); // lot 1: the free credit
    await applyAdminAdjustment({ userId: id, credits: 3, note: "goodwill", requestId: randomUUID(), admin }); // lot 2
    const result = await applyAdminAdjustment({ userId: id, credits: -2, note: "correction", requestId: randomUUID(), admin });
    assert.deepEqual(result, { applied: true, balance: 2 });
    const rows = await rowsOf(id);
    const [free, goodwill] = rows;
    assert.deepEqual(rows.slice(2).map((r) => [r.kind, r.credits, r.lotId]), [["admin_debit", -1, free!.id], ["admin_debit", -1, goodwill!.id]]);
    await assert.rejects(
      applyAdminAdjustment({ userId: id, credits: -3, note: "too much", requestId: randomUUID(), admin }),
      (err: Error & { code?: string }) => err.code === "insufficient_balance",
    );
    assert.equal(await creditBalance(id), 2);
  });

  it("the history shows one adjustment once, totalled, however many grants it drew on (Issue #1301)", async () => {
    const id = await createUser(); // the free credit
    await applyAdminAdjustment({ userId: id, credits: 2, note: "Testing how adding credits works.", requestId: randomUUID(), admin });
    await applyAdminAdjustment({ userId: id, credits: -2, note: "Shouldn't have given them credits.", requestId: randomUUID(), admin });
    assert.equal((await rowsOf(id)).filter((r) => r.kind === "admin_debit").length, 2, "the ledger keeps one row per grant drawn on");
    const entries = await creditEntries(id);
    assert.deepEqual(entries.map((e) => [e.kind, e.credits, e.note]), [
      ["admin_debit", -2, "Shouldn't have given them credits."],
      ["admin_grant", 2, "Testing how adding credits works."],
      ["free_grant", 1, null],
    ]);
    assert.equal(entries.reduce((s, e) => s + e.credits, 0), await creditBalance(id));
  });

  it("an adjustment sent twice is applied once; its id reused for a different adjustment is refused", async () => {
    const id = await createUser();
    const requestId = randomUUID();
    assert.deepEqual(await applyAdminAdjustment({ userId: id, credits: 5, note: "a", requestId, admin }), { applied: true, balance: 6 });
    assert.deepEqual(await applyAdminAdjustment({ userId: id, credits: 5, note: "a", requestId, admin }), { applied: false, balance: 6 });
    await assert.rejects(applyAdminAdjustment({ userId: id, credits: 4, note: "a", requestId, admin }), (err: Error & { code?: string }) => err.code === "request_reused");
    const other = await createUser();
    await assert.rejects(applyAdminAdjustment({ userId: other, credits: 5, note: "a", requestId, admin }), (err: Error & { code?: string }) => err.code === "request_reused");
    assert.equal(await creditBalance(other), 1);
  });

  it("two debits of the whole balance at once: one applies, the other is refused, and the balance is never negative", async () => {
    const id = await createUser();
    await applyAdminAdjustment({ userId: id, credits: 4, note: "seed", requestId: randomUUID(), admin });
    const results = await Promise.allSettled([
      applyAdminAdjustment({ userId: id, credits: -5, note: "race", requestId: randomUUID(), admin }),
      applyAdminAdjustment({ userId: id, credits: -5, note: "race", requestId: randomUUID(), admin }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await creditBalance(id), 0);
  });

  it("the admin routes: balance and ledger; an adjustment needs a note and an admin; the ledger row names the admin", async () => {
    const id = await createUser();
    const adminSid = await sessionFor(admin.id, true);
    const member = await createUser();
    const memberSid = await sessionFor(member, false);
    const app = makeApp();

    const forbidden = await request(app).post(`/api/admin/users/${id}/credits`).set("authorization", `Bearer ${memberSid}`).send({ credits: 3, note: "x", requestId: randomUUID() });
    assert.equal(forbidden.status, 403);
    const noNote = await request(app).post(`/api/admin/users/${id}/credits`).set("authorization", `Bearer ${adminSid}`).send({ credits: 3, note: "  ", requestId: randomUUID() });
    assert.equal(noNote.status, 400);
    const zero = await request(app).post(`/api/admin/users/${id}/credits`).set("authorization", `Bearer ${adminSid}`).send({ credits: 0, note: "x", requestId: randomUUID() });
    assert.equal(zero.status, 400);
    const overdraw = await request(app).post(`/api/admin/users/${id}/credits`).set("authorization", `Bearer ${adminSid}`).send({ credits: -2, note: "x", requestId: randomUUID() });
    assert.equal(overdraw.status, 409);
    const ok = await request(app).post(`/api/admin/users/${id}/credits`).set("authorization", `Bearer ${adminSid}`).send({ credits: 3, note: "Support goodwill", requestId: randomUUID() });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { applied: true, balance: 4 });

    const view = await request(app).get(`/api/admin/users/${id}/credits`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.balance, 4);
    assert.deepEqual(view.body.entries.map((e: { kind: string; credits: number; note: string | null; actorLabel: string | null }) => [e.kind, e.credits, e.note, e.actorLabel]), [
      ["admin_grant", 3, "Support goodwill", "Admin Tester"],
      ["free_grant", 1, null, null],
    ]);
    assert.equal((await request(app).get(`/api/admin/users/${PREFIX}nobody/credits`).set("authorization", `Bearer ${adminSid}`)).status, 404);
    assert.equal((await request(app).get(`/api/admin/users/${id}/credits`).set("authorization", `Bearer ${memberSid}`)).status, 403);
  });
});

