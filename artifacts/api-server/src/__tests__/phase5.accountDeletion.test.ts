/**
 * @purpose T3, the account deletion state machine (launch Phase 5, plan S14): re-authentication (password; a recent sign-in for a provider-only account), acceptance signing the account out and hiding its content at once, the gate confining it to "keep my account", a repeated request being idempotent, cancel restoring content (a hand-deleted item stays deleted) and racing the purge so exactly one wins, a billing dispute holding the purge and the content purger alike, subscriptions cancelled (past_due included, an already-cancelled one converging, a failure retried), and the purge itself — files and rows gone, standalone uploads collected, facts kept and credited, reactions on surviving targets recounted, ncmec_reports kept, a fact gallery's background kept — plus the admin purge-now, and a departing administrator no longer counting as reachable.
 * @subsystem security
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import bcrypt from "bcryptjs";

import { db } from "@workspace/db";
import {
  accountDeletionRequestsTable, commentsTable, entitlementSourceDisputesTable, factsTable, membershipEntitlementsTable,
  memesTable, ncmecReportsTable, reactionsTable, sessionsTable, uploadImageMetadataTable, userAiImagesTable, usersTable,
} from "@workspace/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { requireEligibleActor } from "../middlewares/requireEligibleActor.js";
import accountDeletionRouter from "../routes/accountDeletion.js";
import memesRouter from "../routes/memes.js";
import usersRouter from "../routes/users.js";
import storageRouter from "../routes/storage.js";
import adminRouter from "../routes/admin.js";
import {
  acceptAccountDeletion, advanceAccountDeletion, cancelAccountDeletion, runAccountDeletionWorker,
  __setAccountDeletionBillingForTests, __setBeforePurgeClaimForTests, type AccountDeletionBilling,
} from "../lib/accountDeletion.js";
import { isReachableAdminSql } from "../lib/adminIdentity.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { createMemeRecord, type MemeAuthorizationDecisions } from "../lib/createMemeRecord.js";
import { runContentPurger } from "../jobs/contentPurger.js";
import { lockOwnerContent } from "../lib/contentVisibility.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { memeKey } from "../lib/storageKeys.js";
import { photoBackgrounds, solidJpeg } from "./helpers/photoBackground.js";

const PREFIX = "t-p5del-";
const PASSWORD = "correct horse battery staple";
const ALLOW_ALL: MemeAuthorizationDecisions = { meme_private_visibility: true, meme_rate_limit_high: true };
const factIds: number[] = [];

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(requireEligibleActor);
  app.use("/api", accountDeletionRouter, usersRouter, memesRouter, storageRouter, adminRouter);
  return app;
}

async function createUser(opts: { password?: boolean; admin?: boolean; google?: boolean } = {}): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, displayName: "Leaver", pronouns: "they/them", membershipTier: "legendary",
    emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), dateOfBirth: "1990-01-01",
    passwordHash: opts.password === false ? null : await bcrypt.hash(PASSWORD, 4),
    googleLinked: opts.google ?? false,
    isAdmin: opts.admin ?? false,
  });
  return id;
}

async function sessionFor(userId: string, opts: { signedInAt?: number; isAdmin?: boolean } = {}): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t", isAdmin: opts.isAdmin, signedInAt: opts.signedInAt };
  return createSession(data, userId);
}

async function createFact(): Promise<number> {
  const [row] = await db.insert(factsTable)
    .values({ text: `${PREFIX}{NAME} leaves`, isActive: true, enrichment: buildPlaceholderFactEnrichment(), canonicalText: `${PREFIX}They leave` })
    .returning();
  factIds.push(row!.id);
  return row!.id;
}

async function memeIdOf(slug: string): Promise<number> {
  const [row] = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.permalinkSlug, slug));
  return row!.id;
}

async function objectExists(path: string): Promise<boolean> {
  return new ObjectStorageService().getObjectEntityFile(path).then(() => true, () => false);
}

const past = () => new Date(Date.now() - 60_000);

/** A fake for the two Stripe calls, recording what it was asked. `refreshApplies` decides each refresh (default: applied). */
function fakeBilling(behaviour: (subscriptionId: string, call: number) => void = () => {}, refreshApplies: (call: number) => boolean = () => true) {
  const calls: string[] = [];
  let refreshes = 0;
  const fake: AccountDeletionBilling = {
    async cancel(id) { calls.push(`cancel:${id}`); behaviour(id, calls.length); },
    async refresh(id) {
      calls.push(`refresh:${id}`);
      if (!refreshApplies(++refreshes)) return { applied: false, reason: "source_busy" };
      await db.update(membershipEntitlementsTable).set({ lifecycleStatus: "canceled" }).where(eq(membershipEntitlementsTable.providerRef, id));
      return { applied: true };
    },
  };
  return { fake, calls };
}

/** A subscription source row for `userId`. */
function subscription(userId: string, status = "active") {
  return { userId, sourceType: "stripe_subscription" as const, providerRef: `sub_${randomUUID()}`, isMembershipProduct: true, lifecycleStatus: status, sourceStateAsOf: 1 };
}

async function cleanup(): Promise<void> {
  await db.delete(accountDeletionRequestsTable).where(like(accountDeletionRequestsTable.userId, `${PREFIX}%`));
  await db.delete(reactionsTable).where(like(reactionsTable.userId, `${PREFIX}%`));
  await db.delete(memesTable).where(like(memesTable.createdById, `${PREFIX}%`));
  await db.delete(commentsTable).where(like(commentsTable.authorId, `${PREFIX}%`));
  await db.delete(userAiImagesTable).where(like(userAiImagesTable.userId, `${PREFIX}%`));
  await db.delete(uploadImageMetadataTable).where(like(uploadImageMetadataTable.userId, `${PREFIX}%`));
  if (factIds.length > 0) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

describe("the account deletion state machine (T3)", () => {
  const photos = photoBackgrounds();
  let factId: number;

  before(async () => {
    photos.setUp();
    await cleanup();
    factId = await createFact();
  });
  let restoreBilling: (() => void) | null = null;
  afterEach(() => { restoreBilling?.(); restoreBilling = null; });
  after(async () => {
    await cleanup();
    await photos.tearDown();
  });

  it("a request needs the password; accepting it signs the account out everywhere, hides its content and confines it to keeping the account", async () => {
    const userId = await createUser();
    const uploadKey = await photos.seed(userId);
    const saved = await createMemeRecord({ userId, factId, imageSource: { type: "upload", uploadKey }, textOptions: {}, aspectRatio: "landscape", decisions: ALLOW_ALL });
    const sid = await sessionFor(userId);
    const otherSid = await sessionFor(userId);

    assert.equal((await request(makeApp()).post("/api/users/me/deletion").set("authorization", `Bearer ${sid}`).send({ password: "wrong" })).status, 401);
    const ok = await request(makeApp()).post("/api/users/me/deletion").set("authorization", `Bearer ${sid}`).send({ password: PASSWORD });
    assert.equal(ok.status, 200, ok.text);
    const days = (Date.parse(ok.body.purgeAfter) - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14, "purged 14 days out");

    const sessions = await db.select().from(sessionsTable).where(eq(sessionsTable.userId, userId));
    assert.equal(sessions.length, 0, `every session is gone, ${otherSid.slice(0, 4)}… included`);
    assert.equal((await request(makeApp()).get(`/api/memes/${saved.permalinkSlug}`)).status, 410, "the meme is hidden at once");
    assert.equal((await request(makeApp()).get(`/api/storage${uploadKey}`)).status, 404, "the photo too");

    // Signing in again during the window: only keeping the account is allowed.
    const back = await sessionFor(userId);
    const refused = await request(makeApp()).post("/api/users/me/search-history").set("authorization", `Bearer ${back}`).send({ query: "x" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "DELETION_PENDING");
    const status = await request(makeApp()).get("/api/users/me/deletion").set("authorization", `Bearer ${back}`);
    assert.equal(status.body.pending, true);

    // Work already in flight that lands after the acceptance is hidden by the same rule.
    const late = await photos.seed(userId);
    assert.equal((await request(makeApp()).get(`/api/storage${late}`)).status, 404, "an upload recorded after acceptance is hidden too");

    const again = await acceptAccountDeletion(userId, { requestedBy: "self" });
    assert.equal(again.status, "already_pending", "a repeated request is the same request");
  });

  it("a provider-only account re-authenticates with a recent sign-in", async () => {
    const userId = await createUser({ password: false, google: true });
    const stale = await sessionFor(userId, { signedInAt: Date.now() - 60 * 60 * 1000 });
    const refused = await request(makeApp()).post("/api/users/me/deletion").set("authorization", `Bearer ${stale}`).send({});
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "REAUTH_REQUIRED");
    assert.deepEqual(refused.body.providers, ["google"]);
    const fresh = await sessionFor(userId);
    assert.equal((await request(makeApp()).post("/api/users/me/deletion").set("authorization", `Bearer ${fresh}`).send({})).status, 200);
  });

  it("keeping the account restores its content, except what was deleted by hand", async () => {
    const userId = await createUser();
    const kept = await photos.seed(userId);
    const handDeleted = await photos.seed(userId);
    await db.update(uploadImageMetadataTable).set({ deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000) }).where(eq(uploadImageMetadataTable.objectPath, handDeleted));
    await acceptAccountDeletion(userId, { requestedBy: "self", kick: false });
    const owner = await sessionFor(userId);
    assert.equal((await request(makeApp()).get(`/api/storage${kept}`)).status, 404);

    const res = await request(makeApp()).post("/api/users/me/deletion/cancel").set("authorization", `Bearer ${owner}`);
    assert.equal(res.status, 200);
    const listed = (await request(makeApp()).get("/api/users/me/uploads").set("authorization", `Bearer ${owner}`)).body.uploads.map((u: { objectPath: string }) => u.objectPath);
    assert.ok(listed.includes(kept), "content is live again");
    assert.ok(!listed.includes(handDeleted), "what the owner deleted by hand stays deleted");
    const write = await request(makeApp()).post("/api/users/me/search-history").set("authorization", `Bearer ${owner}`).send({ query: "back" });
    assert.notEqual(write.status, 403, "the account can act again");
  });

  it("cancel and purge race: whichever compare-and-set lands first wins, and the other is told", async () => {
    const { fake } = fakeBilling();
    restoreBilling = __setAccountDeletionBillingForTests(fake);
    const keeper = await createUser();
    await acceptAccountDeletion(keeper, { requestedBy: "self", purgeAfter: past(), kick: false });
    await advanceAccountDeletion(keeper, new Date(Date.now() - 120_000)); // notified, not yet due at that time
    assert.equal(await cancelAccountDeletion(keeper, { notify: false }), "cancelled");
    assert.equal(await advanceAccountDeletion(keeper), "cancelled", "the worker finds it cancelled");
    assert.equal((await db.select().from(usersTable).where(eq(usersTable.id, keeper))).length, 1);

    const leaver = await createUser();
    await acceptAccountDeletion(leaver, { requestedBy: "self", purgeAfter: past(), kick: false });
    await db.update(accountDeletionRequestsTable).set({ stage: "purging" }).where(eq(accountDeletionRequestsTable.userId, leaver));
    assert.equal(await cancelAccountDeletion(leaver, { notify: false }), "too_late", "a purge already running cannot be cancelled");
    assert.equal(await advanceAccountDeletion(leaver), "done");
  });

  it("subscriptions are cancelled at acceptance — past_due included, an already-cancelled one converging, a failure retried by the worker", async () => {
    const userId = await createUser();
    const sub = (ref: string, status: string) => ({
      userId, sourceType: "stripe_subscription" as const, providerRef: ref, isMembershipProduct: true, lifecycleStatus: status, sourceStateAsOf: 1,
    });
    await db.insert(membershipEntitlementsTable).values([sub(`sub_${randomUUID()}`, "past_due"), sub(`sub_${randomUUID()}`, "active")] as never);
    let failOnce = true;
    const { fake, calls } = fakeBilling((_, n) => {
      if (n === 1 && failOnce) { failOnce = false; throw new Error("Stripe is down"); }
      if (n === 3) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
    });
    restoreBilling = __setAccountDeletionBillingForTests(fake);
    await acceptAccountDeletion(userId, { requestedBy: "self", kick: false });

    await assert.rejects(advanceAccountDeletion(userId), /Stripe is down/);
    const [failed] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    assert.equal(failed!.stage, "accepted");
    assert.match(failed!.lastError ?? "", /Stripe is down/);

    const counts = await runAccountDeletionWorker({ userIds: [userId] });
    assert.equal(counts.failed, 0);
    const [row] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    assert.equal(row!.stage, "notified", "billing done and the person told");
    assert.ok(calls.filter((c) => c.startsWith("cancel:")).length >= 2, "both the past_due and the active subscription were cancelled");
    const left = await db.select({ status: membershipEntitlementsTable.lifecycleStatus }).from(membershipEntitlementsTable).where(eq(membershipEntitlementsTable.userId, userId));
    assert.ok(left.every((l) => l.status === "canceled"), "and both sources refreshed");
  });

  it("a purge decided for one request never claims its replacement", async () => {
    restoreBilling = __setAccountDeletionBillingForTests(fakeBilling().fake);
    const userId = await createUser();
    await acceptAccountDeletion(userId, { requestedBy: "self", purgeAfter: past(), kick: false });
    // Between the old request's purge decision and its claim, the person keeps
    // the account and asks again; the replacement reaches notified.
    const restoreHook = __setBeforePurgeClaimForTests(async (id) => {
      restoreHook();
      assert.equal(await cancelAccountDeletion(id, { notify: false }), "cancelled");
      await acceptAccountDeletion(id, { requestedBy: "self", kick: false, now: new Date(Date.now() + 5) });
      assert.equal(await advanceAccountDeletion(id), "notified");
    });
    try {
      assert.equal(await advanceAccountDeletion(userId), "notified", "the stale claim does not land; the replacement waits its 14 days");
    } finally {
      restoreHook();
    }
    const [row] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    assert.equal(row!.stage, "notified");
    assert.ok(row!.purgeAfter.getTime() > Date.now() + 13 * 86_400_000);
    assert.equal((await db.select().from(usersTable).where(eq(usersTable.id, userId))).length, 1);
  });

  it("a subscription refresh that did not apply keeps the stage, and keeping the account still settles it", async () => {
    const userId = await createUser();
    await db.insert(membershipEntitlementsTable).values([subscription(userId)] as never);
    const { fake } = fakeBilling(() => {}, (n) => n > 1);
    restoreBilling = __setAccountDeletionBillingForTests(fake);
    await acceptAccountDeletion(userId, { requestedBy: "self", kick: false });
    await assert.rejects(advanceAccountDeletion(userId), /not applied \(source_busy\)/);
    const [stuck] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    assert.equal(stuck!.stage, "accepted", "a refresh that did not apply is not done");
    assert.equal(stuck!.billingUnsettled, true);

    // The person keeps the account before the worker retries: the engine still owes the refresh.
    assert.equal(await cancelAccountDeletion(userId, { notify: false }), "cancelled");
    await runAccountDeletionWorker({ userIds: [userId] });
    const [settled] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    assert.equal(settled!.billingUnsettled, false);
    const [source] = await db.select({ status: membershipEntitlementsTable.lifecycleStatus }).from(membershipEntitlementsTable).where(eq(membershipEntitlementsTable.userId, userId));
    assert.equal(source!.status, "canceled", "the cancelled subscription no longer grants access");
  });

  it("keeping the account during an in-flight Stripe cancel cannot settle billing on a pre-cancel look", async () => {
    const userId = await createUser();
    const [source] = await db.insert(membershipEntitlementsTable).values([subscription(userId)] as never).returning({ ref: membershipEntitlementsTable.providerRef });
    const ref = source!.ref!;
    const stripe = new Map<string, string>([[ref, "active"]]);
    let failEngineRefresh = true;
    let settleObserved!: () => void;
    const observed = new Promise<void>((r) => { settleObserved = r; });
    let engineRefreshStarted!: () => void;
    const engineStarted = new Promise<void>((r) => { engineRefreshStarted = r; });
    let settles: Promise<unknown> = Promise.resolve();
    // A fake that models Stripe: the subscription is active until cancel returns.
    restoreBilling = __setAccountDeletionBillingForTests({
      async cancel(id) {
        // While the cancel is in flight the person keeps the account; the
        // worker's settlement observes Stripe still active...
        assert.equal(await cancelAccountDeletion(userId, { notify: false }), "cancelled");
        settles = runAccountDeletionWorker({ userIds: [userId] });
        await observed;
        stripe.set(id, "canceled");
      },
      async refresh(id) {
        const state = stripe.get(id)!;
        if (state === "active") {
          // ...and its clear lands only after the engine has marked the
          // returned cancel and started its own refresh.
          await db.update(membershipEntitlementsTable).set({ lifecycleStatus: state }).where(eq(membershipEntitlementsTable.providerRef, id));
          settleObserved();
          await engineStarted;
          return { applied: true };
        }
        if (failEngineRefresh) { failEngineRefresh = false; engineRefreshStarted(); return { applied: false, reason: "retrieval_failed" }; }
        await db.update(membershipEntitlementsTable).set({ lifecycleStatus: state }).where(eq(membershipEntitlementsTable.providerRef, id));
        return { applied: true };
      },
    });
    await acceptAccountDeletion(userId, { requestedBy: "self", kick: false });
    await advanceAccountDeletion(userId).catch(() => undefined);
    await settles;
    await new Promise((r) => setTimeout(r, 50)); // the cancel's own kicked settlement

    const [mid] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    assert.ok(mid!.cancelledAt, "the account was kept");
    assert.equal(mid!.billingUnsettled, true, "a settlement that looked before the cancel returned does not clear the marker");

    await runAccountDeletionWorker({ userIds: [userId] });
    const [after] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    const [afterSource] = await db.select({ status: membershipEntitlementsTable.lifecycleStatus }).from(membershipEntitlementsTable).where(eq(membershipEntitlementsTable.providerRef, ref));
    assert.equal(afterSource!.status, "canceled", "the cancelled subscription stops granting access");
    assert.equal(after!.billingUnsettled, false);
  });

  it("acceptance waits for a content purge already holding the owner's lock", async () => {
    const userId = await createUser();
    let released = 0;
    const holder = db.transaction(async (tx) => {
      await lockOwnerContent(tx, userId);
      await new Promise((r) => setTimeout(r, 300));
      released = Date.now();
    });
    await new Promise((r) => setTimeout(r, 50));
    await acceptAccountDeletion(userId, { requestedBy: "self", kick: false });
    const accepted = Date.now();
    await holder;
    assert.ok(released > 0 && accepted >= released, "acceptance committed only after the purge's lock was released");
  });

  it("an open billing dispute holds the account purge and the content purger alike", async () => {
    restoreBilling = __setAccountDeletionBillingForTests(fakeBilling().fake);
    const userId = await createUser();
    const trash = await photos.seed(userId);
    await db.update(uploadImageMetadataTable).set({ deletedAt: past(), purgeAfter: past() }).where(eq(uploadImageMetadataTable.objectPath, trash));
    const [source] = await db.insert(membershipEntitlementsTable)
      .values({ userId, sourceType: "stripe_lifetime_payment", providerRef: `pi_${randomUUID()}`, isMembershipProduct: true, lifecycleStatus: "active", sourceStateAsOf: 1 } as never)
      .returning({ id: membershipEntitlementsTable.id });
    await db.insert(entitlementSourceDisputesTable).values({ stripeDisputeId: `dp_${randomUUID()}`, sourceId: source!.id, status: "needs_response", isTerminal: false });

    await acceptAccountDeletion(userId, { requestedBy: "self", purgeAfter: past(), kick: false });
    assert.equal(await advanceAccountDeletion(userId), "held");
    const [row] = await db.select().from(accountDeletionRequestsTable).where(eq(accountDeletionRequestsTable.userId, userId));
    assert.match(row!.holdReason ?? "", /dispute/);
    assert.equal((await db.select().from(usersTable).where(eq(usersTable.id, userId))).length, 1, "the account survives the hold");

    const purge = await runContentPurger({ photoPaths: [trash] });
    assert.equal(purge.photos.purged, 0, "a trash candidate of a held account is not destroyed");
    assert.equal(await objectExists(trash), true);
  });

  it("the purge removes the person's files and rows, keeps facts and safety records, recounts what survives, and keeps a fact gallery's background", async () => {
    restoreBilling = __setAccountDeletionBillingForTests(fakeBilling().fake);
    const userId = await createUser();
    const other = await createUser();
    const standalone = await photos.seed(userId);
    const memeSource = await photos.seed(userId);
    const saved = await createMemeRecord({ userId, factId, imageSource: { type: "upload", uploadKey: memeSource }, textOptions: {}, aspectRatio: "landscape", decisions: ALLOW_ALL });
    const othersMeme = await createMemeRecord({ userId: other, factId, imageSource: { type: "upload", uploadKey: await photos.seed(other) }, textOptions: {}, aspectRatio: "landscape", decisions: ALLOW_ALL });
    const othersMemeId = await memeIdOf(othersMeme.permalinkSlug);
    await db.insert(reactionsTable).values({ userId, targetType: "meme", targetId: othersMemeId, reactionType: "heart" });
    await db.update(memesTable).set({ heartCount: 1 }).where(eq(memesTable.id, othersMemeId));
    const [ownFact] = await db.insert(factsTable)
      .values({ text: `${PREFIX}{NAME} submitted`, isActive: true, enrichment: buildPlaceholderFactEnrichment(), canonicalText: `${PREFIX}submitted`, submittedById: userId })
      .returning();
    factIds.push(ownFact!.id);
    await db.insert(commentsTable).values({ factId, authorId: userId, text: `${PREFIX}comment` });
    const shared = await new ObjectStorageService().uploadObjectBuffer({ subPath: `ai-images/t_p5del_${randomUUID()}.jpg`, buffer: solidJpeg(32, 32), contentType: "image/jpeg" });
    await db.update(factsTable).set({ aiMemeImages: { neutral: [shared] } }).where(eq(factsTable.id, factId));
    await db.insert(userAiImagesTable).values({ userId, factId, gender: "neutral", storagePath: shared, imageType: "reference" });
    const [report] = await db.insert(ncmecReportsTable).values({ userId, matchSource: "arachnid", evidenceUri: `/objects/restricted/t_p5del_${randomUUID()}` }).returning();

    await acceptAccountDeletion(userId, { requestedBy: "self", purgeAfter: past(), kick: false });
    assert.equal(await advanceAccountDeletion(userId), "done");

    assert.equal((await db.select().from(usersTable).where(eq(usersTable.id, userId))).length, 0, "the account is gone");
    assert.equal(await objectExists(standalone), false, "a standalone upload is collected");
    assert.equal(await objectExists(memeSource), false);
    assert.equal(await objectExists(`/objects/${memeKey(saved.permalinkSlug, "jpg")}`), false, "the meme's own file is gone");
    assert.equal((await db.select().from(memesTable).where(eq(memesTable.permalinkSlug, saved.permalinkSlug))).length, 0);
    assert.equal((await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, standalone))).length, 0);
    assert.equal((await db.select().from(commentsTable).where(eq(commentsTable.authorId, userId))).length, 0);
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, ownFact!.id));
    assert.equal(fact!.submittedById, null, "the fact stays");
    assert.ok(fact!.submitterDeletedAt, "credited to a former member");
    const [survivor] = await db.select({ heartCount: memesTable.heartCount }).from(memesTable).where(eq(memesTable.id, othersMemeId));
    assert.equal(survivor!.heartCount, 0, "another member's meme is recounted without the person's heart");
    assert.equal(await objectExists(shared), true, "a fact gallery's background is everyone's and stays");
    const [kept] = await db.select().from(ncmecReportsTable).where(eq(ncmecReportsTable.id, report!.id));
    assert.ok(kept, "the safety record survives");
    assert.equal(kept!.userId, null, "with the person set null");
    await db.delete(ncmecReportsTable).where(eq(ncmecReportsTable.id, report!.id));
  });

  it("the admin's hard delete purges now through the engine, and a departing administrator no longer counts as reachable", async () => {
    restoreBilling = __setAccountDeletionBillingForTests(fakeBilling().fake);
    const admin = await createUser({ admin: true });
    const target = await createUser();
    const adminSid = await sessionFor(admin, { isAdmin: true });
    const res = await request(makeApp()).delete(`/api/admin/users/${target}?hard=true`).set("authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.deleted, true);
    assert.equal((await db.select().from(usersTable).where(eq(usersTable.id, target))).length, 0);

    // An administrator whose deletion is pending no longer counts as one who
    // can reach the console, so removing the remaining ones is weighed without it.
    const leavingAdmin = await createUser({ admin: true });
    const reachable = async () => (await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, leavingAdmin), isReachableAdminSql()))).length;
    assert.equal(await reachable(), 1);
    await acceptAccountDeletion(leavingAdmin, { requestedBy: "self", kick: false });
    assert.equal(await reachable(), 0, "a departing administrator is not a reachable one");
  });
});
