/**
 * Regression lock for the subject_fact_compatibility_poor block removal.
 *
 * The invariant under test: subjectFactCompatibility is advisory only and NEVER
 * gates whether image_generation is enqueued — a "poor" (or "risky") rating must
 * still persist the advisory rating, leave `error` NULL, and chain the SAME
 * image_generation job (queue + dedupe key) as any other successful attempt.
 *
 * This is deterministic proof of the removed gate: a live Replit render can't
 * prove it because the planner runs at nonzero temperature and may not redraw
 * "poor" on a rerun.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, imagePromptAttemptsTable, asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import { persistImagePromptPlanAndEnqueueGeneration, IMAGE_GENERATION_QUEUE } from "../lib/imagePromptJobs.js";

const USER_PREFIX = "t_ipj_";

const VALID_ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

let userId: string;
const insertedFactIds: number[] = [];
const insertedAttemptIds: number[] = [];

async function seedAttempt(): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: "{NAME} bench-presses the Earth.",
      submittedById: userId,
      isActive: false,
      enrichment: VALID_ENRICHMENT,
    })
    .returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);

  const [attempt] = await db
    .insert(imagePromptAttemptsTable)
    .values({
      factId: fact!.id,
      userId,
      renderJobId: randomUUID(),
      generationMode: "t2i",
      subjectRenderMode: "t2i_fallback",
      targetEngine: "nano_banana_2",
      sourceImageAnalysis: {} as never,
      identityPolicy: {} as never,
      renderControls: { aspectRatio: "portrait" } as never,
      factEnrichmentSnapshot: VALID_ENRICHMENT as never,
      archetypeStrategyVersion: "v2",
    })
    .returning({ id: imagePromptAttemptsTable.id });
  insertedAttemptIds.push(attempt!.id);
  return attempt!.id;
}

async function cleanup() {
  if (insertedAttemptIds.length) {
    await db
      .delete(asyncJobsTable)
      .where(
        inArray(
          asyncJobsTable.dedupeKey,
          insertedAttemptIds.map((id) => `image_generation:attempt:${id}`),
        ),
      );
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.id, insertedAttemptIds));
    insertedAttemptIds.length = 0;
  }
  if (insertedFactIds.length) {
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
}

before(async () => {
  userId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: userId,
    email: `${userId}@test.local`,
    isAdmin: false,
    membershipTier: "registered",
    captchaVerified: true,
  });
});

after(async () => {
  await cleanup();
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("persistImagePromptPlanAndEnqueueGeneration — compatibility rating never blocks", () => {
  for (const rating of ["poor", "risky"] as const) {
    it(`${rating}: persists the advisory rating, leaves error NULL, and enqueues image_generation`, async () => {
      const attemptId = await seedAttempt();
      const compatibility = { rating, reason: "test", recommendedFallback: "none" };

      await persistImagePromptPlanAndEnqueueGeneration({
        attemptId,
        visualPlan: { coreScene: "test scene" } as never,
        compiledPrompt: { prompt: "test prompt", imagePrompt: "test prompt" } as never,
        subjectFactCompatibility: compatibility,
        archetypeStrategyVersion: "v2",
      });

      const [row] = await db
        .select()
        .from(imagePromptAttemptsTable)
        .where(eq(imagePromptAttemptsTable.id, attemptId));
      assert.equal(row!.error, null);
      assert.deepEqual(row!.subjectFactCompatibility, compatibility);

      const [job] = await db
        .select()
        .from(asyncJobsTable)
        .where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
      assert.ok(job, "expected an image_generation job to be enqueued");
      assert.equal(job!.queue, IMAGE_GENERATION_QUEUE);
      assert.equal((job!.payload as { attemptId: number }).attemptId, attemptId);
      assert.equal(job!.status, "pending");
    });
  }
});
