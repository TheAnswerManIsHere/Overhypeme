/**
 * POST /admin/taxonomy-health/actions/bulk-send-back (PR4 bulk send-back).
 *
 * Covers `pickSendBackTargets` classification (selected scope: dedupe,
 * not_active, already_in_review, not_applicable for both "not found" and "not
 * stale"), the all_stale silent-exclusion contract, the response's extra
 * count fields, zod validation, and the job-status skip metadata surfaced by
 * WI2.
 *
 * Note: enqueuing a job does NOT run it — `sendFactBackToReview` (and thus a
 * fact becoming "in review") only happens when the worker actually processes
 * the job. So "already in review" here is simulated by inserting a candidate
 * row directly, exactly like the existing `refreshInReview` test does.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db, factsTable, usersTable } from "@workspace/db";
import { asyncJobsTable, factEnrichmentVersionsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { buildPlaceholderFactEnrichment, CLASSIFICATION_PROMPT_VERSION, currentProcessingSignature, EMPTY_VISUAL_STRATEGY_OVERRIDE } from "@workspace/api-zod";

import adminTaxonomyHealthRouter from "../routes/adminTaxonomyHealth.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "ttha-bsb-";
const RUN = randomUUID().slice(0, 8);
const TEXT = (s: string) => `TTHA_BSB_${RUN} ${s}`;

function validEnrichment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["a", "b", "c"],
    taxonomyConfidence: 0.95,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    enrichedBy: "openai",
    visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "A hero stands tall." },
    ...overrides,
  };
}

const MATCHING_COLS = {
  primaryArchetype: "superhuman_physical_feat" as const,
  subtype: "force_scaled_action" as const,
  overhypeFit: "strong" as const,
  adultSuitability: "safe" as const,
};

describe("/admin/taxonomy-health/actions/bulk-send-back", () => {
  let adminUserId: string;
  let app: ReturnType<typeof buildTestApp>;
  const factIds: number[] = [];
  const jobIds: number[] = [];

  async function insertStaleFact(text: string, cols: Record<string, unknown> = {}): Promise<number> {
    const [r] = await db
      .insert(factsTable)
      .values({ text, submittedById: adminUserId, isActive: true, enrichment: validEnrichment(), ...MATCHING_COLS, ...cols })
      .returning({ id: factsTable.id });
    factIds.push(r!.id);
    return r!.id;
  }

  before(async () => {
    adminUserId = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({ id: adminUserId, email: `${adminUserId}@example.test`, isAdmin: true });
    app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminTaxonomyHealthRouter);
  });

  after(async () => {
    if (jobIds.length > 0) await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, jobIds));
    if (factIds.length > 0) {
      await db.delete(factEnrichmentVersionsTable).where(inArray(factEnrichmentVersionsTable.factId, factIds));
      await db.delete(factsTable).where(inArray(factsTable.id, factIds));
    }
    await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  });

  // ─── zod validation ───────────────────────────────────────────────────

  it("rejects a missing/invalid scope with 400", async () => {
    const res = await request(app).post("/api/admin/taxonomy-health/actions/bulk-send-back").send({});
    assert.equal(res.status, 400);
  });

  it("rejects selected scope with an empty factIds array", async () => {
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [] });
    assert.equal(res.status, 400);
  });

  // ─── response shape ───────────────────────────────────────────────────

  it("all_stale: response carries totalStale, eligibleRemaining, batchLimit and never exceeds the cap", async () => {
    const res = await request(app).post("/api/admin/taxonomy-health/actions/bulk-send-back").send({ scope: "all_stale" });
    assert.equal(res.status, 200);
    (res.body.jobs as Array<{ jobId: number }>).forEach((j) => jobIds.push(j.jobId));
    assert.equal(res.body.batchLimit, 50);
    assert.equal(typeof res.body.totalStale, "number");
    assert.equal(typeof res.body.eligibleRemaining, "number");
    assert.ok(res.body.eligibleRemaining >= 0);
    assert.ok(res.body.jobs.length <= 50, "server-enforced cap never exceeded");
  });

  it("all_stale: a 3-strike fact is excluded and counted in repeatedFailureCount; scope:selected still enqueues it normally (the only path that clears the streak)", async () => {
    const repeatedFailId = await insertStaleFact(TEXT("repeated failure excluded"));
    for (let i = 0; i < 3; i++) {
      const [row] = await db
        .insert(asyncJobsTable)
        .values({ queue: "fact_send_back", payload: { factId: repeatedFailId }, status: "failed", dedupeKey: `fact_send_back:${repeatedFailId}` })
        .returning({ id: asyncJobsTable.id });
      jobIds.push(row!.id);
    }

    const allStaleRes = await request(app).post("/api/admin/taxonomy-health/actions/bulk-send-back").send({ scope: "all_stale" });
    assert.equal(allStaleRes.status, 200);
    const allStaleFactIds = (allStaleRes.body.jobs as Array<{ jobId: number; factId: number }>).map((j) => {
      jobIds.push(j.jobId);
      return j.factId;
    });
    assert.ok(!allStaleFactIds.includes(repeatedFailId), "a 3-strike fact must never be enqueued by all_stale");
    assert.ok(allStaleRes.body.repeatedFailureCount >= 1, "repeatedFailureCount must reflect the excluded fact");

    const selectedRes = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [repeatedFailId] });
    assert.equal(selectedRes.status, 200);
    assert.equal(selectedRes.body.jobs.length, 1, "scope:selected must still enqueue a 3-strike fact — the deliberate manual-retry escape hatch");
    jobIds.push(selectedRes.body.jobs[0].jobId);
    assert.equal(selectedRes.body.outcomes.length, 0, "no skip/reject outcome — a normal queued enqueue");
  });

  it("all_stale: an in-flight fact is NEVER enqueued and produces NO skip outcome (silent exclusion)", async () => {
    const inFlightId = await insertStaleFact(TEXT("in-flight excluded"));
    await db.insert(factEnrichmentVersionsTable).values({
      factId: inFlightId, versionNo: 1, status: "candidate", source: "refresh_candidate",
    });
    const res = await request(app).post("/api/admin/taxonomy-health/actions/bulk-send-back").send({ scope: "all_stale" });
    assert.equal(res.status, 200);
    (res.body.jobs as Array<{ jobId: number; factId: number }>).forEach((j) => {
      jobIds.push(j.jobId);
      assert.notEqual(j.factId, inFlightId, "in-flight fact must never be enqueued");
    });
    const outcomeForFact = (res.body.outcomes as Array<{ factId: number }>).find((o) => o.factId === inFlightId);
    assert.equal(outcomeForFact, undefined, "all_stale silently excludes — no skip outcome for a pre-skipped row");
  });

  it("all_stale: a stale root with an active variant is eligible — variants classify from their own text, so a root refresh can't invalidate them", async () => {
    const rootId = await insertStaleFact(TEXT("variant root eligible"));
    const [variant] = await db
      .insert(factsTable)
      .values({ text: TEXT("variant child"), submittedById: adminUserId, isActive: true, parentId: rootId, enrichment: buildPlaceholderFactEnrichment() })
      .returning({ id: factsTable.id });
    factIds.push(variant!.id);
    const res = await request(app).post("/api/admin/taxonomy-health/actions/bulk-send-back").send({ scope: "all_stale" });
    assert.equal(res.status, 200);
    const jobFactIds = (res.body.jobs as Array<{ jobId: number; factId: number }>).map((j) => {
      jobIds.push(j.jobId);
      return j.factId;
    });
    assert.ok(jobFactIds.includes(rootId), "a root with an active variant must be enqueued like any other stale fact");
  });

  // ─── selected scope classification ─────────────────────────────────────

  it("selected: dedupes ids, enqueuing exactly one job per fact", async () => {
    const id = await insertStaleFact(TEXT("dedupe target"));
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [id, id, id] });
    assert.equal(res.status, 200);
    (res.body.jobs as Array<{ jobId: number }>).forEach((j) => jobIds.push(j.jobId));
    const jobsForFact = (res.body.jobs as Array<{ factId: number }>).filter((j) => j.factId === id);
    assert.equal(jobsForFact.length, 1, "a duplicated id enqueues only one job");
  });

  it("selected: an inactive fact → not_active", async () => {
    const [inactive] = await db
      .insert(factsTable)
      .values({ text: TEXT("inactive selected"), submittedById: adminUserId, isActive: false, enrichment: validEnrichment(), ...MATCHING_COLS })
      .returning({ id: factsTable.id });
    factIds.push(inactive!.id);
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [inactive!.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 0);
    assert.equal(res.body.outcomes.length, 1);
    assert.equal(res.body.outcomes[0].status, "skipped");
    assert.equal(res.body.outcomes[0].reason, "not_active");
  });

  it("selected: a nonexistent id → not_applicable", async () => {
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [999_999_999] });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcomes[0].status, "skipped");
    assert.equal(res.body.outcomes[0].reason, "not_applicable");
  });

  it("selected: an active but non-stale fact (current signature stamped) → not_applicable", async () => {
    const summaryRes = await request(app).get("/api/admin/taxonomy-health/summary");
    const currentSig = currentProcessingSignature(summaryRes.body.engineRevision as number);
    const [fresh] = await db
      .insert(factsTable)
      .values({
        text: TEXT("not stale"), submittedById: adminUserId, isActive: true,
        enrichment: validEnrichment(), lastProcessedSignature: currentSig,
        ...MATCHING_COLS,
      })
      .returning({ id: factsTable.id });
    factIds.push(fresh!.id);
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [fresh!.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcomes[0].status, "skipped");
    assert.equal(res.body.outcomes[0].reason, "not_applicable");
  });

  it("selected: an already-in-flight stale fact → already_in_review (idempotent, never double-queued)", async () => {
    const id = await insertStaleFact(TEXT("already in flight"));
    await db.insert(factEnrichmentVersionsTable).values({
      factId: id, versionNo: 1, status: "candidate", source: "refresh_candidate",
    });
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 0, "never double-queued");
    assert.equal(res.body.outcomes[0].status, "skipped");
    assert.equal(res.body.outcomes[0].reason, "already_in_review");
  });

  it("selected: a stale root with an active variant still enqueues — variants classify from their own text, so a root refresh can't invalidate them", async () => {
    const rootId = await insertStaleFact(TEXT("selected variant root"));
    const [variant] = await db
      .insert(factsTable)
      .values({ text: TEXT("selected variant child"), submittedById: adminUserId, isActive: true, parentId: rootId, enrichment: buildPlaceholderFactEnrichment() })
      .returning({ id: factsTable.id });
    factIds.push(variant!.id);
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [rootId] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 1);
    jobIds.push(res.body.jobs[0].jobId);
    assert.equal(res.body.outcomes.length, 0);
  });

  it("selected: an eligible stale fact enqueues with the fact_send_back dedupe key", async () => {
    const id = await insertStaleFact(TEXT("eligible enqueue"));
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/bulk-send-back")
      .send({ scope: "selected", factIds: [id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 1);
    const job = res.body.jobs[0];
    jobIds.push(job.jobId);
    assert.equal(job.factId, id);
    assert.equal(job.action, "send_back_to_review");
    assert.equal(job.dedupeKey, `fact_send_back:${id}`);
  });
});

// ─── job-status skip metadata (WI2) ────────────────────────────────────────

describe("/admin/taxonomy-health/job-status — skip metadata", () => {
  let adminUserId: string;
  let app: ReturnType<typeof buildTestApp>;
  const jobIds: number[] = [];

  before(async () => {
    adminUserId = `${USER_PREFIX}js-${randomUUID()}`;
    await db.insert(usersTable).values({ id: adminUserId, email: `${adminUserId}@example.test`, isAdmin: true });
    app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminTaxonomyHealthRouter);
  });

  after(async () => {
    if (jobIds.length > 0) await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, jobIds));
    await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
  });

  async function insertDoneJob(result: unknown): Promise<number> {
    const [row] = await db
      .insert(asyncJobsTable)
      .values({ queue: "fact_send_back", payload: {}, status: "done", result })
      .returning({ id: asyncJobsTable.id });
    jobIds.push(row!.id);
    return row!.id;
  }

  it("a done job with a known skip reason surfaces skipped + skipReason", async () => {
    const jobId = await insertDoneJob({ skipped: true, reason: "already_in_review" });
    const res = await request(app).post("/api/admin/taxonomy-health/job-status").send({ jobs: [{ jobId }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs[0].skipped, true);
    assert.equal(res.body.jobs[0].skipReason, "already_in_review");
  });

  it("a done job with an unknown skip reason surfaces neither field", async () => {
    const jobId = await insertDoneJob({ skipped: true, reason: "not_a_real_reason" });
    const res = await request(app).post("/api/admin/taxonomy-health/job-status").send({ jobs: [{ jobId }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs[0].skipped, undefined);
    assert.equal(res.body.jobs[0].skipReason, undefined);
  });

  it("a done job with a normal (non-skip) result surfaces neither field", async () => {
    const jobId = await insertDoneJob({ reviewId: 1, candidateVersionId: 2, versionNo: 1 });
    const res = await request(app).post("/api/admin/taxonomy-health/job-status").send({ jobs: [{ jobId }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs[0].skipped, undefined);
  });
});
