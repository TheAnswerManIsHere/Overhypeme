/**
 * The one onboarding screen's server side (launch Phase 5, increment 3, #795;
 * plan S4, S5, S8, S22, T2).
 *
 * @purpose Proves, through the real app stack, that only a verified account can save a draft or complete onboarding, that a draft with a date under 18 stores nothing while a submitted one is recorded as a refusal on the account (date not stored, nothing else destroyed, no resubmission), that completion requires and records agreement to the current Terms and Privacy versions (an old or invented version refused), that completion writes the date, pronouns, the consent record with its method and wording version, and the completion time in one write and clears the draft, that the marketing default follows the edge country, that a failed challenge records nothing, that completing twice changes nothing, and that age and eligibility derive from the row to the day.
 * @subsystem accounts-auth
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable, legalAcceptancesTable } from "@workspace/db/schema";
import { acceptCurrentLegal } from "./helpers/legalAcceptance.js";
import { requiredLegalVersions } from "../lib/legalAcceptance.js";
import { eq, like } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { ageInYears, eligibilityOf, isPlausibleBirthDate } from "../lib/eligibility.js";
import { MARKETING_WORDING_VERSION, consentMethod } from "../routes/onboarding.js";

const USER_PREFIX = "t-p5onb-";
const ACCEPTED = requiredLegalVersions();

async function user(opts: { verified?: boolean; onboarded?: boolean; pronouns?: string | null } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    firstName: "Raena",
    emailVerifiedAt: opts.verified === false ? null : new Date(),
    onboardingCompletedAt: opts.onboarded ? new Date() : null,
    dateOfBirth: opts.onboarded ? "1990-01-01" : null,
    pronouns: opts.pronouns ?? null,
  });
  // An account onboarded since launch Phase 14 agreed to the Terms at set-up.
  if (opts.onboarded) await acceptCurrentLegal(id);
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

const COMPLETE = { displayName: "Raena Franklin", pronouns: "she/her", ...yearsAgo(30), marketingOptIn: true, captchaToken: "dev-bypass", legalAcceptance: ACCEPTED };

async function acceptances(userId: string) {
  return db.select().from(legalAcceptancesTable).where(eq(legalAcceptancesTable.userId, userId));
}

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
    assert.equal(us.body.providerFirstName, "Raena");
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
      .send({ displayName: "Rae", pronouns: "they/them", dobYear: "1990", marketingOptIn: false });
    assert.equal(put.status, 200);
    const got = await request(app).get("/api/auth/onboarding").set("authorization", `Bearer ${sid}`);
    assert.deepEqual(got.body.draft, { displayName: "Rae", pronouns: "they/them", dobYear: "1990", marketingOptIn: false });
  });

  it("a date under 18 is refused and nothing is written, not even the other fields, and no refusal is recorded", async () => {
    const id = await user();
    const sid = await bearer(id);
    const res = await request(createApp()).put("/api/users/me/onboarding/draft").set("authorization", `Bearer ${sid}`)
      .send({ pronouns: "she/her", ...yearsAgo(18, 1) });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "UNDER_AGE");
    const r = await row(id);
    assert.equal(r.onboardingDraft, null);
    assert.equal(r.dateOfBirth, null);
    assert.equal(r.ageRefusedAt, null, "a draft is not a submission");
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
    for (const displayName of [undefined, "", "Raena 😀", "x".repeat(51)]) {
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
    assert.equal(r.displayName, "Raena Franklin");
    assert.equal(r.dateOfBirth, `${COMPLETE.dobYear}-${COMPLETE.dobMonth.padStart(2, "0")}-${COMPLETE.dobDay.padStart(2, "0")}`);
    assert.ok(r.marketingConsentAt instanceof Date);
    assert.equal(r.marketingConsentMethod, "default_checked");
    assert.equal(r.marketingConsentWordingVersion, MARKETING_WORDING_VERSION);
    assert.equal(r.onboardingDraft, null);
    const accepted = (await acceptances(id)).map((a) => `${a.document}@${a.version}`).sort();
    assert.deepEqual(accepted, [`privacy@${ACCEPTED.privacy}`, `terms@${ACCEPTED.terms}`]);
    const me = await request(app).get("/api/auth/user").set("authorization", `Bearer ${sid}`);
    assert.equal(me.body.user.eligibility, "eligible");
    assert.equal(me.body.user.is18Plus, true);
  });

  it("set-up requires agreeing to the current Terms and Privacy versions, and records nothing without it", async () => {
    const app = createApp();
    for (const [label, legalAcceptance, code] of [
      ["missing", undefined, "LEGAL_ACCEPTANCE_MISSING"],
      ["privacy not acknowledged", { terms: ACCEPTED.terms }, "LEGAL_ACCEPTANCE_MISSING"],
      ["an old Terms version", { ...ACCEPTED, terms: "2000-01-01" }, "LEGAL_VERSION_OUTDATED"],
      ["an invented Privacy version", { ...ACCEPTED, privacy: "2099-12-31" }, "LEGAL_VERSION_OUTDATED"],
    ] as const) {
      const id = await user();
      const res = await request(app).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, legalAcceptance });
      assert.equal(res.status, 400, label);
      assert.equal(res.body.code, code, label);
      assert.equal((await row(id)).onboardingCompletedAt, null, label);
      assert.equal((await acceptances(id)).length, 0, label);
    }
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
      .send({ email, password: "long-enough-1", firstName: "David", lastName: "Franklin", displayName: "David", pronouns: custom });
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

  it("a submitted date under 18 is recorded as a refusal: the date is not stored and nothing is destroyed", async () => {
    const id = await user({ pronouns: "he/him" });
    const app = createApp();
    const sid = await bearer(id);
    const res = await request(app).post("/api/users/me/onboarding").set("authorization", `Bearer ${sid}`).send({ ...COMPLETE, ...yearsAgo(18, 1) });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "UNDER_AGE");
    const r = await row(id);
    assert.ok(r.ageRefusedAt instanceof Date, "the refusal is recorded on the account");
    assert.equal(r.dateOfBirth, null);
    assert.equal(r.onboardingCompletedAt, null);
    assert.equal(r.marketingConsentAt, null);
    assert.equal(r.pronouns, "he/him", "the account is left as it was");
    assert.equal((await acceptances(id)).length, 0);
    const me = await request(app).get("/api/auth/user").set("authorization", `Bearer ${sid}`);
    assert.equal(me.body.user.eligibility, "underage");
  });

  it("after a refusal, set-up cannot be resubmitted with a different date", async () => {
    const id = await user();
    const app = createApp();
    const sid = await bearer(id);
    await request(app).post("/api/users/me/onboarding").set("authorization", `Bearer ${sid}`).send({ ...COMPLETE, ...yearsAgo(16) });
    const retry = await request(app).post("/api/users/me/onboarding").set("authorization", `Bearer ${sid}`).send({ ...COMPLETE, ...yearsAgo(30) });
    assert.equal(retry.status, 403);
    assert.equal(retry.body.code, "UNDER_AGE");
    const draft = await request(app).put("/api/users/me/onboarding/draft").set("authorization", `Bearer ${sid}`).send({ ...yearsAgo(30) });
    assert.equal(draft.status, 403);
    const r = await row(id);
    assert.equal(r.onboardingCompletedAt, null);
    assert.equal(r.dateOfBirth, null);
  });

  it("eighteen today is old enough", async () => {
    const id = await user();
    const res = await request(createApp()).post("/api/users/me/onboarding").set("authorization", `Bearer ${await bearer(id)}`).send({ ...COMPLETE, ...yearsAgo(18) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await row(id)).ageRefusedAt, null);
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
  it("verify, then onboard, then accept, then act", () => {
    const v = new Date();
    assert.equal(eligibilityOf({ emailVerifiedAt: null, onboardingCompletedAt: null }, now), "unverified");
    assert.equal(eligibilityOf({ emailVerifiedAt: null, onboardingCompletedAt: v }, now), "unverified");
    assert.equal(eligibilityOf({ emailVerifiedAt: v, onboardingCompletedAt: null }, now), "unonboarded");
    assert.equal(eligibilityOf({ emailVerifiedAt: v, onboardingCompletedAt: v }, now), "terms_unaccepted", "absent acceptance fails closed");
    assert.equal(eligibilityOf({ emailVerifiedAt: v, onboardingCompletedAt: v, legalAccepted: false }, now), "terms_unaccepted");
    assert.equal(eligibilityOf({ emailVerifiedAt: v, onboardingCompletedAt: v, legalAccepted: true }, now), "eligible");
  });
  it("under 18 comes after suspension and before everything else, and lapses on the 18th birthday", () => {
    const v = new Date();
    const adult = { emailVerifiedAt: v, onboardingCompletedAt: v, legalAccepted: true };
    assert.equal(eligibilityOf({ ...adult, dateOfBirth: "2008-11-02" }, now), "underage");
    assert.equal(eligibilityOf({ ...adult, dateOfBirth: "2008-11-01" }, now), "eligible");
    assert.equal(eligibilityOf({ ...adult, dateOfBirth: "2008-11-02", deletionPending: true }, now), "underage");
    assert.equal(eligibilityOf({ ...adult, dateOfBirth: "2008-11-02", suspendedAt: v }, now), "suspended");
    // A refusal is permanent: it does not lapse, whatever date is later stored.
    assert.equal(eligibilityOf({ ...adult, dateOfBirth: "1990-01-01", ageRefusedAt: v }, now), "underage");
    assert.equal(eligibilityOf({ emailVerifiedAt: v, onboardingCompletedAt: null, ageRefusedAt: v }, now), "underage");
    // An un-onboarded account's absent date is not under age.
    assert.equal(eligibilityOf({ emailVerifiedAt: v, onboardingCompletedAt: null, dateOfBirth: null }, now), "unonboarded");
  });
  it("consent method from the box and its default", () => {
    assert.equal(consentMethod(true, true), "default_checked");
    assert.equal(consentMethod(true, false), "ticked");
    assert.equal(consentMethod(false, true), "declined");
    assert.equal(consentMethod(false, false), "declined");
  });
});
