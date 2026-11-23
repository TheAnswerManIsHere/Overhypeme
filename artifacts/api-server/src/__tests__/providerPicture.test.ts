/**
 * @purpose Google sign-in's picture becomes the member's first photo (plan PLAN_PHOTO_IS_YOUR_PICTURE.md, David's Q13): an adult member with no photo gets it as a real first-party upload marked as their profile photo; a member who has a photo keeps it; a member without an adult date of birth, a picture off Google's image host, or a fetch that fails leaves no photo; the provider URL is never stored. The provider fetch is a test double.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db } from "@workspace/db";
import { uploadImageMetadataTable, usersTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { copyProviderPictureIn, googlePictureUrl, type PictureFetcher } from "../lib/providerPicture.js";

const PREFIX = "t_provpic_";

describe("copying the Google picture in at sign-in", () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-picture-"));
  const env: Record<string, string> = {
    STORAGE_BACKEND: "local-double",
    STORAGE_DOUBLE_DIR: storageRoot,
    PRIVATE_OBJECT_DIR: "/provpic-test-bucket/private",
    PUBLIC_OBJECT_SEARCH_PATHS: "/provpic-test-bucket/public",
  };
  const saved: Record<string, string | undefined> = {};
  let png: Buffer;

  before(async () => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c33" } }).png().toBuffer();
  });
  after(async () => {
    await db.delete(uploadImageMetadataTable).where(like(uploadImageMetadataTable.userId, `${PREFIX}%`));
    await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  async function member(opts: { dateOfBirth?: string | null; profileImageUrl?: string | null } = {}): Promise<string> {
    const id = `${PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id, email: `${id}@test.local`,
      dateOfBirth: opts.dateOfBirth === undefined ? "1990-05-05" : opts.dateOfBirth,
      profileImageUrl: opts.profileImageUrl ?? null,
    });
    return id;
  }
  const GOOGLE = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";
  function fetcher(answer: { bytes: Buffer; contentType: string } | null = null): PictureFetcher & { calls: URL[] } {
    const calls: URL[] = [];
    const f = (async (url: URL) => { calls.push(url); return answer ?? { bytes: png, contentType: "image/png" }; }) as PictureFetcher & { calls: URL[] };
    f.calls = calls;
    return f;
  }
  const userRow = async (id: string) => (await db.select().from(usersTable).where(eq(usersTable.id, id)))[0]!;

  it("an adult with no photo gets the picture as a real upload, marked as their profile photo", async () => {
    const id = await member();
    const f = fetcher();
    assert.equal(await copyProviderPictureIn(id, GOOGLE, f), "copied");
    assert.equal(f.calls[0]!.toString(), "https://lh3.googleusercontent.com/a/ACg8ocK=s1024-c", "asks for a usable size");

    const { profileImageUrl } = await userRow(id);
    assert.match(profileImageUrl ?? "", /^\/api\/storage\/objects\//, "a first-party photo, never the provider URL");
    const objectPath = profileImageUrl!.replace("/api/storage", "");
    const [upload] = await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, objectPath));
    assert.equal(upload!.userId, id, "it is the member's own upload");
    assert.equal(upload!.isProfile, true, "and their profile photo");
  });

  it("a member who already has a photo keeps it, and nothing is fetched", async () => {
    const mine = "/api/storage/objects/uploads/mine.jpg";
    const id = await member({ profileImageUrl: mine });
    const f = fetcher();
    assert.equal(await copyProviderPictureIn(id, GOOGLE, f), "has_photo");
    assert.equal(f.calls.length, 0);
    assert.equal((await userRow(id)).profileImageUrl, mine);
  });

  it("a member without an adult date of birth gets nothing: photo uploads are for members 18 and over", async () => {
    for (const dob of [null, "2015-01-01"]) {
      const id = await member({ dateOfBirth: dob });
      const f = fetcher();
      assert.equal(await copyProviderPictureIn(id, GOOGLE, f), "not_adult");
      assert.equal(f.calls.length, 0);
      assert.equal((await userRow(id)).profileImageUrl, null);
    }
  });

  it("only Google's own image host, over https, is ever fetched", async () => {
    for (const bad of ["http://lh3.googleusercontent.com/a/x", "https://evil.example.com/x.png", "https://googleusercontent.com.evil.example/x",
      "https://user:pw@lh3.googleusercontent.com/a/x", "https://lh3.googleusercontent.com:8443/a/x", "not a url"]) {
      const id = await member();
      const f = fetcher();
      assert.equal(await copyProviderPictureIn(id, bad, f), "refused_url", bad);
      assert.equal(f.calls.length, 0, bad);
    }
    assert.equal(googlePictureUrl(42), null);
  });

  it("a fetch that fails, or a picture the pipeline refuses, leaves the member photo-less", async () => {
    const failing = await member();
    assert.equal(await copyProviderPictureIn(failing, GOOGLE, async () => { throw new Error("network down"); }), "fetch_failed");
    assert.equal((await userRow(failing)).profileImageUrl, null);

    const refused = await member();
    assert.equal(await copyProviderPictureIn(refused, GOOGLE, fetcher({ bytes: Buffer.from("not an image"), contentType: "application/pdf" })), "rejected");
    assert.equal((await userRow(refused)).profileImageUrl, null);
  });

  it("no picture in the claims is no fetch", async () => {
    const id = await member();
    const f = fetcher();
    assert.equal(await copyProviderPictureIn(id, undefined, f), "no_picture");
    assert.equal(f.calls.length, 0);
  });
});
