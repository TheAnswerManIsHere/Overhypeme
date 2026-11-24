/**
 * @purpose Image-surface audit R9 (#875): an admin takes down a member's meme or photo. It leaves every surface at once, its owner cannot restore it, the purger removes it on its next run, a taken-down profile photo leaves the account, quarantined content is never touched, every takedown is recorded, and only an admin can do it.
 * @subsystem studio
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { adminActionsTable, factsTable, memesTable, uploadImageMetadataTable, usersTable } from "@workspace/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";

import memesRouter from "../routes/memes.js";
import usersRouter from "../routes/users.js";
import adminProvenanceRouter from "../routes/adminProvenance.js";
import { createMemeRecord, type MemeAuthorizationDecisions } from "../lib/createMemeRecord.js";
import { runContentPurger } from "../jobs/contentPurger.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";

const PREFIX = "t-takedown-";
const ALLOW_ALL: MemeAuthorizationDecisions = { meme_private_visibility: true, meme_rate_limit_high: true };
const factIds: number[] = [];

async function createUser(name: string, isAdmin = false): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, displayName: name, pronouns: "they/them", membershipTier: "legendary", isAdmin });
  return id;
}

async function cleanup(): Promise<void> {
  await db.delete(adminActionsTable).where(like(adminActionsTable.actorId, `${PREFIX}%`));
  await db.delete(memesTable).where(like(memesTable.createdById, `${PREFIX}%`));
  await db.delete(uploadImageMetadataTable).where(like(uploadImageMetadataTable.userId, `${PREFIX}%`));
  if (factIds.length > 0) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

function app(userId: string | null): express.Express {
  const auth = userId ? { kind: "authenticated" as const, userId } : { kind: "unauthenticated" as const };
  return buildTestApp(auth, express.Router().use(usersRouter, memesRouter, adminProvenanceRouter));
}

describe("admin takedown of a member's meme or photo (#875 R9)", () => {
  const photos = photoBackgrounds();
  let owner: string;
  let admin: string;
  let factId: number;
  const takedown = (who: string | null, body: unknown) => request(app(who)).post("/api/admin/content/takedown").send(body as object);

  before(async () => {
    photos.setUp();
    await cleanup();
    owner = await createUser("Owner");
    admin = await createUser("Admin", true);
    const row = await insertLiveFact({ text: `${PREFIX}{NAME} folds time`, enrichment: buildPlaceholderFactEnrichment(), canonicalText: `${PREFIX}They fold time`, aiMemeImages: null }, buildPlaceholderGag());
    factIds.push(row!.id);
    factId = row!.id;
  });
  after(async () => {
    await cleanup();
    await photos.tearDown();
  });

  it("only an admin can take content down, with a reason", async () => {
    const saved = await createMemeRecord({ userId: owner, factId, imageSource: { type: "upload", uploadKey: await photos.seed(owner) }, textOptions: { topText: "{NAME}" }, aspectRatio: "square", decisions: ALLOW_ALL });
    assert.equal((await takedown(null, { kind: "meme", key: saved.permalinkSlug, reason: "spam" })).status, 401);
    assert.equal((await takedown(owner, { kind: "meme", key: saved.permalinkSlug, reason: "spam" })).status, 403);
    assert.equal((await takedown(admin, { kind: "meme", key: saved.permalinkSlug })).status, 400, "a reason is required");
    assert.equal((await takedown(admin, { kind: "meme", key: "no-such-meme", reason: "spam" })).status, 404);
    assert.equal((await request(app(null)).get(`/api/memes/${saved.permalinkSlug}`)).status, 200, "nothing changed");
  });

  it("a taken-down meme leaves every surface, cannot be restored, is purged, and the takedown is recorded", async () => {
    const saved = await createMemeRecord({ userId: owner, factId, imageSource: { type: "upload", uploadKey: await photos.seed(owner) }, textOptions: { topText: "{NAME}" }, aspectRatio: "square", decisions: ALLOW_ALL });
    assert.equal((await takedown(admin, { kind: "meme", key: saved.permalinkSlug, reason: "harassment report" })).status, 200);

    const page = await request(app(null)).get(`/api/memes/${saved.permalinkSlug}`);
    assert.equal(page.status, 410, "gone for visitors");
    assert.equal(page.body.error, "This meme has been removed.", "and the page does not say its creator removed it");
    assert.equal((await request(app(null)).get(`/api/memes/${saved.permalinkSlug}/image`)).status, 404, "its image too");
    const deleted = (await request(app(owner)).get("/api/users/me/recently-deleted")).body.items as Array<{ key: string }>;
    assert.ok(!deleted.some((i) => i.key === saved.permalinkSlug), "not in its owner's Recently deleted");
    assert.equal((await request(app(owner)).post(`/api/memes/${saved.permalinkSlug}/restore`)).status, 404, "its owner cannot restore it");

    const [row] = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.permalinkSlug, saved.permalinkSlug));
    const result = await runContentPurger({ memeIds: [row!.id] });
    assert.equal(result.memes.purged, 1, "the purger removes it");

    const [action] = await db.select().from(adminActionsTable).where(and(eq(adminActionsTable.actorId, admin), eq(adminActionsTable.action, "content_takedown"), eq(adminActionsTable.factId, factId)));
    assert.ok(action, "recorded against its fact");
    assert.deepEqual(
      { kind: action!.detail["kind"], key: action!.detail["key"], ownerId: action!.detail["ownerId"], reason: action!.detail["reason"] },
      { kind: "meme", key: saved.permalinkSlug, ownerId: owner, reason: "harassment report" },
    );
    assert.equal((await takedown(admin, { kind: "meme", key: saved.permalinkSlug, reason: "again" })).status, 404, "a second takedown finds nothing");
  });

  it("a meme its owner already deleted can still be taken down, ending its restore window", async () => {
    const saved = await createMemeRecord({ userId: owner, factId, imageSource: { type: "upload", uploadKey: await photos.seed(owner) }, textOptions: { topText: "{NAME}" }, aspectRatio: "square", decisions: ALLOW_ALL });
    assert.equal((await request(app(owner)).delete(`/api/memes/${saved.permalinkSlug}`)).status, 200);
    assert.equal((await takedown(admin, { kind: "meme", key: saved.permalinkSlug, reason: "reported" })).status, 200);
    assert.equal((await request(app(owner)).post(`/api/memes/${saved.permalinkSlug}/restore`)).status, 404);
  });

  it("a taken-down profile photo leaves the account and its derivatives go with it", async () => {
    const photo = await photos.seed(owner);
    const derivative = await photos.seed(owner);
    await db.update(uploadImageMetadataTable).set({ isProfile: true }).where(eq(uploadImageMetadataTable.objectPath, photo));
    await db.update(uploadImageMetadataTable).set({ sourceObjectPath: photo, transform: "crop" }).where(eq(uploadImageMetadataTable.objectPath, derivative)).catch(() => undefined);
    await db.update(usersTable).set({ profileImageUrl: `/api/storage${photo}` }).where(eq(usersTable.id, owner));

    const res = await takedown(admin, { kind: "photo", key: photo, reason: "not a person" });
    assert.equal(res.status, 200);
    assert.equal(res.body.wasProfile, true);
    const [user] = await db.select({ profileImageUrl: usersTable.profileImageUrl }).from(usersTable).where(eq(usersTable.id, owner));
    assert.equal(user!.profileImageUrl, null, "the account shows no picture");
    const [row] = await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, photo));
    assert.equal(row!.isProfile, false);
    assert.ok(row!.deletedAt && row!.purgeAfter && row!.purgeAfter.getTime() <= Date.now(), "past its window at once");
    assert.equal((await request(app(owner)).post("/api/users/me/uploads/restore").send({ path: photo })).status, 404, "its owner cannot restore it");
  });

  it("quarantined content is never taken down: it is held as evidence", async () => {
    const photo = await photos.seed(owner);
    await db.update(uploadImageMetadataTable).set({ arachnidMatchType: "exact" }).where(eq(uploadImageMetadataTable.objectPath, photo));
    assert.equal((await takedown(admin, { kind: "photo", key: photo, reason: "reported" })).status, 404);
    const [row] = await db.select({ deletedAt: uploadImageMetadataTable.deletedAt }).from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, photo));
    assert.equal(row!.deletedAt, null, "untouched");
  });
});
