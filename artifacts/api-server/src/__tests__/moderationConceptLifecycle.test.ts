/**
 * Lifecycle test for the Step-2 rewire: a first-time staging-fact enrichment
 * SUCCESS now advances prep_pending → concept_review, enqueues the Visual-Idea
 * concept job, and enqueues NO render-prepare job (renders are Step 3, fired only
 * at gag approval). Terminal failure still lands at prep_failed.
 *
 * Exercises advanceReviewForStagingFactEnrichment directly (no HTTP). Seeds under
 * the `t_mcl_` prefix.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, asyncJobsTable } from "@workspace/db/schema";
import { and, eq, gte, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import { advanceReviewForStagingFactEnrichment } from "../lib/moderationStaging.js";

const USER_PREFIX = "t_mcl_";
const TEST_FILE_START = new Date();
const CONCEPTS_QUEUE = "fact_visual_concepts";
const PREPARE_QUEUE = "review_render_scenarios_prepare";

const VALID_ENRICHMENT: FactEnrichment = {
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
} as FactEnrichment;

async function createUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, membershipTier: "registered" });
  return id;
}

async function seedPrepPending(userId: string): Promise<{ reviewId: number; factId: number }> {
  const [fact] = await db.insert(factsTable).values({
    text: "{NAME} bench-presses the Earth.",
    submittedById: userId,
    isActive: false,
    enrichment: VALID_ENRICHMENT,
  }).returning({ id: factsTable.id });
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: "{NAME} bench-presses the Earth.",
    submittedById: userId,
    status: "pending",
    workflowStage: "prep_pending",
    stagingFactId: fact!.id,
  }).returning({ id: pendingReviewsTable.id });
  return { reviewId: review!.id, factId: fact!.id };
}

async function jobsFor(queue: string, reviewId: number): Promise<number> {
  const rows = await db
    .select({ payload: asyncJobsTable.payload })
    .from(asyncJobsTable)
    .where(and(eq(asyncJobsTable.queue, queue), gte(asyncJobsTable.createdAt, TEST_FILE_START)));
  return rows.filter((r) => (r.payload as { reviewId?: number })?.reviewId === reviewId).length;
}

async function cleanup() {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  for (const u of users) {
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, u.id));
    await db.delete(factsTable).where(eq(factsTable.submittedById, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

let userId: string;

before(async () => { await cleanup(); userId = await createUser(); });
after(async () => {
  await cleanup();
  await db.delete(asyncJobsTable).where(and(
    like(asyncJobsTable.queue, "%"),
    gte(asyncJobsTable.createdAt, TEST_FILE_START),
  ));
});

describe("advanceReviewForStagingFactEnrichment — Step-2 rewire", () => {
  it("success → concept_review, enqueues concepts, enqueues NO render-prepare", async () => {
    const { reviewId, factId } = await seedPrepPending(userId);
    await advanceReviewForStagingFactEnrichment({ factId, outcome: "success" });

    const [review] = await db.select({ stage: pendingReviewsTable.workflowStage }).from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review!.stage, "concept_review", "advances to Step 2, not production_review");

    const [fact] = await db.select({ vcs: factsTable.visualConceptStatus }).from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(fact!.vcs, "pending", "visual concept status set pending");

    assert.equal(await jobsFor(CONCEPTS_QUEUE, reviewId), 1, "one visual-concept job enqueued");
    assert.equal(await jobsFor(PREPARE_QUEUE, reviewId), 0, "NO render-prepare job at enrichment success");
  });

  it("terminal failure → prep_failed, no concepts, no render-prepare", async () => {
    const { reviewId, factId } = await seedPrepPending(userId);
    await advanceReviewForStagingFactEnrichment({ factId, outcome: "terminal_failed" });

    const [review] = await db.select({ stage: pendingReviewsTable.workflowStage }).from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId));
    assert.equal(review!.stage, "prep_failed");
    assert.equal(await jobsFor(CONCEPTS_QUEUE, reviewId), 0);
    assert.equal(await jobsFor(PREPARE_QUEUE, reviewId), 0);
  });
});
