/**
 * DB-backed tests for the approved-fact-text protection + dependency loader.
 *
 * The predicate FAILS CLOSED — only a single, unresolved, first-time staging
 * cycle on an inactive fact is unprotected; every other shape (live, ever-
 * approved, ambiguous multi-review, lone refresh, orphan) is protected. These
 * cases are exactly the ones ChatGPT flagged as unprovable through the
 * `LIMIT 1` helper, so the matrix is the point of this file.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

import {
  resolveFactTextProtection,
  loadDirectVariantDependencies,
  hasNonterminalPrepJobs,
} from "../lib/factTextEditProtection.js";

const USER_PREFIX = "t_ftep_";
const factIds: number[] = [];
let adminId: string;

async function seedFact(overrides: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: `{NAME} does a thing #${randomUUID().slice(0, 8)}.`,
      submittedById: adminId,
      isActive: false,
      ...overrides,
    } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  factIds.push(fact!.id);
  return fact!.id;
}

async function seedReview(v: Partial<typeof pendingReviewsTable.$inferInsert>): Promise<number> {
  const [r] = await db
    .insert(pendingReviewsTable)
    .values({ submittedText: "x", status: "pending", ...v } as typeof pendingReviewsTable.$inferInsert)
    .returning({ id: pendingReviewsTable.id });
  return r!.id;
}

/** Read the fact's current isActive so the caller mirrors the locked-row contract. */
async function activeOf(factId: number): Promise<boolean> {
  const [f] = await db.select({ isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  return f!.isActive;
}

before(async () => {
  adminId = `${USER_PREFIX}${randomUUID().slice(0, 8)}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@t.dev`, isAdmin: true } as typeof usersTable.$inferInsert);
});

after(async () => {
  if (factIds.length) {
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.dedupeKey, factIds.flatMap((id) => [`enrichment:fact:${id}`, `fact_pexels:fact:${id}`])));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("resolveFactTextProtection — fail-closed matrix", () => {
  it("live fact → protected(active)", async () => {
    const id = await seedFact({ isActive: true });
    const s = await resolveFactTextProtection(id, await activeOf(id));
    assert.deepEqual(s, { protected: true, reason: "active" });
  });

  it("soft-deleted but production-approved → protected(ever_approved)", async () => {
    const id = await seedFact({ isActive: false });
    await seedReview({ stagingFactId: id, approvedFactId: id, workflowStage: "production_approved", status: "approved" });
    const s = await resolveFactTextProtection(id, await activeOf(id));
    assert.deepEqual(s, { protected: true, reason: "ever_approved" });
  });

  it("inactive orphan (no reviews) → protected(orphan_or_legacy)", async () => {
    const id = await seedFact({ isActive: false });
    const s = await resolveFactTextProtection(id, await activeOf(id));
    assert.deepEqual(s, { protected: true, reason: "orphan_or_legacy" });
  });

  it("exactly one unresolved first-time cycle → UNPROTECTED(single_first_time_staging)", async () => {
    const id = await seedFact({ isActive: false });
    const reviewId = await seedReview({ stagingFactId: id, workflowStage: "concept_review", candidateVersionId: null });
    const s = await resolveFactTextProtection(id, await activeOf(id));
    assert.equal(s.protected, false);
    assert.equal(s.reason, "single_first_time_staging");
    if (!s.protected) {
      assert.equal(s.reviewId, reviewId);
      assert.equal(s.workflowStage, "concept_review");
    }
  });

  it("two unresolved first-time rows → protected(ambiguous)", async () => {
    const id = await seedFact({ isActive: false });
    await seedReview({ stagingFactId: id, workflowStage: "concept_review", candidateVersionId: null });
    await seedReview({ stagingFactId: id, workflowStage: "prep_pending", candidateVersionId: null });
    const s = await resolveFactTextProtection(id, await activeOf(id));
    assert.deepEqual(s, { protected: true, reason: "ambiguous_unresolved_reviews" });
  });

  it("a lone unresolved REFRESH cycle on an inactive fact → protected(ambiguous)", async () => {
    const id = await seedFact({ isActive: false });
    await seedReview({ stagingFactId: id, workflowStage: "concept_review", candidateVersionId: 999999 });
    const s = await resolveFactTextProtection(id, await activeOf(id));
    assert.deepEqual(s, { protected: true, reason: "ambiguous_unresolved_reviews" });
  });

  it("resolved historical rows do NOT make a single unresolved first-time row ambiguous", async () => {
    const id = await seedFact({ isActive: false });
    await seedReview({ stagingFactId: id, workflowStage: "triage_rejected", status: "rejected", candidateVersionId: null });
    await seedReview({ stagingFactId: id, workflowStage: "prep_pending", candidateVersionId: null });
    const s = await resolveFactTextProtection(id, await activeOf(id));
    assert.equal(s.protected, false);
    assert.equal(s.reason, "single_first_time_staging");
  });
});

describe("loadDirectVariantDependencies", () => {
  it("lists direct children and flags none when all idle", async () => {
    const root = await seedFact({ isActive: true });
    const c1 = await seedFact({ isActive: true, parentId: root });
    const c2 = await seedFact({ isActive: true, parentId: root });
    const dep = await loadDirectVariantDependencies(root);
    assert.deepEqual(dep.childFactIds.sort((a, b) => a - b), [c1, c2].sort((a, b) => a - b));
    assert.equal(dep.blockingChildren.length, 0);
  });

  it("flags a child with an unresolved review as blocking", async () => {
    const root = await seedFact({ isActive: true });
    const child = await seedFact({ isActive: false, parentId: root });
    await seedReview({ stagingFactId: child, workflowStage: "concept_review", candidateVersionId: null });
    const dep = await loadDirectVariantDependencies(root);
    assert.deepEqual(dep.blockingChildren, [{ factId: child, reason: "unresolved_review" }]);
  });

  it("flags a child with a nonterminal enrichment job as blocking", async () => {
    const root = await seedFact({ isActive: true });
    const child = await seedFact({ isActive: true, parentId: root });
    await db.insert(asyncJobsTable).values({ queue: "enrichment", payload: {}, dedupeKey: `enrichment:fact:${child}`, status: "processing" } as typeof asyncJobsTable.$inferInsert);
    const dep = await loadDirectVariantDependencies(root);
    assert.deepEqual(dep.blockingChildren, [{ factId: child, reason: "active_enrichment_job" }]);
  });

  it("no children → empty", async () => {
    const root = await seedFact({ isActive: true });
    const dep = await loadDirectVariantDependencies(root);
    assert.deepEqual(dep, { childFactIds: [], blockingChildren: [] });
  });
});

describe("hasNonterminalPrepJobs", () => {
  it("true when a nonterminal enrichment job exists, false when only terminal", async () => {
    const id = await seedFact({ isActive: false });
    assert.equal(await hasNonterminalPrepJobs({ factId: id, reviewId: 123 }), false);
    await db.insert(asyncJobsTable).values({ queue: "enrichment", payload: {}, dedupeKey: `enrichment:fact:${id}`, status: "done" } as typeof asyncJobsTable.$inferInsert);
    assert.equal(await hasNonterminalPrepJobs({ factId: id, reviewId: 123 }), false, "a terminal (done) job must not count");
    await db.insert(asyncJobsTable).values({ queue: "fact_pexels", payload: {}, dedupeKey: `fact_pexels:fact:${id}`, status: "pending" } as typeof asyncJobsTable.$inferInsert);
    assert.equal(await hasNonterminalPrepJobs({ factId: id, reviewId: 123 }), true, "a pending pexels job counts");
  });
});
