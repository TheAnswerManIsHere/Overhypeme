/**
 * @purpose T4, content visibility (launch Phase 5, plan S2/S14/S17/S18): content its owner deleted leaves every listing, serving, rendering, OG, share and reuse path at once and waits in Recently deleted, served to no one but its owner; a restore inside the window puts it back; the purger removes it after the window (objects through preserve, then the row), never touches a pre-window tombstone, a shared fact background's file, or the photo a meme was made from, and is a no-op on re-run; a meme whose photo is deleted and purged still serves byte-identical. Also the class guard: no reader spells the live test itself.
 * @subsystem studio
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { factsTable, memesTable, uploadImageMetadataTable, userAiImagesTable, usersTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import memesRouter from "../routes/memes.js";
import usersRouter from "../routes/users.js";
import storageRouter from "../routes/storage.js";
import ogRouter from "../routes/og.js";
import shareIntentsRouter from "../routes/shareIntents.js";
import { createMemeRecord, type CreateMemeError, type MemeAuthorizationDecisions } from "../lib/createMemeRecord.js";
import { userOwnsUpload } from "../lib/uploadOwnership.js";
import { runContentPurger } from "../jobs/contentPurger.js";
import { listAiImagesPage, listMemesPage, listUploadsPage } from "../lib/myContent.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { memeKey } from "../lib/storageKeys.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { photoBackgrounds, solidJpeg } from "./helpers/photoBackground.js";

const PREFIX = "t-p5vis-";
const ALLOW_ALL: MemeAuthorizationDecisions = { meme_private_visibility: true, meme_rate_limit_high: true };
const factIds: number[] = [];

async function createUser(name: string): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, displayName: name, pronouns: "they/them", membershipTier: "legendary" });
  return id;
}

async function createFact(gallery: Record<string, string[]> | null = null): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text: `${PREFIX}{NAME} folds time`, isActive: true, enrichment: buildPlaceholderFactEnrichment(), canonicalText: `${PREFIX}They fold time`, aiMemeImages: gallery })
    .returning();
  factIds.push(row!.id);
  return row!.id;
}

async function cleanup(): Promise<void> {
  await db.delete(memesTable).where(like(memesTable.createdById, `${PREFIX}%`));
  await db.delete(userAiImagesTable).where(like(userAiImagesTable.userId, `${PREFIX}%`));
  await db.delete(uploadImageMetadataTable).where(like(uploadImageMetadataTable.userId, `${PREFIX}%`));
  if (factIds.length > 0) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

/** One app with every router a content path runs through, signed in as `userId` (or no one). */
function app(userId: string | null): express.Express {
  const auth = userId ? { kind: "authenticated" as const, userId } : { kind: "unauthenticated" as const };
  const a = buildTestApp(auth, express.Router().use(usersRouter, memesRouter, storageRouter, shareIntentsRouter));
  a.use(ogRouter);
  return a;
}

async function objectExists(objectPath: string): Promise<boolean> {
  return new ObjectStorageService().getObjectEntityFile(objectPath).then(() => true, () => false);
}

/** A saved meme's row id (the save answers with its slug). */
async function memeId(slug: string): Promise<number> {
  const [row] = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.permalinkSlug, slug));
  return row!.id;
}

async function storeObject(subPath: string): Promise<string> {
  return new ObjectStorageService().uploadObjectBuffer({ subPath, buffer: solidJpeg(64, 64), contentType: "image/jpeg" });
}

const past = () => new Date(Date.now() - 60_000);

describe("content visibility (T4)", () => {
  const photos = photoBackgrounds();
  let owner: string;
  let other: string;
  let factId: number;

  before(async () => {
    photos.setUp();
    await cleanup();
    owner = await createUser("Owner");
    other = await createUser("Other");
    factId = await createFact();
  });
  after(async () => {
    await cleanup();
    await photos.tearDown();
  });

  it("a deleted photo leaves the listing, the builder and the byte path, shows in Recently deleted to its owner only, and a restore puts it back", async () => {
    const path_ = await photos.seed(owner);
    // A real upload is stored with its owner's private ACL. Without one the
    // read takes the legacy fallback, whose background ACL heal can race the
    // read in the storage double.
    await new ObjectStorageService().trySetObjectEntityAclPolicy(path_, { owner, visibility: "private" });
    const listed = async () => ((await request(app(owner)).get("/api/users/me/uploads")).body.uploads as Array<{ objectPath: string }>).map((u) => u.objectPath);
    assert.ok((await listed()).includes(path_));

    const del = await request(app(owner)).delete(`/api/users/me/uploads?path=${encodeURIComponent(path_)}`);
    assert.equal(del.status, 200);
    assert.ok(!(await listed()).includes(path_), "gone from the listing");
    assert.equal(await userOwnsUpload(path_, owner), false, "not the owner's to build with");
    const save = await createMemeRecord({ userId: owner, factId, imageSource: { type: "upload", uploadKey: path_ }, textOptions: {}, aspectRatio: "landscape", decisions: ALLOW_ALL }).then(() => null, (e: CreateMemeError) => e);
    assert.equal(save?.status, 403, "a meme cannot be saved from it");

    const byteUrl = `/api/storage${path_}`;
    assert.equal((await request(app(other)).get(byteUrl)).status, 404, "another member is refused like a missing object");
    assert.equal((await request(app(null)).get(byteUrl)).status, 404, "so is a visitor");
    const own = await request(app(owner)).get(byteUrl);
    assert.equal(own.status, 200, "its owner still sees it, to choose what to restore");
    assert.match(String(own.headers["cache-control"]), /no-store/, "and never into a shared cache");

    const deleted = await request(app(owner)).get("/api/users/me/recently-deleted");
    const item = (deleted.body.items as Array<{ kind: string; key: string; purgeAfter: string }>).find((i) => i.key === path_);
    assert.equal(item?.kind, "photo");
    const days = (Date.parse(item!.purgeAfter) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, `purge after the 30-day window (got ${days.toFixed(2)} days)`);
    assert.equal(deleted.body.restoreWindowDays, 30);
    assert.equal(((await request(app(other)).get("/api/users/me/recently-deleted")).body.items as unknown[]).length, 0, "no one else's");

    assert.equal((await request(app(other)).post("/api/users/me/uploads/restore").send({ path: path_ })).status, 404, "only the owner restores");
    assert.equal((await request(app(owner)).post("/api/users/me/uploads/restore").send({ path: path_ })).status, 200);
    assert.ok((await listed()).includes(path_), "back in the listing");
    assert.equal(await userOwnsUpload(path_, owner), true);
    assert.equal((await request(app(other)).get(byteUrl)).status, 403, "back under its ACL: private to its owner, as before");
  });

  it("My content's lists page by cursor: every live item once, the profile photo first, deleted items never", async () => {
    const pager = await createUser("Pager");
    const keys = [await photos.seed(pager), await photos.seed(pager), await photos.seed(pager), await photos.seed(pager)];
    await db.update(uploadImageMetadataTable).set({ isProfile: true }).where(eq(uploadImageMetadataTable.objectPath, keys[2]!));
    await db.update(uploadImageMetadataTable).set({ deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000) }).where(eq(uploadImageMetadataTable.objectPath, keys[3]!));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listUploadsPage(pager, { transform: "raw", factId: null, cursor, limit: 1 });
      seen.push(...page.items.map((u) => u.objectPath));
      assert.equal(page.total, 3, "the count is of live photos");
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen[0], keys[2], "the profile photo first");
    assert.deepEqual([...seen].sort(), [keys[0], keys[1], keys[2]].sort(), "each live photo exactly once, the deleted one never");

    const slugs: string[] = [];
    for (let n = 0; n < 3; n++) {
      const saved = await createMemeRecord({ userId: pager, factId, imageSource: { type: "upload", uploadKey: keys[0]! }, textOptions: { topText: `page ${n}` }, aspectRatio: "landscape", decisions: ALLOW_ALL });
      slugs.push(saved.permalinkSlug);
    }
    const first = await listMemesPage(pager, { limit: 2 });
    const second = await listMemesPage(pager, { limit: 2, cursor: first.nextCursor! });
    assert.deepEqual([...first.items, ...second.items].map((m) => m.permalinkSlug), [...slugs].reverse(), "newest first, each once");
    assert.equal(second.nextCursor, null, "the last page says so");
    assert.equal((await listAiImagesPage(pager, { imageType: "reference", factId: null, limit: 2 })).nextCursor, null);
  });

  it("the profile photo cannot be deleted while it is the profile photo", async () => {
    const path_ = await photos.seed(owner);
    await db.update(uploadImageMetadataTable).set({ isProfile: true }).where(eq(uploadImageMetadataTable.objectPath, path_));
    const res = await request(app(owner)).delete(`/api/users/me/uploads?path=${encodeURIComponent(path_)}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "profile_photo");
    await db.update(uploadImageMetadataTable).set({ isProfile: false }).where(eq(uploadImageMetadataTable.objectPath, path_));
  });

  it("a deleted meme leaves its page, its image, the fact's listing, My content, OG and sharing; its creator still sees it; a restore brings it all back", async () => {
    const uploadKey = await photos.seed(owner);
    const saved = await createMemeRecord({ userId: owner, factId, imageSource: { type: "upload", uploadKey }, textOptions: { topText: "{NAME}" }, aspectRatio: "landscape", decisions: ALLOW_ALL });
    const slug = saved.permalinkSlug;
    const factListing = async () => ((await request(app(other)).get(`/api/facts/${factId}/memes?visibility=public`)).body.memes as Array<{ permalinkSlug: string }>).map((m) => m.permalinkSlug);
    const mine = async () => ((await request(app(owner)).get("/api/users/me/memes")).body.memes as Array<{ permalinkSlug: string }>).map((m) => m.permalinkSlug);
    assert.ok((await factListing()).includes(slug));

    assert.equal((await request(app(owner)).delete(`/api/memes/${slug}`)).status, 200);
    assert.equal((await request(app(other)).get(`/api/memes/${slug}`)).status, 410, "its page says it was removed");
    assert.equal((await request(app(null)).get(`/api/memes/${slug}/image`)).status, 404, "its image is refused to a visitor");
    assert.equal((await request(app(other)).get(`/api/memes/${slug}/image`)).status, 404, "and to another member");
    assert.equal((await request(app(other)).get(`/api/storage/objects/${memeKey(slug, "jpg")}`)).status, 404, "its file, read directly, too");
    const ownImage = await request(app(owner)).get(`/api/memes/${slug}/image`);
    assert.equal(ownImage.status, 200, "its creator sees it in Recently deleted");
    assert.match(String(ownImage.headers["cache-control"]), /no-store/);
    assert.ok(!(await factListing()).includes(slug), "gone from the fact's memes");
    assert.ok(!(await mine()).includes(slug), "gone from My content");
    assert.equal((await request(app(null)).get(`/og/m/${slug}`)).status, 410, "the link preview is the removed card");
    assert.equal((await request(app(owner)).post("/api/share-intents").send({ memeId: slug, platform: "copy_link" })).status, 410, "it cannot be shared");
    assert.equal((await request(app(other)).post(`/api/memes/${await memeId(slug)}/heart`)).status, 404, "nor hearted");
    assert.ok(await userOwnsUpload(uploadKey, owner), "its photo is untouched (S14)");

    assert.equal((await request(app(other)).post(`/api/memes/${slug}/restore`)).status, 404, "only its creator restores it");
    assert.equal((await request(app(owner)).post(`/api/memes/${slug}/restore`)).status, 200);
    assert.equal((await request(app(other)).get(`/api/memes/${slug}`)).status, 200);
    assert.equal((await request(app(null)).get(`/api/memes/${slug}/image`)).status, 200);
    assert.ok((await factListing()).includes(slug));
    assert.ok((await mine()).includes(slug));
  });

  it("a deleted legacy meme's file is refused under every key form it can sit under", async () => {
    const slug = `p5vleg${randomUUID().slice(0, 6)}`;
    const legacyPath = await storeObject(`memes/${slug}.jpg`);
    await new ObjectStorageService().trySetObjectEntityAclPolicy(legacyPath, { owner, visibility: "public" });
    const [legacy] = await db.insert(memesTable).values({
      factId, createdById: owner, templateId: "legacy", imageUrl: `/api/memes/${slug}/image`, permalinkSlug: slug, isPublic: true,
    } as never).returning();
    assert.equal((await request(app(other)).get(`/api/storage${legacyPath}`)).status, 200, "a live legacy meme's file is public");
    await db.update(memesTable).set({ deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000) }).where(eq(memesTable.id, legacy!.id));
    assert.equal((await request(app(other)).get(`/api/storage${legacyPath}`)).status, 404, "deleted, its legacy path is refused too");
    assert.equal((await request(app(null)).get(`/api/memes/${slug}/image`)).status, 404);
  });

  it("My content lists and deletes only the member's own generated images, never a shared fact background", async () => {
    const own = await storeObject(`ai-images/t_p5vis_own_${randomUUID()}.jpg`);
    const shared = await storeObject(`ai-images/t_p5vis_shared_${randomUUID()}.jpg`);
    const galleryFact = await createFact({ neutral: [shared] });
    const [ownRow, sharedRow] = await db.insert(userAiImagesTable).values([
      { userId: owner, factId: galleryFact, gender: "neutral", storagePath: own, imageType: "reference" },
      { userId: owner, factId: galleryFact, gender: "neutral", storagePath: shared, imageType: "reference" },
    ]).returning();
    const listed = async () => ((await request(app(owner)).get("/api/users/me/ai-images")).body.images as Array<{ id: number }>).map((i) => i.id);
    const ids = await listed();
    assert.ok(ids.includes(ownRow!.id), "the member's own image is listed");
    assert.ok(!ids.includes(sharedRow!.id), "the fact's background is not theirs to list");

    assert.equal((await request(app(owner)).delete(`/api/users/me/ai-images/${sharedRow!.id}`)).status, 404, "nor to delete");
    assert.equal((await request(app(owner)).delete(`/api/users/me/ai-images/${ownRow!.id}`)).status, 200);
    assert.ok(!(await listed()).includes(ownRow!.id));
    assert.equal((await request(app(other)).get(`/api/storage${own}`)).status, 404, "its file is refused to anyone else");
    const deleted = (await request(app(owner)).get("/api/users/me/recently-deleted")).body.items as Array<{ kind: string; key: string }>;
    assert.ok(deleted.some((i) => i.kind === "generated" && i.key === String(ownRow!.id)));
    assert.equal((await request(app(owner)).post(`/api/users/me/ai-images/${ownRow!.id}/restore`)).status, 200);
    assert.ok((await listed()).includes(ownRow!.id));
  });

  it("restore is refused after the window; a pre-window tombstone is neither listed nor purged", async () => {
    const expired = await photos.seed(owner);
    const tombstone = await photos.seed(owner);
    await db.update(uploadImageMetadataTable).set({ deletedAt: past(), purgeAfter: past() }).where(eq(uploadImageMetadataTable.objectPath, expired));
    await db.update(uploadImageMetadataTable).set({ deletedAt: past(), purgeAfter: null }).where(eq(uploadImageMetadataTable.objectPath, tombstone));

    assert.equal((await request(app(owner)).post("/api/users/me/uploads/restore").send({ path: expired })).status, 404, "the window has closed");
    const keys = ((await request(app(owner)).get("/api/users/me/recently-deleted")).body.items as Array<{ key: string }>).map((i) => i.key);
    assert.ok(!keys.includes(expired) && !keys.includes(tombstone), "neither is listed");

    const result = await runContentPurger({ photoPaths: [expired, tombstone] });
    assert.deepEqual(result.photos, { selected: 1, purged: 1, skipped: 0, failed: 0 }, "the tombstone is never selected");
    assert.equal(await objectExists(tombstone), true);
    const [row] = await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, tombstone));
    assert.ok(row, "the tombstone's row stays");
  });

  it("the purger removes a photo past its window, its object and row; a meme made from it still serves byte-identical; a re-run is a no-op", async () => {
    const uploadKey = await photos.seed(owner);
    const saved = await createMemeRecord({ userId: owner, factId, imageSource: { type: "upload", uploadKey }, textOptions: { topText: "{NAME}" }, aspectRatio: "square", decisions: ALLOW_ALL });
    const beforeBytes = Buffer.from((await request(app(null)).get(`/api/memes/${saved.permalinkSlug}/image`).buffer(true)).body);

    assert.equal((await request(app(owner)).delete(`/api/users/me/uploads?path=${encodeURIComponent(uploadKey)}`)).status, 200);
    const notYet = await runContentPurger({ photoPaths: [uploadKey] });
    assert.equal(notYet.photos.selected, 0, "nothing inside its window is touched");
    assert.equal(await objectExists(uploadKey), true);

    await db.update(uploadImageMetadataTable).set({ purgeAfter: past() }).where(eq(uploadImageMetadataTable.objectPath, uploadKey));
    assert.deepEqual((await runContentPurger({ photoPaths: [uploadKey] })).photos, { selected: 1, purged: 1, skipped: 0, failed: 0 });
    assert.equal(await objectExists(uploadKey), false, "its object is gone");
    assert.equal((await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, uploadKey))).length, 0, "and its row");

    const afterRes = await request(app(null)).get(`/api/memes/${saved.permalinkSlug}/image`).buffer(true);
    assert.equal(afterRes.status, 200);
    assert.ok(Buffer.from(afterRes.body).equals(beforeBytes), "the meme serves the same bytes with its photo purged");

    assert.deepEqual((await runContentPurger({ photoPaths: [uploadKey] })).photos, { selected: 0, purged: 0, skipped: 0, failed: 0 }, "a second run finds nothing");
  });

  it("the purger removes a meme past its window, its file and row, and leaves the photo it was made from", async () => {
    const uploadKey = await photos.seed(owner);
    const saved = await createMemeRecord({ userId: owner, factId, imageSource: { type: "upload", uploadKey }, textOptions: {}, aspectRatio: "landscape", decisions: ALLOW_ALL });
    const file = `/objects/${memeKey(saved.permalinkSlug, "jpg")}`;
    assert.equal(await objectExists(file), true);
    assert.equal((await request(app(owner)).delete(`/api/memes/${saved.permalinkSlug}`)).status, 200);
    const id = await memeId(saved.permalinkSlug);
    await db.update(memesTable).set({ purgeAfter: past() }).where(eq(memesTable.id, id));

    assert.deepEqual((await runContentPurger({ memeIds: [id] })).memes, { selected: 1, purged: 1, skipped: 0, failed: 0 });
    assert.equal(await objectExists(file), false, "its file is gone");
    assert.equal((await db.select().from(memesTable).where(eq(memesTable.id, id))).length, 0, "and its row");
    assert.equal(await objectExists(uploadKey), true, "its photo stays");
    assert.equal(await userOwnsUpload(uploadKey, owner), true);
  });

  it("the purger never deletes a file a fact gallery still serves, and a restore before it runs wins", async () => {
    const shared = await storeObject(`ai-images/t_p5vis_gal_${randomUUID()}.jpg`);
    const own = await storeObject(`ai-images/t_p5vis_mine_${randomUUID()}.jpg`);
    const galleryFact = await createFact({ male: [shared] });
    const [sharedRow, ownRow, restoredRow] = await db.insert(userAiImagesTable).values([
      { userId: owner, factId: galleryFact, gender: "male", storagePath: shared, imageType: "reference", deletedAt: past(), purgeAfter: past() },
      { userId: owner, factId: galleryFact, gender: "male", storagePath: own, imageType: "reference", deletedAt: past(), purgeAfter: past() },
      { userId: owner, factId: galleryFact, gender: "male", storagePath: own, imageType: "reference" },
    ]).returning();

    const result = await runContentPurger({ generatedIds: [sharedRow!.id, ownRow!.id, restoredRow!.id] });
    assert.deepEqual(result.generated, { selected: 2, purged: 2, skipped: 0, failed: 0 }, "the live row is not a candidate");
    assert.equal(await objectExists(shared), true, "the fact's background stays in storage");
    assert.equal(await objectExists(own), true, "a file another live row names stays too");
    const left = await db.select({ id: userAiImagesTable.id }).from(userAiImagesTable).where(inArray(userAiImagesTable.id, [sharedRow!.id, ownRow!.id, restoredRow!.id]));
    assert.deepEqual(left.map((r) => r.id), [restoredRow!.id], "the purged rows are gone; the live one stays");
  });
});

describe("the live rule has one statement (S2's class guard)", () => {
  it("no reader of the three content tables spells the deleted test itself", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    // Only the three content tables carry `deleted_at`, so any spelling of the
    // test, aliased or not, is one of theirs. seed.ts holds legacy DDL.
    const allowed = new Set(["lib/contentVisibility.ts", "lib/seed.ts"]);
    const spelled = /isNull\([^)]*\.deletedAt\s*\)|\bdeleted_at\s+IS\s+NULL/i;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(src, full).split(path.sep).join("/");
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (rel.endsWith(".ts") && !allowed.has(rel) && spelled.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(rel);
        }
      }
    };
    walk(src);
    assert.deepEqual(offenders, [], "use liveContent() from lib/contentVisibility.ts");
  });
});
