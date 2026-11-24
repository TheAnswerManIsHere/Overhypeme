/**
 * @purpose "Remove my picture" and a final takedown (plan PLAN_AVATAR_TAKEDOWN_AND_REMOVE.md, Issue #849, Q16 and Q17): removing returns the member to their initial, keeps every photo in their library (the former picture loses only its Profile marker, so it can be deleted), and turns Google's automatic picture off for good; an admin takedown of the profile photo does the same; a picture the member chooses afterwards still works and leaves the default off; a taken-down photo cannot be chosen, even by a selection that checked before the takedown; another member's picture is untouched.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import sharp from "sharp";

import { db } from "@workspace/db";
import { adminActionsTable, uploadImageMetadataTable, usersTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import usersRouter from "../routes/users.js";
import adminProvenanceRouter from "../routes/adminProvenance.js";
import { makeProfilePhoto, PhotoNotAvailableError, removeProfilePhoto } from "../lib/profilePhoto.js";
import { copyProviderPictureIn, type PictureFetcher } from "../lib/providerPicture.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";
import { acceptCurrentLegal } from "./helpers/legalAcceptance.js";

const PREFIX = "t-picremove-";
const GOOGLE = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";

async function member(isAdmin = false): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  const now = new Date();
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, displayName: "Pat", pronouns: "they/them", isAdmin,
    emailVerifiedAt: now, onboardingCompletedAt: now, dateOfBirth: "1990-05-05",
  });
  await acceptCurrentLegal(id);
  return id;
}

const userRow = async (id: string) => (await db.select().from(usersTable).where(eq(usersTable.id, id)))[0]!;
const uploadRow = async (p: string) => (await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, p)))[0]!;

function app(userId: string | null): express.Express {
  const auth = userId ? { kind: "authenticated" as const, userId } : { kind: "unauthenticated" as const };
  return buildTestApp(auth, express.Router().use(usersRouter, adminProvenanceRouter));
}

describe("removing a picture, and a takedown that is final (Q16, Q17)", () => {
  const photos = photoBackgrounds();
  const unset = ["FAL_AI_API_KEY", "FAL_KEY", "AI_BACKEND", "PUBLIC_OBJECT_SEARCH_PATHS"];
  const saved: Record<string, string | undefined> = {};
  let png: Buffer;
  const google: PictureFetcher = async () => ({ bytes: png, contentType: "image/png" });

  before(async () => {
    photos.setUp();
    for (const k of unset) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.PUBLIC_OBJECT_SEARCH_PATHS = "/test-bucket/public";
    png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3c3" } }).png().toBuffer();
  });
  after(async () => {
    await db.delete(adminActionsTable).where(like(adminActionsTable.actorId, `${PREFIX}%`));
    await db.delete(uploadImageMetadataTable).where(like(uploadImageMetadataTable.userId, `${PREFIX}%`));
    await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await photos.tearDown();
  });

  async function withPicture(id: string): Promise<string> {
    const photo = await photos.seed(id);
    assert.equal((await request(app(id)).post("/api/users/me/profile-image").send({ objectPath: photo })).status, 200);
    return photo;
  }

  it("only a signed-in member can remove their picture", async () => {
    assert.equal((await request(app(null)).delete("/api/users/me/profile-image")).status, 401);
  });

  it("removing returns the member to their initial, keeps the photo in their library and deletable, and turns the default off", async () => {
    const id = await member();
    const bystander = await member();
    const photo = await withPicture(id);
    const theirs = await withPicture(bystander);

    const res = await request(app(id)).delete("/api/users/me/profile-image");
    assert.equal(res.status, 200);
    assert.equal(res.body.profileImageUrl, null);

    const user = await userRow(id);
    assert.equal(user.profileImageUrl, null, "no picture: the initial shows");
    assert.equal(user.noAutoPicture, true, "Google's picture will not come back");
    const row = await uploadRow(photo);
    assert.equal(row.isProfile, false, "no longer the Profile photo");
    assert.equal(row.deletedAt, null, "still in their library");

    const listed = (await request(app(id)).get("/api/users/me/uploads")).body.uploads as Array<{ objectPath: string }>;
    assert.ok(listed.some((u) => u.objectPath === photo), "listed in their photos");
    assert.equal((await request(app(id)).delete(`/api/users/me/uploads?path=${encodeURIComponent(photo)}`)).status, 200, "and can now be deleted");

    assert.equal((await userRow(bystander)).profileImageUrl, `/api/storage${theirs}`, "another member's picture is untouched");
    assert.equal((await userRow(bystander)).noAutoPicture, false);
    assert.equal((await request(app(id)).delete("/api/users/me/profile-image")).status, 200, "removing again is harmless");
  });

  it("after removing, Google's picture is not copied back at later sign-ins", async () => {
    const id = await member();
    await withPicture(id);
    await removeProfilePhoto(id);
    let fetched = 0;
    const counting: PictureFetcher = async (u) => { fetched++; return google(u); };
    assert.equal(await copyProviderPictureIn(id, GOOGLE, counting), "declined");
    assert.equal(await copyProviderPictureIn(id, GOOGLE, counting), "declined");
    assert.equal(fetched, 0, "nothing is even fetched");
    assert.equal((await userRow(id)).profileImageUrl, null);
  });

  it("a Google copy already in flight when the member removes their picture loses, and is discarded", async () => {
    const id = await member();
    const racing: PictureFetcher = async (u) => { await removeProfilePhoto(id); return google(u); };
    assert.equal(await copyProviderPictureIn(id, GOOGLE, racing), "has_photo");
    assert.equal((await userRow(id)).profileImageUrl, null, "no picture");
    const uploads = await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.userId, id));
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0]!.deletedAt, "the default never reaches their library");
  });

  it("after removing, choosing a photo of their own works, and the default stays off", async () => {
    const id = await member();
    const photo = await withPicture(id);
    await removeProfilePhoto(id);
    assert.equal((await request(app(id)).post("/api/users/me/profile-image").send({ objectPath: photo })).status, 200);
    const user = await userRow(id);
    assert.equal(user.profileImageUrl, `/api/storage${photo}`);
    assert.equal(user.noAutoPicture, true, "a choice of their own does not turn Google's picture back on");
    assert.equal((await uploadRow(photo)).isProfile, true);
  });

  it("a takedown of the profile photo turns the default off for good; the member can still choose another", async () => {
    const id = await member();
    const admin = await member(true);
    const photo = await withPicture(id);
    const spare = await photos.seed(id);

    const res = await request(app(admin)).post("/api/admin/content/takedown").send({ kind: "photo", key: photo, reason: "not a person" });
    assert.equal(res.status, 200);
    assert.equal((await userRow(id)).noAutoPicture, true);
    assert.equal(await copyProviderPictureIn(id, GOOGLE, google), "declined", "Google's picture is not copied in");

    assert.equal((await request(app(id)).post("/api/users/me/profile-image").send({ objectPath: photo })).status, 404, "the taken-down photo cannot be chosen");
    assert.equal((await request(app(id)).post("/api/users/me/profile-image").send({ objectPath: spare })).status, 200, "another photo of theirs can");
    assert.equal((await userRow(id)).noAutoPicture, true);
  });

  it("a takedown of a photo that is not the profile photo leaves the default alone", async () => {
    const id = await member();
    const admin = await member(true);
    const other = await photos.seed(id);
    assert.equal((await request(app(admin)).post("/api/admin/content/takedown").send({ kind: "photo", key: other, reason: "spam" })).status, 200);
    assert.equal((await userRow(id)).noAutoPicture, false);
  });

  it("a selection that checked the photo before a takedown cannot put it back", async () => {
    const id = await member();
    const admin = await member(true);
    const photo = await photos.seed(id);
    // The route's check passed; the takedown lands before the setter runs.
    assert.equal((await request(app(admin)).post("/api/admin/content/takedown").send({ kind: "photo", key: photo, reason: "reported" })).status, 200);
    await assert.rejects(makeProfilePhoto(id, photo), PhotoNotAvailableError);
    assert.equal((await userRow(id)).profileImageUrl, null);
    assert.equal((await uploadRow(photo)).isProfile, false);
  });

  it("a removal and a selection at the same moment both finish, in one order or the other", async () => {
    const id = await member();
    const photo = await withPicture(id);
    const other = await photos.seed(id);
    await Promise.all([removeProfilePhoto(id), makeProfilePhoto(id, other)]);
    const user = await userRow(id);
    const marked = (await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.userId, id)))
      .filter((r) => r.isProfile).map((r) => r.objectPath);
    if (user.profileImageUrl === null) assert.deepEqual(marked, [], "removed last: nothing is marked");
    else assert.deepEqual([user.profileImageUrl], marked.map((p) => `/api/storage${p}`), "chosen last: the picture and the marker agree");
    assert.notEqual(user.profileImageUrl, `/api/storage${photo}`);
  });
});
