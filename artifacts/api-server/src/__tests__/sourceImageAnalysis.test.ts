/**
 * The source-photo analysis is the AI vision check alone (David, Q9, Issue
 * #945). The fal object detector it used to run first had no endpoint, so
 * every photo read as "no detectable subject", was refused as unusable, and
 * the vision check was never reached.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db, uploadImageMetadataTable } from "@workspace/db";
import { SOURCE_IMAGE_ANALYZER_VERSION } from "@workspace/api-zod";
import { analyzeSourceImage, __setTier3ForTest } from "../lib/sourceImageAnalysis/index.js";
import { Tier3VisionError } from "../lib/sourceImageAnalysis/tier3AiVisionFallback.js";

const PREFIX = `t-sia-${randomUUID().slice(0, 8)}`;
const FACE = {
  subjectKind: "human_face" as const,
  confidence: "high" as const,
  hasUsableHumanFace: true,
  hasUsableSubject: true,
  subjectCount: 1,
  subjectDescription: "a man smiling at the camera",
  suggestedRenderMode: "human_identity_i2i" as const,
  warnings: [],
};

async function upload(): Promise<string> {
  const objectPath = `${PREFIX}/${randomUUID()}.jpg`;
  await db.insert(uploadImageMetadataTable).values({ objectPath, width: 800, height: 600, fileSizeBytes: 1234 });
  return objectPath;
}
const cached = async (objectPath: string) =>
  (await db.select().from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.objectPath, objectPath)))[0]!;

afterEach(() => __setTier3ForTest(null));
after(async () => {
  await db.delete(uploadImageMetadataTable).where(like(uploadImageMetadataTable.objectPath, `${PREFIX}/%`));
});

describe("analyzeSourceImage: the AI vision check decides", () => {
  it("classifies a photo by the vision check, once, and caches the verdict under the current version", async () => {
    let calls = 0;
    __setTier3ForTest(async () => { calls++; return FACE; });
    const objectPath = await upload();
    const first = await analyzeSourceImage({ uploadedObjectPath: objectPath, imageUrl: "https://example.test/a.jpg" });
    assert.equal(first.subjectKind, "human_face");
    assert.equal(first.suggestedRenderMode, "human_identity_i2i", "a usable face is drawn from, not refused");
    assert.equal(first.classificationMethod, "ai_vision_fallback");
    assert.equal(calls, 1, "the vision check is called directly");
    const row = await cached(objectPath);
    assert.equal(row.sourceImageAnalysisVersion, SOURCE_IMAGE_ANALYZER_VERSION);
    await analyzeSourceImage({ uploadedObjectPath: objectPath, imageUrl: "https://example.test/a.jpg" });
    assert.equal(calls, 1, "a cached verdict is reused");
  });

  it("a verdict cached by the old detector's version is not reused", async () => {
    __setTier3ForTest(async () => FACE);
    const objectPath = await upload();
    await db.update(uploadImageMetadataTable).set({
      sourceImageAnalysis: { subjectKind: "scene_no_clear_subject", suggestedRenderMode: "t2i_fallback" } as never,
      sourceImageAnalysisVersion: "v2",
    }).where(eq(uploadImageMetadataTable.objectPath, objectPath));
    const result = await analyzeSourceImage({ uploadedObjectPath: objectPath, imageUrl: "https://example.test/b.jpg" });
    assert.equal(result.subjectKind, "human_face");
    assert.notEqual(SOURCE_IMAGE_ANALYZER_VERSION, "v2");
  });

  it("a failed or skipped check claims no subject and is not cached, so the next analysis asks again", async () => {
    const objectPath = await upload();
    __setTier3ForTest(async () => { throw new Tier3VisionError("model unavailable"); });
    const failed = await analyzeSourceImage({ uploadedObjectPath: objectPath, imageUrl: "https://example.test/c.jpg" });
    assert.equal(failed.classificationMethod, "not_analyzed");
    assert.equal(failed.hasUsableSubject, false);
    assert.match(failed.warnings[0] ?? "", /unavailable right now/);

    let called = false;
    __setTier3ForTest(async () => { called = true; return FACE; });
    const skipped = await analyzeSourceImage({ uploadedObjectPath: objectPath, imageUrl: "https://example.test/c.jpg" }, { skipAiFallback: true });
    assert.equal(skipped.classificationMethod, "not_analyzed");
    assert.equal(called, false, "a skip does not call the check");
    assert.equal((await cached(objectPath)).sourceImageAnalysis, null, "neither was cached");

    const retried = await analyzeSourceImage({ uploadedObjectPath: objectPath, imageUrl: "https://example.test/c.jpg" });
    assert.equal(retried.subjectKind, "human_face");
  });
});
