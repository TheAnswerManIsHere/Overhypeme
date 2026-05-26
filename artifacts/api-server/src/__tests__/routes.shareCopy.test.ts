/**
 * Phase-6 share-copy endpoint integration tests.
 *
 *   GET /api/share-copy/:memeId/:platform
 *
 * Covers per-platform response shape, template variable substitution,
 * Twitter truncation, the auth gate, the 404/410 paths, and rate limiting.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, memesTable, adminConfigTable } from "@workspace/db/schema";
import { eq, like, inArray } from "drizzle-orm";

import shareCopyRouter, { __resetShareCopyRateLimitForTests } from "../routes/shareCopy.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "t6sc";
const FACT_TEXT_PREFIX = "t6sc-fact-";
const insertedFactIds: number[] = [];

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
  const prefixedText = `${FACT_TEXT_PREFIX}${text}`;
  const [row] = await db
    .insert(factsTable)
    .values({ text: prefixedText, isActive: true, canonicalText: prefixedText })
    .returning();
  insertedFactIds.push(row.id);
  return row.id;
}

async function insertMeme(args: {
  factId: number;
  createdById: string | null;
  slug: string;
  deleted?: boolean;
  renderedFactText?: string;
}): Promise<void> {
  await db.insert(memesTable).values({
    factId: args.factId,
    templateId: "action",
    imageUrl: `/api/memes/${args.slug}/image`,
    permalinkSlug: args.slug,
    createdById: args.createdById,
    deletedAt: args.deleted ? new Date() : null,
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
  await db.delete(memesTable).where(like(memesTable.permalinkSlug, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
  // Prefix-based cleanup catches both in-flight facts and orphans from a crashed run.
  const orphanFactIds = (await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(like(factsTable.text, `${FACT_TEXT_PREFIX}%`)))
    .map((r) => r.id);
  if (orphanFactIds.length > 0) {
    await db.delete(memesTable).where(inArray(memesTable.factId, orphanFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, orphanFactIds));
  }
  insertedFactIds.length = 0;
}

let _savedSiteBaseUrl: string | undefined;
let testerUserId: string;

before(async () => {
  _savedSiteBaseUrl = process.env.SITE_BASE_URL;
  process.env.SITE_BASE_URL = "https://overhype.me";
  await cleanup();

  // Seed admin_config rows in case the migration hasn't been applied to the
  // test DB (drizzle-kit push doesn't run our migration SQL). Idempotent.
  const seeds: Array<[string, string]> = [
    ["share_copy_twitter_template",         "{fact_text}"],
    ["share_copy_twitter_hashtags",         "overhype,legendsaremadeup"],
    ["share_copy_email_subject_template",   "A meme of {name} on overhype.me"],
    [
      "share_copy_email_body_template",
      "{name} thought you'd appreciate this:\n\n\"{fact_text}\"\n\nSee it: {permalink}\n\n— Sent from overhype.me, where legends are made up.",
    ],
    ["share_copy_web_share_title_template", "{name} on overhype.me"],
    ["share_copy_web_share_text_template",  "{fact_text}"],
  ];
  for (const [key, value] of seeds) {
    await db
      .insert(adminConfigTable)
      .values({ key, value, dataType: "text", label: key, isPublic: false })
      .onConflictDoNothing();
  }

  testerUserId = await createUser("Tester");
});

after(async () => {
  // Clean admin_config seeds we may have inserted.
  await db.delete(adminConfigTable).where(like(adminConfigTable.key, "share_copy_%"));
  await cleanup();
  if (_savedSiteBaseUrl === undefined) {
    delete process.env.SITE_BASE_URL;
  } else {
    process.env.SITE_BASE_URL = _savedSiteBaseUrl;
  }
});

beforeEach(() => {
  __resetShareCopyRateLimitForTests();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/share-copy/:memeId/:platform — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/anything/twitter`);
    assert.equal(res.status, 401);
  });
});

describe("GET /api/share-copy/:memeId/:platform — validation", () => {
  it("returns 400 for an unknown platform", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/anything/myspace`);
    assert.equal(res.status, 400);
  });

  it("returns 404 for a slug that doesn't resolve to a meme", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${PREFIX}nope/twitter`);
    assert.equal(res.status, 404);
  });
});

describe("GET /api/share-copy/:memeId/twitter", () => {
  it("returns text, hashtags, and a pre-built intentUrl", async () => {
    const creatorId = await createUser("Alice");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}tw01`;
    await insertMeme({ factId, createdById: creatorId, slug, renderedFactText: "Alice fought a bear" });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${slug}/twitter`);

    assert.equal(res.status, 200);
    assert.equal(res.body.platform, "twitter");
    assert.equal(res.body.url, `https://overhype.me/m/${slug}`);
    assert.equal(res.body.text, "Alice fought a bear");
    assert.deepEqual(res.body.hashtags, ["overhype", "legendsaremadeup"]);
    assert.match(res.body.intentUrl, /^https:\/\/twitter\.com\/intent\/tweet\?/);
    assert.match(res.body.intentUrl, /text=Alice\+fought\+a\+bear/);
    assert.match(res.body.intentUrl, new RegExp(`url=${encodeURIComponent(`https://overhype.me/m/${slug}`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(res.body.intentUrl, /hashtags=overhype%2Clegendsaremadeup/);
  });

  it("URL-encodes names with apostrophes and accented characters", async () => {
    const creatorId = await createUser("José O'Hara");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}tw02`;
    await insertMeme({ factId, createdById: creatorId, slug, renderedFactText: "José O'Hara did it" });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${slug}/twitter`);
    assert.equal(res.status, 200);
    // Apostrophe is encoded as %27 in URLSearchParams output.
    assert.match(res.body.intentUrl, /Jos%C3%A9\+O%27Hara/);
  });

  it("truncates very long fact text to fit Twitter's character budget", async () => {
    const creatorId = await createUser("LongName");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}tw03`;
    const long = "x".repeat(600);
    await insertMeme({ factId, createdById: creatorId, slug, renderedFactText: long });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${slug}/twitter`);
    assert.equal(res.status, 200);
    assert.ok(res.body.text.length < 600, "text should be truncated");
    assert.ok(res.body.text.endsWith("…"), "truncated text should end with ellipsis");
  });
});

describe("GET /api/share-copy/:memeId/web_share", () => {
  it("returns title, text, and url", async () => {
    const creatorId = await createUser("Bob");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}ws01`;
    await insertMeme({ factId, createdById: creatorId, slug, renderedFactText: "Bob fought a bear" });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${slug}/web_share`);

    assert.equal(res.status, 200);
    assert.equal(res.body.platform, "web_share");
    assert.equal(res.body.url, `https://overhype.me/m/${slug}`);
    assert.equal(res.body.title, "Bob on overhype.me");
    assert.equal(res.body.text, "Bob fought a bear");
  });
});

describe("GET /api/share-copy/:memeId/copy_link", () => {
  it("returns just the absolute permalink", async () => {
    const creatorId = await createUser("Carol");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}cl01`;
    await insertMeme({ factId, createdById: creatorId, slug, renderedFactText: "Carol fought a bear" });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${slug}/copy_link`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { platform: "copy_link", url: `https://overhype.me/m/${slug}` });
  });
});

describe("GET /api/share-copy/:memeId/email", () => {
  it("returns subject, body, and a pre-built mailto: intentUrl", async () => {
    const creatorId = await createUser("Dave");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}em01`;
    await insertMeme({ factId, createdById: creatorId, slug, renderedFactText: "Dave fought a bear" });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${slug}/email`);

    assert.equal(res.status, 200);
    assert.equal(res.body.platform, "email");
    assert.equal(res.body.subject, "A meme of Dave on overhype.me");
    assert.ok(res.body.body.startsWith("Dave thought you"));
    assert.ok(res.body.body.includes(`https://overhype.me/m/${slug}`));
    assert.ok(res.body.body.includes("legends are made up"));
    assert.match(res.body.intentUrl, /^mailto:\?/);
    // mailto: bodies must use %20, not + — Outlook renders the + literally.
    assert.doesNotMatch(res.body.intentUrl, /\+/);
    assert.match(res.body.intentUrl, /subject=A%20meme%20of%20Dave/);
  });
});

describe("GET /api/share-copy/:memeId/:platform — 410 soft-deleted", () => {
  it("returns 410 when the meme has been removed by its creator", async () => {
    const creatorId = await createUser("Erin");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}gone01`;
    await insertMeme({ factId, createdById: creatorId, slug, deleted: true, renderedFactText: "x" });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    const res = await request(app).get(`/api/share-copy/${slug}/twitter`);
    assert.equal(res.status, 410);
  });
});

describe("GET /api/share-copy/:memeId/:platform — rate limit", () => {
  it("returns 429 after exceeding 60 requests in the window", async () => {
    const creatorId = await createUser("Frank");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}rl01`;
    await insertMeme({ factId, createdById: creatorId, slug, renderedFactText: "Frank fought a bear" });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareCopyRouter);
    // Exhaust the bucket (the limit is 60). Fire 60 then expect the 61st to 429.
    for (let i = 0; i < 60; i++) {
      const r = await request(app).get(`/api/share-copy/${slug}/copy_link`);
      assert.equal(r.status, 200);
    }
    const r = await request(app).get(`/api/share-copy/${slug}/copy_link`);
    assert.equal(r.status, 429);
  });
});
