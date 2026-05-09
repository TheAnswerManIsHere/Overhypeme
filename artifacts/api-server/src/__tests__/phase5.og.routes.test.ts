/**
 * Phase-5 OG endpoint integration tests.
 *
 * Covers GET /api/og/m/:slug:
 *   - 200 + full OG tags for live memes
 *   - 410 + generic card for soft-deleted
 *   - 404 + generic card for missing
 *   - Cache-Control set to public 1h
 *   - HTML escaping of user-authored fields
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, memesTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import ogRouter from "../routes/og.js";

const PREFIX = "t5og";

function makeApp(): Express {
  const app = express();
  app.use(ogRouter);
  return app;
}

async function createUser(displayName: string): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: "registered",
    displayName,
    pronouns: "they/them",
  });
  return id;
}

async function insertFact(text: string): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text, isActive: true, canonicalText: text })
    .returning();
  return row.id;
}

async function insertMeme(args: {
  factId: number;
  createdById: string | null;
  slug: string;
  deleted?: boolean;
  isNsfw?: boolean;
  imageTransform?: string | null;
  renderedFactText?: string;
}): Promise<void> {
  await db.insert(memesTable).values({
    factId: args.factId,
    templateId: "action",
    imageUrl: `https://overhype.me/api/memes/${args.slug}/image`,
    permalinkSlug: args.slug,
    createdById: args.createdById,
    deletedAt: args.deleted ? new Date() : null,
    isNsfw: args.isNsfw ?? false,
    imageTransform: args.imageTransform ?? null,
    renderedFactText: args.renderedFactText ?? null,
    aspectRatio: "square",
  });
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${PREFIX}%`));
  for (const u of users) {
    await db.delete(memesTable).where(eq(memesTable.createdById, u.id));
  }
  // Memes with null createdById that we created — match via slug prefix.
  await db.delete(memesTable).where(like(memesTable.permalinkSlug, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("GET /og/m/:slug — live meme", () => {
  it("returns 200 with full og:* tags and 1h cache", async () => {
    const userId = await createUser("Alice <Test>");
    const factId = await insertFact("{NAME} fought a bear");
    const slug = `${PREFIX}live01`;
    await insertMeme({
      factId,
      createdById: userId,
      slug,
      renderedFactText: "Alice <Test> fought a bear",
    });

    const res = await request(makeApp()).get(`/og/m/${slug}`);

    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.headers["cache-control"] ?? "", /max-age=3600/);
    assert.match(res.text, /<meta property="og:type" content="website"/);
    assert.match(res.text, /<meta property="og:site_name" content="overhype\.me"/);
    assert.match(res.text, /<meta name="twitter:card" content="summary_large_image"/);
    assert.match(res.text, /<meta property="og:image:width" content="1080"/);
    assert.match(res.text, /<meta property="og:image:height" content="1080"/);
    assert.match(res.text, new RegExp(`/m/${slug}`));
    // The displayName has HTML-special characters; the response must escape
    // them before they reach the meta content attribute.
    assert.match(res.text, /Alice &lt;Test&gt;/);
    assert.doesNotMatch(res.text, /Alice <Test>/);
  });

  it("uses square aspect ratio 1080x1080 by default", async () => {
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}sq02`;
    await insertMeme({ factId, createdById: null, slug });

    const res = await request(makeApp()).get(`/og/m/${slug}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /og:image:width" content="1080"/);
    assert.match(res.text, /og:image:height" content="1080"/);
  });
});

describe("GET /og/m/:slug — soft-deleted", () => {
  it("returns 410 with generic card and does not leak the meme content", async () => {
    const userId = await createUser("Bob");
    const factId = await insertFact("secret content nobody should see");
    const slug = `${PREFIX}gone03`;
    await insertMeme({
      factId,
      createdById: userId,
      slug,
      deleted: true,
      renderedFactText: "secret content nobody should see",
    });

    const res = await request(makeApp()).get(`/og/m/${slug}`);

    assert.equal(res.status, 410);
    assert.match(res.text, /Removed/);
    assert.doesNotMatch(res.text, /secret content/);
  });
});

describe("GET /og/m/:slug — missing", () => {
  it("returns 404 with generic card", async () => {
    const res = await request(makeApp()).get(`/og/m/${PREFIX}nope404`);
    assert.equal(res.status, 404);
    assert.match(res.text, /Not found/);
    assert.match(res.text, /og:type/);
  });
});

describe("GET /og/m/:slug — bot-relevant headers", () => {
  it("ignores user-agent (responds identically for crawlers and direct callers)", async () => {
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}ua04`;
    await insertMeme({ factId, createdById: null, slug });

    const a = await request(makeApp())
      .get(`/og/m/${slug}`)
      .set("User-Agent", "Twitterbot/1.0");
    const b = await request(makeApp())
      .get(`/og/m/${slug}`)
      .set(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      );

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // Bodies are identical — UA detection happens at the edge, not here.
    assert.equal(a.text, b.text);
  });
});
