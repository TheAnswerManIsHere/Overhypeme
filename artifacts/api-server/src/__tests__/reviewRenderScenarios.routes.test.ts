/**
 * Integration tests for a gag's kind renders
 * (lib/reviewRenderScenarios.ts). The review-wide scenario grid, its routes
 * and the waivable visual-render gate were retired by plan
 * PLAN_GAG_EXAMPLES.md: renders are per gag and per kind (male, female, pet),
 * and a changed input draws afresh rather than marking an old render stale.
 *
 * No worker runs in tests, so we assert enqueued attempts rather than
 * finished images. fal uploads are stubbed off the network.
 * Seeds rows under the `t_rrs_` user prefix.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, factGagsTable, pendingReviewsTable, imagePromptAttemptsTable, asyncJobsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import { type FactEnrichment } from "@workspace/api-zod";

import { withCast } from "./helpers/gagCast.js";
import { drawGagKinds } from "../lib/reviewRenderScenarios.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";

const USER_PREFIX = "t_rrs_";
const TEST_FILE_START = new Date();

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "legendary", "earth"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
  characters: [],
};

// A fact reaching production_review has an approved gag (fact_gags, migration 0139).
const GAG = withCast({
  version: 1 as const,
  coreSceneOverride: "{NAME} bench-presses the Earth overhead in a stadium.",
  requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
  bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
});

const insertedFactIds: number[] = [];
const gagOf = new Map<number, number>();

async function createUser(isAdmin: boolean): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id, email: `${id}@test.local`, isAdmin,
    membershipTier: isAdmin ? "legendary" : "registered", emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
  });
  return id;
}

async function seedReview(submittedById: string, stage = "test_renders"): Promise<number> {
  const [fact] = await db.insert(factsTable).values({
    text: "{NAME} bench-presses the Earth.", submittedById, isActive: false, enrichment: ENRICHMENT,
  }).returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  // A submission's gag is in its draft (migration 0157).
  await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, pendingContent: GAG });
  gagOf.set(fact!.id, (await db.select({ id: factGagsTable.id }).from(factGagsTable).where(eq(factGagsTable.factId, fact!.id)))[0]!.id);
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: "{NAME} bench-presses the Earth.", submittedById, matchingSimilarity: 0,
    status: "pending", workflowStage: stage as never, stagingFactId: fact!.id,
    enrichment: ENRICHMENT, enrichmentStatus: "ok",
  }).returning({ id: pendingReviewsTable.id });
  return review!.id;
}

let adminId: string;

async function cleanup() {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  if (insertedFactIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, insertedFactIds));
  }
  for (const u of users) {
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  insertedFactIds.length = 0;
}

// One wrapper scopes the file-level hooks to this file: with test isolation off,
// root-level hooks run for the whole shard, so another file's cleanup could
// clear this file's fal stub before its tests ran.
describe("review render scenarios", () => {
before(async () => {
  await cleanup();
  // Stub fal uploads so the i2i (male) reference resolves without a network call.
  __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
  adminId = await createUser(true);
});

after(async () => {
  __setReferenceFalUploadForTest(null);
  await cleanup();
  await db.delete(asyncJobsTable).where(and(
    inArray(asyncJobsTable.queue, ["image_prompt_generation", "review_render_scenarios_prepare"]),
    gte(asyncJobsTable.createdAt, TEST_FILE_START),
  ));
});

describe("a gag's renders and the stored taxonomy", () => {
  it("a changed stored taxonomy leaves prior renders current (the picture is drawn from the gag alone)", async () => {
    const submitterId = await createUser(false);
    const reviewId = await seedReview(submitterId);
    const [{ stagingFactId }] = await db
      .select({ stagingFactId: pendingReviewsTable.stagingFactId })
      .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);

    const gagId = gagOf.get(stagingFactId as number)!;
    // A male render against the ORIGINAL enrichment; drawing again reuses it.
    const first = await drawGagKinds(gagId, ["male"], { adminUserId: adminId });
    assert.ok(!("error" in first), JSON.stringify(first));
    assert.equal(first.enqueued.length, 1);
    const again = await drawGagKinds(gagId, ["male"], { adminUserId: adminId });
    assert.ok(!("error" in again));
    assert.equal(again.enqueued.length, 0, "the same input reuses its render");

    // A changed stored taxonomy (a Re-run's result: visualComplexity medium → high).
    await db.update(factsTable)
      .set({ enrichment: { ...ENRICHMENT, visualComplexity: "high" } })
      .where(eq(factsTable.id, stagingFactId as number));

    // A classification edit shapes no picture since the switch
    // (PLAN_GAG_DIRECT_RENDER.md, D): the earlier render still matches and is reused.
    const after = await drawGagKinds(gagId, ["male"], { adminUserId: adminId });
    assert.ok(!("error" in after));
    assert.equal(after.enqueued.length, 0, "the earlier render is reused after the taxonomy changes");
  });

});

});
