/**
 * @purpose Proves a generated fact background is recorded where the meme builder reads it (the fact's gallery and the requesting account's AI images) and never as anyone's own uploaded photo, with no failure swallowed on the way (#806).
 * @subsystem visual-pipeline
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { factsTable, uploadImageMetadataTable, userAiImagesTable, usersTable, type ImagePromptAttempt } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { mirrorToLegacyStorage } from "../lib/imagePromptJobs.js";
import { logger } from "../lib/logger.js";
import { userOwnsUpload } from "../lib/uploadOwnership.js";

const PREFIX = "t-ipm-";
const factIds: number[] = [];

async function cleanup(): Promise<void> {
  await db.delete(userAiImagesTable).where(like(userAiImagesTable.userId, `${PREFIX}%`));
  await db.delete(uploadImageMetadataTable).where(like(uploadImageMetadataTable.objectPath, `/objects/ai-bg-v2/${PREFIX}%`));
  if (factIds.length > 0) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("a generated fact background is mirrored, never recorded as an upload (#806)", () => {
  it("lands in the fact's gallery and the account's AI images, with no upload row and nothing swallowed", async () => {
    const userId = `${PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({ id: userId, email: `${userId}@test.local`, displayName: "Tester", pronouns: "they/them" });
    const [fact] = await db
      .insert(factsTable)
      .values({ text: `${PREFIX}fact {NAME}`, isActive: true, enrichment: buildPlaceholderFactEnrichment(), canonicalText: `${PREFIX}fact` })
      .returning();
    factIds.push(fact!.id);
    const storedPath = `/objects/ai-bg-v2/${PREFIX}${fact!.id}/1-${Date.now()}.png`;
    const attempt = { id: 1, factId: fact!.id, userId, renderControls: {} } as unknown as ImagePromptAttempt;

    const warn = mock.method(logger, "warn");
    try {
      await mirrorToLegacyStorage(attempt, storedPath);
      assert.equal(warn.mock.callCount(), 0, `nothing is swallowed: ${JSON.stringify(warn.mock.calls.map((c) => c.arguments))}`);
    } finally {
      warn.mock.restore();
    }

    const [after] = await db.select({ aiMemeImages: factsTable.aiMemeImages }).from(factsTable).where(eq(factsTable.id, fact!.id));
    assert.deepEqual((after!.aiMemeImages as Record<string, string[]>).neutral, [storedPath]);
    const aiRows = await db.select().from(userAiImagesTable).where(eq(userAiImagesTable.storagePath, storedPath));
    assert.equal(aiRows.length, 1);
    const uploadRows = await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, storedPath));
    assert.equal(uploadRows.length, 0, "a shared background is not anyone's upload");
    assert.equal(await userOwnsUpload(storedPath, userId), false);
  });
});
