/**
 * Unit tests for the `fact_send_back` async-job handler (PR4 bulk send-back).
 *
 *   • success creates a candidate + refresh review and returns its ids
 *   • each `sendFactBackToReview` guard maps to a terminal SKIP (not retried)
 *   • an unexpected error is returned as `ok:false` (retried by the worker)
 *   • REFRESH_ALREADY_IN_PROGRESS recovery: defensively re-enqueues the
 *     candidate enrichment job before retiring as a clean skip, handling both
 *     an `existing` payload and a missing one (fresh lookup fallback)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  pendingReviewsTable,
  factEnrichmentVersionsTable,
  asyncJobsTable,
} from "@workspace/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import {
  factSendBackHandler,
  sendBackGuardToSkip,
  recoverInFlightRefresh,
} from "../lib/factSendBackJob.js";
import { SendBackToReviewError } from "../lib/sendBackToReview.js";

const USER_PREFIX = "t_fsbj_";
const insertedFactIds: number[] = [];
let adminId: string;

async function seedActiveFact(overrides: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: `{NAME} does something #${randomUUID().slice(0, 8)}.`,
      submittedById: adminId,
      isActive: true,
      enrichment: buildPlaceholderFactEnrichment(),
      enrichmentStatus: "ok",
      ...overrides,
    } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  return fact!.id;
}

/** Directly creates a candidate + prep_pending review WITHOUT an enrichment job — the exact stranded shape strand-recovery must heal. */
async function seedStrandedRefreshCandidate(factId: number): Promise<{ candidateVersionId: number; reviewId: number }> {
  const [candidate] = await db
    .insert(factEnrichmentVersionsTable)
    .values({
      factId,
      versionNo: 1,
      status: "candidate",
      enrichmentOverrides: {},
      source: "refresh_candidate",
      factTextHash: "test-hash",
    })
    .returning({ id: factEnrichmentVersionsTable.id });
  const [review] = await db
    .insert(pendingReviewsTable)
    .values({
      submittedText: "seed",
      status: "pending",
      workflowStage: "prep_pending",
      stagingFactId: factId,
      candidateVersionId: candidate!.id,
    })
    .returning({ id: pendingReviewsTable.id });
  return { candidateVersionId: candidate!.id, reviewId: review!.id };
}

async function cleanup() {
  if (insertedFactIds.length) {
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, insertedFactIds));
    await db.delete(factEnrichmentVersionsTable).where(inArray(factEnrichmentVersionsTable.factId, insertedFactIds));
    await db.delete(asyncJobsTable).where(and(eq(asyncJobsTable.queue, "enrichment")));
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@example.test`, isAdmin: true });
});

after(cleanup);

describe("factSendBackHandler", () => {
  it("success: creates a candidate + refresh review and returns the ids", async () => {
    const factId = await seedActiveFact();
    const result = await factSendBackHandler.run({ factId, adminId }, {} as never);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    const r = result.result as { reviewId: number; candidateVersionId: number; versionNo: number };
    assert.equal(typeof r.reviewId, "number");
    assert.equal(typeof r.candidateVersionId, "number");
    assert.equal(r.versionNo, 1);

    const [candidate] = await db
      .select()
      .from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, r.candidateVersionId));
    assert.equal(candidate.status, "candidate");
    const [review] = await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, r.reviewId));
    assert.equal(review.workflowStage, "prep_pending");
  });

  it("NOT_ACTIVE guard → terminal skip, not a retryable failure", async () => {
    const factId = await seedActiveFact({ isActive: false });
    const result = await factSendBackHandler.run({ factId }, {} as never);
    assert.equal(result.ok, true, "a guard rejection is a clean skip, never ok:false");
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "not_active" });
  });

  it("HAS_ACTIVE_VARIANTS guard → terminal skip", async () => {
    const root = await seedActiveFact();
    await seedActiveFact({ parentId: root });
    const result = await factSendBackHandler.run({ factId: root }, {} as never);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "has_active_variants" });
  });

  it("missing factId payload → ok:false", async () => {
    const result = await factSendBackHandler.run({}, {} as never);
    assert.equal(result.ok, false);
  });

  it("unexpected error (fact not found) → ok:false, retried", async () => {
    const result = await factSendBackHandler.run({ factId: 999_999_999 }, {} as never);
    assert.equal(result.ok, false);
  });

  it("REFRESH_ALREADY_IN_PROGRESS: re-enqueues the candidate enrichment job before skipping", async () => {
    const factId = await seedActiveFact();
    const { candidateVersionId } = await seedStrandedRefreshCandidate(factId);
    // No enrichment job exists yet for this candidate — the exact strand shape.
    const before_ = await db
      .select()
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.dedupeKey, `enrichment:version:${candidateVersionId}`));
    assert.equal(before_.length, 0);

    const result = await factSendBackHandler.run({ factId }, {} as never);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "already_in_review" });

    const after_ = await db
      .select()
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.dedupeKey, `enrichment:version:${candidateVersionId}`));
    assert.equal(after_.length, 1, "strand-recovery must leave an enrichment job queued for the existing candidate");
    assert.equal(after_[0]!.queue, "enrichment");
  });
});

describe("sendBackGuardToSkip", () => {
  it("maps each guard code to a reason; FACT_NOT_FOUND is not a guard skip", () => {
    assert.equal(sendBackGuardToSkip("NOT_ACTIVE")?.reason, "not_active");
    assert.equal(sendBackGuardToSkip("HAS_ACTIVE_VARIANTS")?.reason, "has_active_variants");
    assert.equal(sendBackGuardToSkip("REFRESH_ALREADY_IN_PROGRESS")?.reason, "already_in_review");
    assert.equal(sendBackGuardToSkip("FACT_NOT_FOUND"), null);
  });
});

describe("recoverInFlightRefresh", () => {
  it("uses err.existing when present — enqueues + skips", async () => {
    const factId = await seedActiveFact();
    const { candidateVersionId, reviewId } = await seedStrandedRefreshCandidate(factId);
    const err = new SendBackToReviewError("REFRESH_ALREADY_IN_PROGRESS", "x", { reviewId, candidateVersionId });
    const result = await recoverInFlightRefresh(factId, err);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "already_in_review" });
    const jobs = await db
      .select()
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.dedupeKey, `enrichment:version:${candidateVersionId}`));
    assert.equal(jobs.length, 1);
  });

  it("missing existing: falls back to a fresh lookup and still recovers", async () => {
    const factId = await seedActiveFact();
    const { candidateVersionId } = await seedStrandedRefreshCandidate(factId);
    const err = new SendBackToReviewError("REFRESH_ALREADY_IN_PROGRESS", "x"); // no `existing`
    const result = await recoverInFlightRefresh(factId, err);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.result, { skipped: true, reason: "already_in_review" });
    const jobs = await db
      .select()
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.dedupeKey, `enrichment:version:${candidateVersionId}`));
    assert.equal(jobs.length, 1);
  });

  it("missing existing AND no in-flight candidate found → ok:false (never masks a possible strand)", async () => {
    const factId = await seedActiveFact(); // no candidate ever created
    const err = new SendBackToReviewError("REFRESH_ALREADY_IN_PROGRESS", "x");
    const result = await recoverInFlightRefresh(factId, err);
    assert.equal(result.ok, false, "must not falsely retire as a clean skip when nothing could be resolved");
  });
});
