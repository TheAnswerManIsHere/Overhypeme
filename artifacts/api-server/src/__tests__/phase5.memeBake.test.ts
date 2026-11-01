/**
 * @purpose Proves a meme is a file from the moment it is saved (launch Phase 5, plan S16, T4's bake parts): the save stores the JPEG and sets baked_at, the image route serves exactly those bytes, and goes on serving them after the source photo is deleted; the boot backfill bakes a recipe meme saved before baking, serves bytes equal to the renderer's for that recipe, skips deleted and quarantined memes, and is a no-op on a second run; a recipe meme not yet baked is still served by the live render.
 * @subsystem studio
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { db } from "@workspace/db";
import { factsTable, memesTable, usersTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import memesRouter from "../routes/memes.js";
import { createMemeRecord, type MemeAuthorizationDecisions } from "../lib/createMemeRecord.js";
import { backfillMemeBakes, renderMemeRecipe, renderStoredMeme } from "../lib/memeBake.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { memeKey } from "../lib/storageKeys.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";

const PREFIX = "t-p5bake-";
const ALLOW_ALL: MemeAuthorizationDecisions = { meme_private_visibility: true, meme_rate_limit_high: true };
const factIds: number[] = [];

async function createUser(): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, displayName: "Bakey", pronouns: "they/them", membershipTier: "legendary" });
  return id;
}

async function createFact(): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text: `${PREFIX}{NAME} bakes the sun`, isActive: true, enrichment: buildPlaceholderFactEnrichment(), canonicalText: `${PREFIX}They bake the sun` })
    .returning();
  factIds.push(row!.id);
  return row!.id;
}

async function cleanup(): Promise<void> {
  await db.delete(memesTable).where(like(memesTable.createdById, `${PREFIX}%`));
  if (factIds.length > 0) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

async function storedBytes(slug: string): Promise<Buffer> {
  const storage = new ObjectStorageService();
  const file = await storage.getObjectEntityFile(`/objects/${memeKey(slug, "jpg")}`);
  return Buffer.from(await (await storage.downloadObject(file)).arrayBuffer());
}

/** Removes a photo from the local storage double, as a purged photo is gone. */
function deletePhoto(uploadKey: string): void {
  const root = process.env.STORAGE_DOUBLE_DIR!;
  const rel = path.join("test-bucket", "private", uploadKey.replace(/^\/objects\//, ""));
  fs.rmSync(path.join(root, "data", rel), { force: true });
  fs.rmSync(path.join(root, "meta", `${rel}.json`), { force: true });
}

const getImage = (slug: string) =>
  request(buildTestApp({ kind: "unauthenticated" }, memesRouter)).get(`/api/memes/${slug}/image`).buffer(true);

describe("a meme is a file from the moment it is saved (S16)", () => {
  const photos = photoBackgrounds();
  let userId: string;
  let factId: number;
  before(async () => {
    photos.setUp();
    await cleanup();
    userId = await createUser();
    factId = await createFact();
  });
  after(async () => {
    await cleanup();
    await photos.tearDown();
  });

  it("the save stores the JPEG, sets baked_at, and the route serves those bytes, before and after the photo is deleted", async () => {
    const uploadKey = await photos.seed(userId);
    const textOptions = { topText: "{NAME} bakes", bottomText: "the sun" };
    const saved = await createMemeRecord({
      userId, factId, imageSource: { type: "upload", uploadKey }, textOptions, aspectRatio: "landscape", decisions: ALLOW_ALL,
    });
    const [row] = await db.select().from(memesTable).where(eq(memesTable.permalinkSlug, saved.permalinkSlug));
    assert.ok(row!.bakedAt, "baked_at is set at save");
    assert.deepEqual(row!.imageSource, { type: "upload", uploadKey }, "the recipe stays as metadata");

    const stored = await storedBytes(saved.permalinkSlug);
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    const expected = await renderMemeRecipe({
      fact, creator: { displayName: "Bakey", pronouns: "they/them" }, textOptions,
      imageSource: { type: "upload", uploadKey }, aspectRatio: "landscape", framingTransform: null,
    });
    assert.ok(stored.equals(expected), "the stored file is the renderer's output for the recipe and the saver's identity");

    const first = await getImage(saved.permalinkSlug);
    assert.equal(first.status, 200);
    assert.ok(Buffer.from(first.body).equals(stored), "the route serves the stored file");

    deletePhoto(uploadKey);
    const after = await getImage(saved.permalinkSlug);
    assert.equal(after.status, 200, "the meme does not depend on its photo");
    assert.ok(Buffer.from(after.body).equals(stored), "byte-identical after the photo is gone");
  });

  it("the backfill bakes a recipe meme saved before baking, skips deleted and quarantined ones, and is a no-op on re-run", async () => {
    const uploadKey = await photos.seed(userId);
    const recipe = { factId, createdById: userId, templateId: "photo_upload", imageSource: { type: "upload", uploadKey }, textOptions: { topText: "{NAME} was here", bottomText: "" }, aspectRatio: "square" };
    const slug = (tag: string) => `${PREFIX.slice(2, 8)}${tag}${randomUUID().slice(0, 4)}`;
    const [live, deleted, quarantined] = await db
      .insert(memesTable)
      .values([
        { ...recipe, permalinkSlug: slug("L"), imageUrl: "/x" },
        { ...recipe, permalinkSlug: slug("D"), imageUrl: "/x", deletedAt: new Date() },
        { ...recipe, permalinkSlug: slug("Q"), imageUrl: "/x", status: "quarantined" },
      ] as never)
      .returning();
    const ids = [live!.id, deleted!.id, quarantined!.id];

    // Before the backfill the meme is served by the live render.
    const expected = await renderStoredMeme(live!);
    const before = await getImage(live!.permalinkSlug);
    assert.equal(before.status, 200);
    assert.ok(Buffer.from(before.body).equals(expected), "an unbaked recipe meme is rendered live");

    assert.deepEqual(await backfillMemeBakes({ ids }), { selected: 1, baked: 1, failed: 0 });
    const rows = await db.select().from(memesTable).where(inArray(memesTable.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.ok(byId.get(live!.id)!.bakedAt, "the live recipe meme is baked");
    assert.equal(byId.get(deleted!.id)!.bakedAt, null, "a deleted meme is not baked");
    assert.equal(byId.get(quarantined!.id)!.bakedAt, null, "a quarantined meme is not baked");

    assert.ok((await storedBytes(live!.permalinkSlug)).equals(expected), "the baked file is the renderer's output for the recipe");
    const served = await getImage(live!.permalinkSlug);
    assert.ok(Buffer.from(served.body).equals(expected), "and the route now serves it");

    assert.deepEqual(await backfillMemeBakes({ ids }), { selected: 0, baked: 0, failed: 0 }, "a second run is a no-op");
  });
});
