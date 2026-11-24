/**
 * @purpose Proves the support correction a refused under-18 answer is promised (launch Phase 14, increment 4: "A mistyped date is corrected through support, and the screen says so"): an admin stores a corrected adult date and clears the refusal, the account is no longer under age and can finish set-up with the corrected date (not another one typed later), and the account reports the state the browser lifts its adults-only mark on; a date under 18 or an impossible one is refused with nothing changed, only an admin may do it, and a fresh account never reads as corrected.
 * @subsystem accounts-auth
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { requiredLegalVersions } from "../lib/legalAcceptance.js";
import { acceptCurrentLegal } from "./helpers/legalAcceptance.js";

const PREFIX = "t-p14agefix-";

function yearsAgo(years: number, dayOffset = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

function parts(date: string) {
  const [y, m, d] = date.split("-");
  return { dobYear: y!, dobMonth: String(Number(m)), dobDay: String(Number(d)) };
}

async function refusedAccount(): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, emailVerifiedAt: new Date(), ageRefusedAt: new Date(),
  });
  return id;
}

async function freshAccount(): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, emailVerifiedAt: new Date() });
  return id;
}

async function adminSession(): Promise<string> {
  const id = `${PREFIX}admin-${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
    dateOfBirth: "1980-01-01", isAdmin: true,
  });
  await acceptCurrentLegal(id);
  return bearer(id, true);
}

async function bearer(userId: string, isAdmin = false): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t", isAdmin };
  return createSession(data, userId);
}

async function row(id: string) {
  const [r] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  return r!;
}

const correct = (sid: string, id: string, dateOfBirth: unknown) =>
  request(createApp()).post(`/api/admin/users/${id}/correct-date-of-birth`).set("authorization", `Bearer ${sid}`).send({ dateOfBirth });

before(async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
});
after(async () => {
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
});

describe("POST /api/admin/users/:id/correct-date-of-birth", () => {
  it("stores the corrected adult date and clears the refusal; set-up then finishes with that date", async () => {
    const admin = await adminSession();
    const id = await refusedAccount();
    const sid = await bearer(id);
    const app = createApp();
    const before = await request(app).get("/api/auth/user").set("authorization", `Bearer ${sid}`);
    assert.equal(before.body.user.eligibility, "underage");

    const corrected = yearsAgo(25);
    const res = await correct(admin, id, corrected);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = await row(id);
    assert.equal(r.ageRefusedAt, null, "the refusal is cleared");
    assert.equal(r.dateOfBirth, corrected);

    // What the browser lifts its mark on: not under age, and 18+ by a stored date.
    const me = await request(app).get("/api/auth/user").set("authorization", `Bearer ${sid}`);
    assert.equal(me.body.user.eligibility, "unonboarded");
    assert.equal(me.body.user.is18Plus, true);

    // The set-up form starts from the corrected date.
    const state = await request(app).get("/api/auth/onboarding").set("authorization", `Bearer ${sid}`);
    assert.equal(state.status, 200);
    assert.equal(state.body.dateOfBirth, corrected);

    // Set-up keeps the corrected date whatever the form sends.
    const done = await request(app).post("/api/users/me/onboarding").set("authorization", `Bearer ${sid}`).send({
      displayName: "Sam Rivera", pronouns: "they/them", ...parts(yearsAgo(40)), marketingOptIn: false,
      captchaToken: "dev-bypass", legalAcceptance: requiredLegalVersions(),
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const after = await row(id);
    assert.equal(after.dateOfBirth, corrected);
    assert.ok(after.onboardingCompletedAt instanceof Date);
    const eligible = await request(app).get("/api/auth/user").set("authorization", `Bearer ${sid}`);
    assert.equal(eligible.body.user.eligibility, "eligible");
  });

  it("a corrected account's set-up cannot be sent a young date to undo the correction", async () => {
    const admin = await adminSession();
    const id = await refusedAccount();
    const corrected = yearsAgo(30);
    assert.equal((await correct(admin, id, corrected)).status, 200);
    const sid = await bearer(id);
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${sid}`).send({
      displayName: "Sam Rivera", pronouns: "they/them", ...parts(yearsAgo(15)), marketingOptIn: false,
      captchaToken: "dev-bypass", legalAcceptance: requiredLegalVersions(),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = await row(id);
    assert.equal(r.ageRefusedAt, null);
    assert.equal(r.dateOfBirth, corrected);
  });

  it("refuses a date under 18, an impossible date and a missing one, changing nothing", async () => {
    const admin = await adminSession();
    const id = await refusedAccount();
    for (const bad of [yearsAgo(18, 1), "2001-02-30", "not a date", undefined, yearsAgo(-1)]) {
      const res = await correct(admin, id, bad);
      assert.equal(res.status, 400, `${String(bad)}: ${JSON.stringify(res.body)}`);
    }
    const r = await row(id);
    assert.ok(r.ageRefusedAt instanceof Date, "still refused");
    assert.equal(r.dateOfBirth, null);
  });

  it("eighteen today is old enough", async () => {
    const admin = await adminSession();
    const id = await refusedAccount();
    assert.equal((await correct(admin, id, yearsAgo(18))).status, 200);
    assert.equal((await row(id)).ageRefusedAt, null);
  });

  it("only an admin may correct, and an unknown account is not found", async () => {
    const admin = await adminSession();
    const id = await refusedAccount();
    const member = `${PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id: member, email: `${member}@test.local`, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), dateOfBirth: "1990-01-01",
    });
    await acceptCurrentLegal(member);
    const asMember = await correct(await bearer(member), id, yearsAgo(30));
    assert.equal(asMember.status, 403);
    assert.ok((await row(id)).ageRefusedAt instanceof Date);
    assert.equal((await correct(admin, `${PREFIX}nobody`, yearsAgo(30))).status, 404);
  });

  it("a fresh account never reads as corrected: no stored date, not 18+", async () => {
    const id = await freshAccount();
    const sid = await bearer(id);
    const app = createApp();
    const me = await request(app).get("/api/auth/user").set("authorization", `Bearer ${sid}`);
    assert.equal(me.body.user.eligibility, "unonboarded");
    assert.notEqual(me.body.user.is18Plus, true);
    const state = await request(app).get("/api/auth/onboarding").set("authorization", `Bearer ${sid}`);
    assert.equal(state.body.dateOfBirth, null);
  });
});
