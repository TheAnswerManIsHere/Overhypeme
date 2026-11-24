// #875 R3: the owner switches a live meme between public and private from its
// page. Making one private is the Legendary perk (`meme_private_visibility`,
// inventory F21; David, Q15, 2026-11-23), so a free owner may only make public.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, memesTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";

import memesRouter from "../routes/memes.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "tmemevis-";
// permalink_slug is varchar(16): "tmv" plus 8 hex.
const SLUG_PREFIX = "tmv";
const slug = () => `${SLUG_PREFIX}${randomUUID().slice(0, 8)}`;
let freeId: string;
let legendId: string;
let otherId: string;
let factId: number;

async function cleanup() {
  await db.delete(memesTable).where(like(memesTable.permalinkSlug, `${SLUG_PREFIX}%`));
  await db.delete(factsTable).where(like(factsTable.text, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

async function meme(ownerId: string, isPublic: boolean, deleted = false): Promise<string> {
  const s = slug();
  await db.insert(memesTable).values({
    factId, templateId: "photo_upload", renderedFactText: "t", createdById: ownerId,
    permalinkSlug: s, imageUrl: `/api/memes/${s}/image`, isPublic, ...(deleted ? { deletedAt: new Date() } : {}),
  });
  return s;
}

const patch = (s: string, userId: string | null, body: unknown) =>
  request(buildTestApp(userId ? { kind: "authenticated", userId } : { kind: "unauthenticated" }, memesRouter))
    .patch(`/api/memes/${s}/visibility`).send(body as object);

const isPublicOf = async (s: string) =>
  (await db.select({ p: memesTable.isPublic }).from(memesTable).where(eq(memesTable.permalinkSlug, s)))[0]!.p;

before(async () => {
  await cleanup();
  freeId = `${PREFIX}${randomUUID()}`;
  legendId = `${PREFIX}${randomUUID()}`;
  otherId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values([
    { id: freeId, email: `${freeId}@nope.test`, isActive: true },
    { id: legendId, email: `${legendId}@nope.test`, isActive: true, membershipTier: "legendary" },
    { id: otherId, email: `${otherId}@nope.test`, isActive: true },
  ]);
  factId = (await insertLiveFact({ text: `${PREFIX}fact`, canonicalText: `${PREFIX}fact`, enrichment: buildPlaceholderFactEnrichment() }, buildPlaceholderGag())).id;
});
after(cleanup);

describe("PATCH /memes/:slug/visibility", () => {
  it("a Legendary owner makes a meme private and public again", async () => {
    const s = await meme(legendId, true);
    assert.equal((await patch(s, legendId, { isPublic: false })).status, 200);
    assert.equal(await isPublicOf(s), false);
    assert.equal((await patch(s, legendId, { isPublic: true })).status, 200);
    assert.equal(await isPublicOf(s), true);
  });

  it("a free owner cannot make a meme private, but can make a private one public", async () => {
    const pub = await meme(freeId, true);
    const res = await patch(pub, freeId, { isPublic: false });
    assert.equal(res.status, 403);
    assert.equal(res.body.upgradeRequired, true);
    assert.equal(await isPublicOf(pub), true);

    const priv = await meme(freeId, false);
    assert.equal((await patch(priv, freeId, { isPublic: true })).status, 200);
    assert.equal(await isPublicOf(priv), true);
  });

  it("only the owner may change it; a deleted meme and a bad body are refused", async () => {
    const s = await meme(legendId, true);
    assert.equal((await patch(s, otherId, { isPublic: true })).status, 403);
    assert.equal((await patch(s, null, { isPublic: true })).status, 401);
    assert.equal((await patch(s, legendId, { isPublic: "no" })).status, 400);
    assert.equal((await patch(await meme(legendId, true, true), legendId, { isPublic: false })).status, 410);
    assert.equal((await patch(`${SLUG_PREFIX}missing`, legendId, { isPublic: true })).status, 404);
  });
});
