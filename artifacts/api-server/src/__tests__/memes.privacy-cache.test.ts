/**
 * Security regression for C3 — private (owner-only) memes.
 *
 * `isPublic === false` means owner-only: only the creator or an admin may see
 * the meme, and private responses must never be publicly/edge-cached. Every
 * surface that resolves a meme by slug (detail JSON, rendered image, OG shell,
 * share copy/intents, Zazzle export) shares one decision — `canViewMeme()`.
 *
 * These tests cover the decision exhaustively (unit) and prove it end-to-end at
 * the representative `GET /memes/:slug` route (owner allowed + no-store; a
 * different user / unauthenticated → 404 so existence isn't disclosed; admin
 * allowed; public meme visible to all).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Request } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, memesTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import memesRouter from "../routes/memes.js";
import { canViewMeme } from "../lib/memeVisibility.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "tsec_meme_";
const SLUG_PREFIX = "tsecm"; // permalink_slug is varchar(16)

function reqAs(userId?: string, admin = false): Request {
  return { user: userId ? { id: userId, isRealAdmin: admin } : undefined } as unknown as Request;
}

describe("canViewMeme (visibility decision)", () => {
  it("public meme: viewable by anyone, incl. unauthenticated", () => {
    assert.equal(canViewMeme({ isPublic: true, createdById: "owner" }, reqAs(undefined)), true);
    assert.equal(canViewMeme({ isPublic: true, createdById: "owner" }, reqAs("someone")), true);
  });
  it("private meme: viewable by its owner", () => {
    assert.equal(canViewMeme({ isPublic: false, createdById: "owner" }, reqAs("owner")), true);
  });
  it("private meme: NOT viewable by a different user", () => {
    assert.equal(canViewMeme({ isPublic: false, createdById: "owner" }, reqAs("other")), false);
  });
  it("private meme: NOT viewable by an unauthenticated caller", () => {
    assert.equal(canViewMeme({ isPublic: false, createdById: "owner" }, reqAs(undefined)), false);
  });
  it("private meme: viewable by an admin", () => {
    assert.equal(canViewMeme({ isPublic: false, createdById: "owner" }, reqAs("admin", true)), true);
  });
  it("private meme with no creator: admin-only (fail closed)", () => {
    assert.equal(canViewMeme({ isPublic: false, createdById: null }, reqAs("anyone")), false);
    assert.equal(canViewMeme({ isPublic: false, createdById: null }, reqAs("admin", true)), true);
  });
});

let ownerId: string;
let otherId: string;
let adminId: string;
let factId: number;
const PRIV_SLUG = `${SLUG_PREFIX}${randomUUID().slice(0, 8)}`;
const PUB_SLUG = `${SLUG_PREFIX}${randomUUID().slice(0, 8)}`;
const DEL_PRIV_SLUG = `${SLUG_PREFIX}${randomUUID().slice(0, 8)}`;

async function cleanup() {
  await db.delete(memesTable).where(like(memesTable.permalinkSlug, `${SLUG_PREFIX}%`));
  await db.delete(factsTable).where(like(factsTable.text, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(async () => {
  await cleanup();
  ownerId = `${PREFIX}${randomUUID()}`;
  otherId = `${PREFIX}${randomUUID()}`;
  adminId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values([
    { id: ownerId, email: `${ownerId}@nope.test`, isActive: true },
    { id: otherId, email: `${otherId}@nope.test`, isActive: true },
    { id: adminId, email: `${adminId}@nope.test`, isActive: true, isAdmin: true },
  ]);
  const [fact] = await db
    .insert(factsTable)
    .values({ text: `${PREFIX}fact`, canonicalText: `${PREFIX}fact`, isActive: true, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  factId = fact.id;

  const base = {
    factId,
    templateId: "classic",
    renderedFactText: "frozen text",
    createdById: ownerId,
  };
  await db.insert(memesTable).values([
    { ...base, permalinkSlug: PRIV_SLUG, imageUrl: `/api/memes/${PRIV_SLUG}/image`, isPublic: false },
    { ...base, permalinkSlug: PUB_SLUG, imageUrl: `/api/memes/${PUB_SLUG}/image`, isPublic: true },
    { ...base, permalinkSlug: DEL_PRIV_SLUG, imageUrl: `/api/memes/${DEL_PRIV_SLUG}/image`, isPublic: false, deletedAt: new Date() },
  ]);
});
after(cleanup);

describe("GET /memes/:slug — private-meme owner-only enforcement", () => {
  const get = (slug: string, auth: Parameters<typeof buildTestApp>[0]) =>
    request(buildTestApp(auth, memesRouter)).get(`/api/memes/${slug}`);

  it("owner sees a private meme (200) and it is no-store", async () => {
    const res = await get(PRIV_SLUG, { kind: "authenticated", userId: ownerId });
    assert.equal(res.status, 200);
    assert.equal(res.body.isPublic, false);
    assert.match(String(res.headers["cache-control"] ?? ""), /no-store/);
  });

  it("a different authenticated user gets 404 (no existence disclosure)", async () => {
    const res = await get(PRIV_SLUG, { kind: "authenticated", userId: otherId });
    assert.equal(res.status, 404);
  });

  it("an unauthenticated caller gets 404", async () => {
    const res = await get(PRIV_SLUG, { kind: "unauthenticated" });
    assert.equal(res.status, 404);
  });

  it("an admin sees a private meme (200)", async () => {
    const res = await get(PRIV_SLUG, { kind: "authenticated", userId: adminId });
    assert.equal(res.status, 200);
  });

  it("a public meme is visible to anyone", async () => {
    const res = await get(PUB_SLUG, { kind: "unauthenticated" });
    assert.equal(res.status, 200);
    assert.equal(res.body.isPublic, true);
  });

  // A private meme that is ALSO soft-deleted must be indistinguishable from a
  // never-existing slug for non-owners: 404, not the 410 "removed" status.
  it("a deleted private meme gives a non-owner 404, not 410", async () => {
    assert.equal((await get(DEL_PRIV_SLUG, { kind: "authenticated", userId: otherId })).status, 404);
    assert.equal((await get(DEL_PRIV_SLUG, { kind: "unauthenticated" })).status, 404);
  });

  it("a deleted private meme still returns 410 to its owner", async () => {
    const res = await get(DEL_PRIV_SLUG, { kind: "authenticated", userId: ownerId });
    assert.equal(res.status, 410);
  });
});
