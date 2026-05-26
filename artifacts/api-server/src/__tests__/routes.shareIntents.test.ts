/**
 * Phase-6 share-intent logging endpoint integration tests.
 *
 *   POST /api/share-intents { memeId, platform }
 *
 * Covers row insertion, the auth gate, validation (unknown platform,
 * missing memeId), 404 on bad slug, 410 on soft-deleted meme, and the
 * FK cascade on meme deletion.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, memesTable, shareIntentsTable } from "@workspace/db/schema";
import { eq, like, inArray } from "drizzle-orm";

import shareIntentsRouter from "../routes/shareIntents.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "t6si";
const FACT_TEXT_PREFIX = "t6si-fact-";
const insertedFactIds: number[] = [];

async function createUser(displayName: string): Promise<string> {
  const id = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: "registered",
    displayName,
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
  createdById: string;
  slug: string;
  deleted?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(memesTable)
    .values({
      factId: args.factId,
      templateId: "action",
      imageUrl: `/api/memes/${args.slug}/image`,
      permalinkSlug: args.slug,
      createdById: args.createdById,
      deletedAt: args.deleted ? new Date() : null,
      renderedFactText: "x",
      aspectRatio: "square",
    })
    .returning({ id: memesTable.id });
  return row.id;
}

async function cleanup() {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.id, `${PREFIX}%`));
  for (const u of users) {
    // share_intents.meme_id has ON DELETE CASCADE; deleting the meme cascades
    // to any intent rows. Cleaning by user_id is also safe — both FKs cascade.
    await db.delete(shareIntentsTable).where(eq(shareIntentsTable.userId, u.id));
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

let testerUserId: string;

before(async () => {
  await cleanup();
  testerUserId = await createUser("Tester");
});

after(async () => {
  await cleanup();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/share-intents — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, shareIntentsRouter);
    const res = await request(app)
      .post("/api/share-intents")
      .send({ memeId: "anything", platform: "twitter" });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/share-intents — validation", () => {
  it("returns 400 for an unknown platform", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareIntentsRouter);
    const res = await request(app)
      .post("/api/share-intents")
      .send({ memeId: "anything", platform: "myspace" });
    assert.equal(res.status, 400);
  });

  it("returns 400 when memeId is missing", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareIntentsRouter);
    const res = await request(app)
      .post("/api/share-intents")
      .send({ platform: "twitter" });
    assert.equal(res.status, 400);
  });

  it("returns 404 for an unknown slug", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareIntentsRouter);
    const res = await request(app)
      .post("/api/share-intents")
      .send({ memeId: `${PREFIX}nope`, platform: "twitter" });
    assert.equal(res.status, 404);
  });

  it("returns 410 for a soft-deleted meme", async () => {
    const creatorId = await createUser("Removed");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}gone01`;
    await insertMeme({ factId, createdById: creatorId, slug, deleted: true });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareIntentsRouter);
    const res = await request(app)
      .post("/api/share-intents")
      .send({ memeId: slug, platform: "twitter" });
    assert.equal(res.status, 410);
  });
});

describe("POST /api/share-intents — insertion", () => {
  it("inserts a row and returns 204", async () => {
    const creatorId = await createUser("Inserter");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}ins01`;
    const memeId = await insertMeme({ factId, createdById: creatorId, slug });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareIntentsRouter);
    const res = await request(app)
      .post("/api/share-intents")
      .send({ memeId: slug, platform: "twitter" });

    assert.equal(res.status, 204);

    const rows = await db
      .select()
      .from(shareIntentsTable)
      .where(eq(shareIntentsTable.memeId, memeId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].platform, "twitter");
    assert.equal(rows[0].userId, testerUserId);
  });

  it("accepts all four valid platforms", async () => {
    const creatorId = await createUser("MultiPlatform");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}ins02`;
    const memeId = await insertMeme({ factId, createdById: creatorId, slug });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareIntentsRouter);
    for (const platform of ["twitter", "web_share", "copy_link", "email"] as const) {
      const res = await request(app)
        .post("/api/share-intents")
        .send({ memeId: slug, platform });
      assert.equal(res.status, 204, `platform=${platform}`);
    }

    const rows = await db
      .select()
      .from(shareIntentsTable)
      .where(eq(shareIntentsTable.memeId, memeId));
    const platforms = rows.map((r) => r.platform).sort();
    assert.deepEqual(platforms, ["copy_link", "email", "twitter", "web_share"]);
  });
});

describe("POST /api/share-intents — FK cascade", () => {
  it("removes share_intents rows when the parent meme is hard-deleted", async () => {
    const creatorId = await createUser("Cascade");
    const factId = await insertFact("a fact");
    const slug = `${PREFIX}cas01`;
    const memeId = await insertMeme({ factId, createdById: creatorId, slug });

    const app = buildTestApp({ kind: "authenticated", userId: testerUserId }, shareIntentsRouter);
    await request(app)
      .post("/api/share-intents")
      .send({ memeId: slug, platform: "copy_link" });

    let rows = await db.select().from(shareIntentsTable).where(eq(shareIntentsTable.memeId, memeId));
    assert.equal(rows.length, 1);

    await db.delete(memesTable).where(eq(memesTable.id, memeId));

    rows = await db.select().from(shareIntentsTable).where(eq(shareIntentsTable.memeId, memeId));
    assert.equal(rows.length, 0);
  });
});
