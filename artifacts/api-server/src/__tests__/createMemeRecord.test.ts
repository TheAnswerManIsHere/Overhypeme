/**
 * Unit tests for the shared createMemeRecord helper.
 *
 * Covers the image variant (existing behaviour preserved) and the new video
 * variant the wizard pipeline emits.
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

import { createMemeRecord } from "../lib/createMemeRecord.js";

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

describe("createMemeRecord — image variant", () => {
  it("persists a stock-photo meme with the expected shape", async () => {
    const userId = await createTestUser();
    const factId = await insertFact();
    const result = await createMemeRecord({
      userId,
      factId,
      imageSource: {
        type: "stock",
        pexelsPhotoId: 12345,
        photoUrl: "https://example.com/x.jpg",
      },
      aspectRatio: "landscape",
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
    assert.equal(row.templateId, "photo_stock");
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
        type: "stock" as const,
        pexelsPhotoId: 67890,
      },
      aspectRatio: "square" as const,
    };
    const first = await createMemeRecord(input);
    const second = await createMemeRecord(input);
    assert.equal(second.memeId, first.memeId);
    assert.equal(second.idempotent, true);
  });
});

describe("createMemeRecord — video variant", () => {
  it("persists templateId='video' and stores videoObjectPath in imageSource", async () => {
    const userId = await createTestUser();
    const factId = await insertFact();
    const videoPath = "/objects/video-memes/abc/job-xyz.mp4";
    const stillPath = "/objects/derived-still.jpg";

    const result = await createMemeRecord({
      userId,
      factId,
      imageSource: {
        type: "video",
        videoJobId: 42,
        videoObjectPath: videoPath,
        stillObjectPath: stillPath,
        lookStyleId: "cinematic",
        motionPresetId: "subtle-push",
      },
      aspectRatio: "portrait",
    });
    assert.ok(result.memeId > 0);

    const [row] = await db
      .select()
      .from(memesTable)
      .where(eq(memesTable.id, result.memeId))
      .limit(1);
    assert.ok(row);
    assert.equal(row.templateId, "video");
    assert.equal(row.aspectRatio, "portrait");
    const source = row.imageSource as Record<string, unknown> | null;
    assert.ok(source, "imageSource should be persisted");
    assert.equal(source!.type, "video");
    assert.equal(source!.videoObjectPath, videoPath);
    assert.equal(source!.stillObjectPath, stillPath);
    assert.equal(source!.lookStyleId, "cinematic");
    assert.equal(source!.motionPresetId, "subtle-push");
    assert.equal(source!.videoJobId, 42);
  });
});
