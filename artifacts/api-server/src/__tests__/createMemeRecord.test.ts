/**
 * Unit tests for the shared createMemeRecord helper.
 *
 * Covers the image variants. (A video variant went with video, launch Phase 4.)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  memesTable,
} from "@workspace/db/schema";
import { eq, like, inArray } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { createMemeRecord, CreateMemeError, type MemeAuthorizationDecisions } from "../lib/createMemeRecord.js";
import { ownUpload } from "./helpers/ownedUpload.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";

const USER_PREFIX = "t-cmr-";

function uid(): string {
  return `${USER_PREFIX}${randomUUID()}`;
}

const insertedFactIds: number[] = [];
const insertedUserIds: string[] = [];

async function createTestUser(): Promise<string> {
  const id = uid();
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: "legendary",
    displayName: "Tester",
    pronouns: "they/them",
  });
  insertedUserIds.push(id);
  return id;
}

const FACT_TEXT_PREFIX = "t-cmr-fact-";

async function insertFact(): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text: `${FACT_TEXT_PREFIX}{NAME}`, isActive: true, enrichment: buildPlaceholderFactEnrichment(), canonicalText: FACT_TEXT_PREFIX })
    .returning();
  insertedFactIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (insertedUserIds.length > 0) {
    await db.delete(memesTable).where(inArray(memesTable.createdById, insertedUserIds));
  }
  if (insertedFactIds.length > 0) {
    await db.delete(memesTable).where(inArray(memesTable.factId, insertedFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  // Prefix-based safety net: catches any facts left by a prior crashed run.
  await db.delete(factsTable).where(like(factsTable.text, `${FACT_TEXT_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  insertedUserIds.length = 0;
}

before(cleanup);
after(cleanup);

/**
 * These tests exercise persistence, not authorization: the gates now live in
 * `featureAccess.ts` and are resolved by the CALLER. Passing an explicit,
 * fully-permissive decision set keeps that separation visible — a test that
 * silently inherited a resolver answer would be testing two things at once.
 */
const ALLOW_ALL: MemeAuthorizationDecisions = {
  meme_private_visibility: true,
  meme_rate_limit_high: true,
};

// #804: a meme is made from the saver's own upload only; the image route
// renders those bytes, publicly when the meme is public.
// A meme is rendered from its photo's bytes at save (plan S16), so the photos
// live in the local storage double for the length of this file's suites.
describe("createMemeRecord (photos in the local storage double)", () => {
  const photos = photoBackgrounds();
  before(() => photos.setUp());
  after(() => photos.tearDown());

  describe("createMemeRecord — the photo must be the saver's own (#804)", () => {
    it("refuses another member's upload and saves nothing", async () => {
      const owner = await createTestUser();
      const stranger = await createTestUser();
      const factId = await insertFact();
      const key = await ownUpload(owner, `/objects/uploads/t_cmr_private_${owner}.jpg`);
      await assert.rejects(
        createMemeRecord({ userId: stranger, factId, imageSource: { type: "upload", uploadKey: key }, aspectRatio: "landscape", decisions: ALLOW_ALL }),
        (err: unknown) => err instanceof CreateMemeError && err.status === 403,
      );
      const rows = await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.createdById, stranger));
      assert.equal(rows.length, 0);
    });

    it("refuses an upload no member owns", async () => {
      const userId = await createTestUser();
      const factId = await insertFact();
      await assert.rejects(
        createMemeRecord({ userId, factId, imageSource: { type: "upload", uploadKey: "/objects/uploads/t_cmr_nobody.jpg" }, aspectRatio: "landscape", decisions: ALLOW_ALL }),
        (err: unknown) => err instanceof CreateMemeError && err.status === 403,
      );
    });
  });

  describe("createMemeRecord — image variant", () => {
    it("persists an upload-photo meme with the expected shape", async () => {
      const userId = await createTestUser();
      const factId = await insertFact();
      const result = await createMemeRecord({
        userId,
        factId,
        imageSource: {
          type: "upload",
          uploadKey: await ownUpload(userId, `/objects/uploads/t_cmr_shape_${userId}.jpg`),
        },
        aspectRatio: "landscape",
        decisions: ALLOW_ALL,
      });
      assert.ok(result.memeId > 0);
      assert.equal(typeof result.permalinkSlug, "string");
      assert.equal(result.permalinkSlug.length, 10);

      const [row] = await db
        .select()
        .from(memesTable)
        .where(eq(memesTable.id, result.memeId))
        .limit(1);
      assert.ok(row, "meme row should exist");
      assert.equal(row.templateId, "photo_upload");
      assert.equal(row.factId, factId);
      assert.equal(row.createdById, userId);
      assert.equal(row.aspectRatio, "landscape");
    });

    it("idempotency: identical input within window returns the same memeId with idempotent=true", async () => {
      const userId = await createTestUser();
      const factId = await insertFact();
      const input = {
        userId,
        factId,
        imageSource: {
          type: "upload" as const,
          uploadKey: await ownUpload(userId, `/objects/uploads/t_cmr_idem_${userId}.jpg`),
        },
        aspectRatio: "square" as const,
        decisions: ALLOW_ALL,
      };
      const first = await createMemeRecord(input);
      const second = await createMemeRecord(input);
      assert.equal(second.memeId, first.memeId);
      assert.equal(second.idempotent, true);
    });
  });
});
