/**
 * The one onboarding screen's server side (launch Phase 5, increment 3, #795;
 * plan S4, S5, S8, S22, T2).
 *
 * @purpose Proves, through the real app stack, that only a verified account can save a draft or complete onboarding, that a date under 13 is refused with nothing stored (draft and completion alike), that completion writes the date, pronouns, the consent record with its method and wording version, and the completion time in one write and clears the draft, that the marketing default follows the edge country, that a failed challenge records nothing, that completing twice changes nothing, and that age and eligibility derive from the row to the day.
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
import { ageInYears, eligibilityOf, isPlausibleBirthDate } from "../lib/eligibility.js";
import { MARKETING_WORDING_VERSION, consentMethod } from "../routes/onboarding.js";

const USER_PREFIX = "t-p5onb-";

async function user(opts: { verified?: boolean; onboarded?: boolean; pronouns?: string | null } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    firstName: "Sarah",
    emailVerifiedAt: opts.verified === false ? null : new Date(),
    onboardingCompletedAt: opts.onboarded ? new Date() : null,
    pronouns: opts.pronouns ?? null,
  });
  return id;
}

async function bearer(userId: string): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t" };
  return createSession(data, userId);
}

async function row(userId: string) {
  const [r] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  return r!;
}

function yearsAgo(years: number, dayOffset = 0): { dobYear: string; dobMonth: string; dobDay: string } {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return { dobYear: String(d.getUTCFullYear()), dobMonth: String(d.getUTCMonth() + 1), dobDay: String(d.getUTCDate()) };
}

const COMPLETE = { displayName: "Sarah Connor", pronouns: "she/her", ...yearsAgo(30), marketingOptIn: true, captchaToken: "dev-bypass" };

before(async () => {
  // lib/captcha.ts passes any token in a non-production run with no secret.
  delete process.env.TURNSTILE_SECRET_KEY;
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
});
after(async () => {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
});

describe("GET /api/auth/onboarding", () => {
  it("starts the form from the account, the draft and the edge country", async () => {
    const id = await user({ pronouns: "he/him" });
    const sid = await bearer(id);
    const us = await request(createApp()).get("/api/auth/onboarding").set("authorization", `Bearer ${sid}`).set("cf-ipcountry", "US");
    assert.equal(us.status, 200);
    assert.equal(us.body.marketingDefault, true);
    assert.equal(us.body.marketingWordingVersion, MARKETING_WORDING_VERSION);
    assert.equal(us.body.accountPronouns, "he/him");
    // A provider first name is not the account's display name (Phase 2).
    assert.equal(us.body.displayName, null);
    assert.equal(us.body.providerFirstName, "Sarah");
    assert.equal(us.body.completed, false);
    const ca = await request(createApp()).get("/api/auth/onboarding").set("authorization", `Bearer ${sid}`).set("cf-ipcountry", "CA");
    assert.equal(ca.body.marketingDefault, false);
    const none = await request(createApp()).get("/api/auth/onboarding").set("authorization", `Bearer ${sid}`);
    assert.equal(none.body.marketingDefault, false, "no header (dev, tests): unchecked");
  });
});

describe("PUT /api/users/me/onboarding/draft", () => {
  it("saves the half-finished form, and a reload gets it back", async () => {
    const id = await user();
    const sid = await bearer(id);
    const app = createApp();
    const put = await request(app).put("/api/users/me/onboarding/draft").set("authorization", `Bearer ${sid}`)
      .send({ displayName: "Sar", pronouns: "they/them", dobYear: "1990", marketingOptIn: false });
    assert.equal(put.status, 200);
    const got = await request(app).get("/api/auth/onboarding").set("authorization", `Bearer ${sid}`);
    assert.deepEqual(got.body.draft, { displayName: "Sar", pronouns: "they/them", dobYear: "1990", marketingOptIn: false });
  });

  it("a date under 13 is refused and nothing is written, not even the other fields", async () => {
    const id = await user();
    const sid = await bearer(id);
    const res = await request(createApp()).put("/api/users/me/onboarding/draft").set("authorization", `Bearer ${sid}`)
      .send({ pronouns: "she/her", ...yearsAgo(13, 1) });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "UNDER_AGE");
    const r = await row(id);
    assert.equal(r.onboardingDraft, null);
    assert.equal(r.dateOfBirth, null);
  });

  it("an unverified account cannot save a draft", async () => {
    const id = await user({ verified: false });
    const sid = await bearer(id);
    const res = await request(createApp()).put("/api/users/me/onboarding/draft").set("authorization", `Bearer ${sid}`).send({ pronouns: "she/her" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "EMAIL_VERIFICATION_REQUIRED");
    assert.equal((await row(id)).onboardingDraft, null);
  });
});

describe("POST /api/users/me/onboarding", () => {
  it("requires a display name, under the shared name rule, and writes nothing without one", async () => {
    const id = await user();
    const sid = await bearer(id);
    for (const displayName of [undefined, "", "Sarah 😀", "x".repeat(51)]) {
      const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${sid}`).send({ ...COMPLETE, displayName });
      assert.equal(res.status, 400, JSON.stringify(displayName));
      assert.equal(res.body.field, "displayName");
    }
    const r = await row(id);
    assert.equal(r.onboardingCompletedAt, null);
    assert.equal(r.displayName, null);
  });

  it("writes every field in one write, clears the draft, and the account can act", async () => {
    const id = await user();
    const sid = await bearer(id);
    const app = createApp();
    await request(app).put("/api/users/me/onboarding/draft").set("authorization", `Bearer ${sid}`).send({ pronouns: "they/them" });
    const res = await request(app).post("/api/users/me/onboarding").set("authorization", `Bearer ${sid}`).set("cf-ipcountry", "US").send(COMPLETE);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = await row(id);
    assert.ok(r.onboardingCompletedAt instanceof Date);
    assert.equal(r.pronouns, "she/her");
    assert.equal(r.displayName, "Sarah Connor");
    assert.equal(r.dateOfBirth, `${COMPLETE.dobYear}-${COMPLETE.dobMonth.padStart(2, "0")}-${COMPLETE.dobDay.padStart(2, "0")}`);
    assert.ok(r.marketingConsentAt instanceof Date);
    assert.equal(r.marketingConsentMethod, "default_checked");
    assert.equal(r.marketingConsentWordingVersion, MARKETING_WORDING_VERSION);
    assert.equal(r.onboardingDraft, null);
    const me = await request(app).get("/api/auth/user").set("authorization", `Bearer ${sid}`);
    assert.equal(me.body.user.eligibility, "eligible");
    assert.equal(me.body.user.is18Plus, true);
  });

  it("keeps a custom pronoun set exactly as chosen", async () => {
    const id = await user();
    const custom = "fae|faer|faer|faers|faerself|s";
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, pronouns: custom });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await row(id)).pronouns, custom);
  });

  it("a profile edit keeps a custom pronoun set exactly as chosen", async () => {
    const id = await user({ onboarded: true });
    const custom = "xe|xem|xyr|xyrs|xemself|p";
    const res = await request(createApp()).patch("/api/users/me").set("authorization", `Bearer ${await bearer(id)}`).send({ pronouns: custom });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await row(id)).pronouns, custom);
  });

  it("sign-up keeps a custom pronoun set exactly as chosen", async () => {
    const email = `${USER_PREFIX}${randomUUID()}@test.local`;
    const custom = "ze|hir|hir|hirs|hirself|s";
    const res = await request(createApp()).post("/api/auth/register")
      .send({ email, password: "long-enough-1", firstName: "Zed", lastName: "Doe", displayName: "Zed", pronouns: custom });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [r] = await db.select({ pronouns: usersTable.pronouns, id: usersTable.id, registered: usersTable.registeredUnderOnboarding }).from(usersTable).where(eq(usersTable.email, email));
    assert.equal(r!.pronouns, custom);
    assert.equal(r!.registered, true, "a sign-up is a registration the never-onboarded clean-up may select (0118)");
    await db.delete(usersTable).where(eq(usersTable.id, r!.id));
  });

  it("records how consent was given: ticked by hand outside the US, declined anywhere", async () => {
    const ticked = await user();
    await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(ticked)}`).set("cf-ipcountry", "GB").send(COMPLETE);
    assert.equal((await row(ticked)).marketingConsentMethod, "ticked");
    const declined = await user();
    await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(declined)}`).set("cf-ipcountry", "US").send({ ...COMPLETE, marketingOptIn: false });
    const r = await row(declined);
    assert.equal(r.marketingConsentMethod, "declined");
    assert.ok(r.marketingConsentAt instanceof Date, "a decline is recorded with its time too");
  });

  it("under 13 is refused with nothing stored and nothing destroyed", async () => {
    const id = await user({ pronouns: "he/him" });
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, ...yearsAgo(12) });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "UNDER_AGE");
    const r = await row(id);
    assert.equal(r.dateOfBirth, null);
    assert.equal(r.onboardingCompletedAt, null);
    assert.equal(r.marketingConsentAt, null);
    assert.equal(r.pronouns, "he/him", "the account is left as it was");
  });

  it("thirteen today is old enough", async () => {
    const id = await user();
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, ...yearsAgo(13) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it("pronouns are required: blank is refused", async () => {
    const id = await user();
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, pronouns: "" });
    assert.equal(res.status, 400);
    assert.equal(res.body.field, "pronouns");
    assert.equal((await row(id)).onboardingCompletedAt, null);
  });

  it("a failed challenge records nothing", async () => {
    const id = await user();
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, captchaToken: "" });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CAPTCHA_FAILED");
    assert.equal((await row(id)).onboardingCompletedAt, null);
  });

  it("completing twice changes nothing the first completion wrote", async () => {
    const id = await user({ onboarded: true, pronouns: "he/him" });
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, pronouns: "she/her" });
    assert.equal(res.status, 200);
    assert.equal((await row(id)).pronouns, "he/him");
  });

  it("an unverified account is refused", async () => {
    const id = await user({ verified: false });
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send(COMPLETE);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "EMAIL_VERIFICATION_REQUIRED");
  });
});

describe("age and eligibility derive from the row", () => {
  const now = new Date(Date.UTC(2026, 10, 1));
  it("counts whole years by calendar date: the birthday itself counts", () => {
    assert.equal(ageInYears("2013-11-01", now), 13);
    assert.equal(ageInYears("2013-11-02", now), 12);
    assert.equal(ageInYears("2008-11-01", now), 18);
    assert.equal(ageInYears("2008-11-02", now), 17);
    assert.equal(ageInYears("2012-02-29", now), 14);
    assert.equal(ageInYears(null, now), null);
    assert.equal(ageInYears("not-a-date", now), null);
  });
  it("refuses impossible and future dates", () => {
    assert.equal(isPlausibleBirthDate("2001-02-29", now), false);
    assert.equal(isPlausibleBirthDate("2027-01-01", now), false);
    assert.equal(isPlausibleBirthDate("1899-12-31", now), false);
    assert.equal(isPlausibleBirthDate("2000-02-29", now), true);
  });
  it("verify, then onboard, then act", () => {
    assert.equal(eligibilityOf({ emailVerifiedAt: null, onboardingCompletedAt: null }), "unverified");
    assert.equal(eligibilityOf({ emailVerifiedAt: null, onboardingCompletedAt: new Date() }), "unverified");
    assert.equal(eligibilityOf({ emailVerifiedAt: new Date(), onboardingCompletedAt: null }), "unonboarded");
    assert.equal(eligibilityOf({ emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() }), "eligible");
  });
  it("consent method from the box and its default", () => {
    assert.equal(consentMethod(true, true), "default_checked");
    assert.equal(consentMethod(true, false), "ticked");
    assert.equal(consentMethod(false, true), "declined");
    assert.equal(consentMethod(false, false), "declined");
  });
});
