/**
 * Admin Taxonomy Health action + filter behavior (DB-backed).
 *
 * Inserts facts in known health states under a per-run text prefix (so list
 * queries are isolated from other shards), then exercises:
 *   • Healthy filter returns healthy rows only (not everything).
 *   • Semantic-entities filter includes the info-level capitalization hint.
 *   • Re-enrich protects admin-edited rows by default (skipped outcome) and
 *     queues a concrete job when force-overwrite is set.
 *   • Regenerate Visual Plan returns concrete job descriptors.
 *   • job-status polls by concrete id and handles unknown ids safely.
 *   • Repair projections resolves inline with terminal outcomes.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db, factsTable, usersTable } from "@workspace/db";
import { asyncJobsTable, factEnrichmentVersionsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { CLASSIFICATION_PROMPT_VERSION, currentProcessingSignature, EMPTY_VISUAL_STRATEGY_OVERRIDE } from "@workspace/api-zod";

import adminTaxonomyHealthRouter from "../routes/adminTaxonomyHealth.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "ttha-act-";
const RUN = randomUUID().slice(0, 8);
const TEXT = (s: string) => `TTHA_${RUN} ${s}`;

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

describe("/admin/taxonomy-health — actions & filters", () => {
  let adminUserId: string;
  let app: ReturnType<typeof buildTestApp>;
  const factIds: number[] = [];
  const jobIds: number[] = [];
  let healthyId = 0;
  let capHintId = 0;
  let missingId = 0;
  let adminStaleId = 0;
  let mismatchId = 0;

  async function insertFact(
    text: string,
    enrichment: Record<string, unknown> | null,
    cols: Partial<Record<"primaryArchetype" | "subtype" | "overhypeFit" | "adultSuitability", string>>,
  ): Promise<number> {
    const [r] = await db
      .insert(factsTable)
      // A fully-missing enrichment blob can no longer satisfy the DB's
      // facts_active_requires_concept CHECK, so this fixture models it as an
      // inactive (never-activated) fact — matching the new invariant that an
      // active fact always carries a concept.
      .values({ text, submittedById: adminUserId, enrichment, isActive: enrichment != null, ...cols })
      .returning({ id: factsTable.id });
    factIds.push(r!.id);
    return r!.id;
  }

  before(async () => {
    adminUserId = `${USER_PREFIX}${randomUUID()}`;
    await db.insert(usersTable).values({
      id: adminUserId,
      email: `${adminUserId}@example.test`,
      profileImageUrl: null,
      isAdmin: true,
    });
    app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminTaxonomyHealthRouter);

    healthyId = await insertFact(TEXT("neutral pencils fact"), validEnrichment(), MATCHING_COLS);
    capHintId = await insertFact(TEXT("stared at the sun"), validEnrichment(), MATCHING_COLS);
    missingId = await insertFact(TEXT("missing enrichment"), null, {});
    adminStaleId = await insertFact(
      TEXT("admin edited stale"),
      validEnrichment({ enrichedBy: "admin", classificationPromptVersion: "v0-prehistoric" }),
      MATCHING_COLS,
    );
    // Deliberately mismatched promoted columns → projection_mismatch.
    mismatchId = await insertFact(TEXT("projection mismatch"), validEnrichment(), {
      primaryArchetype: "object_logic_impossibility",
      subtype: "medium_contradiction",
    });
  });

  after(async () => {
    if (jobIds.length > 0) await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, jobIds));
    if (factIds.length > 0) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
    await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  });

  async function listIds(status: string): Promise<number[]> {
    const res = await request(app)
      .get("/api/admin/taxonomy-health/facts")
      .query({ status, search: `TTHA_${RUN}`, limit: "100" });
    assert.equal(res.status, 200);
    return (res.body.rows as Array<{ factId: number }>).map((r) => r.factId);
  }

  it("Healthy filter returns only healthy rows (not everything)", async () => {
    const ids = await listIds("healthy");
    assert.ok(ids.includes(healthyId), "healthy fact present");
    assert.ok(ids.includes(capHintId), "info-hint fact is still healthy overall");
    assert.ok(!ids.includes(missingId), "missing-enrichment fact is not healthy");
    assert.ok(!ids.includes(adminStaleId), "stale fact is not healthy");
    assert.ok(!ids.includes(mismatchId), "mismatch fact is not healthy");
  });

  it("Semantic-entities filter includes the capitalization hint", async () => {
    const ids = await listIds("semantic_entities_need_review");
    assert.ok(ids.includes(capHintId), "cap-hint fact present under semantic card");
  });

  it("missing_enrichment / stale / projection filters select the right rows", async () => {
    // The missing-enrichment fixture is necessarily INACTIVE (Phase 2's
    // facts_active_requires_concept CHECK makes an active fact with no
    // enrichment impossible), and /admin/taxonomy-health/facts scopes to active
    // facts only — so "active + missing_enrichment" can no longer occur via the
    // real system. The filter itself is unchanged (out of scope for this PR);
    // assert it correctly returns nothing for this now-unreachable case rather
    // than asserting an impossible inclusion.
    assert.ok(!(await listIds("missing_enrichment")).includes(missingId));
    assert.ok((await listIds("stale_enrichment_version")).includes(adminStaleId));
    assert.ok((await listIds("projection_mismatch")).includes(mismatchId));
  });

  it("summary healthy count is less than total facts (proves Healthy isn't 'all')", async () => {
    const res = await request(app).get("/api/admin/taxonomy-health/summary");
    assert.equal(res.status, 200);
    assert.ok(res.body.totalFacts > res.body.healthy, "an unhealthy fact exists");
  });

  it("excludes inactive staging facts from the list (isActive filter)", async () => {
    // An otherwise-healthy fact that is inactive (a staging fact mid-prep) must
    // never surface in taxonomy health — it is not production data yet.
    const [staging] = await db
      .insert(factsTable)
      .values({ text: TEXT("inactive staging fact"), submittedById: adminUserId, isActive: false, enrichment: validEnrichment(), ...MATCHING_COLS })
      .returning({ id: factsTable.id });
    factIds.push(staging!.id);

    const healthy = await listIds("healthy");
    assert.ok(!healthy.includes(staging!.id), "inactive staging fact must not appear in the health list");
  });

  it("single-row Re-enrich skips admin-edited by default (first-class skipped outcome)", async () => {
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/backfill-enrichment")
      .send({ mode: "selected_fact_ids", factIds: [adminStaleId] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 0);
    assert.equal(res.body.mode, "inline");
    assert.equal(res.body.outcomes.length, 1);
    assert.equal(res.body.outcomes[0].status, "skipped");
    assert.equal(res.body.outcomes[0].reason, "admin_edited");
    assert.equal(res.body.summary.skippedAdminEdited, 1);
  });

  it("Re-enrich with forceOverwriteAdminEdited queues a concrete job", async () => {
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/backfill-enrichment")
      .send({ mode: "selected_fact_ids", factIds: [adminStaleId], forceOverwriteAdminEdited: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 1);
    const job = res.body.jobs[0];
    assert.equal(job.action, "re_enrich");
    assert.equal(typeof job.jobId, "number");
    assert.equal(job.factId, adminStaleId);
    jobIds.push(job.jobId);

    // Poll job-status by the concrete id.
    const poll = await request(app)
      .post("/api/admin/taxonomy-health/job-status")
      .send({ jobs: [{ jobId: job.jobId }] });
    assert.equal(poll.status, 200);
    assert.equal(poll.body.jobs.length, 1);
    assert.equal(poll.body.jobs[0].jobId, job.jobId);
    assert.ok(["pending", "processing"].includes(poll.body.jobs[0].status));
  });

  it("job-status handles unknown ids safely", async () => {
    const res = await request(app)
      .post("/api/admin/taxonomy-health/job-status")
      .send({ jobs: [{ jobId: 2_147_482_999 }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.length, 0);
  });

  it("Repair projections resolves inline with terminal outcomes", async () => {
    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/repair-projections")
      .send({ mode: "selected_fact_ids", factIds: [mismatchId] });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, "inline");
    assert.equal(res.body.jobs.length, 0);
    assert.equal(res.body.outcomes.length, 1);
    assert.equal(res.body.outcomes[0].status, "done");
    assert.equal(res.body.summary.done, 1);
  });

  // ─── stale_for_reprocess lens (PR3) ──────────────────────────────────────

  it("summary carries engineRevision and a staleForReprocess count", async () => {
    const res = await request(app).get("/api/admin/taxonomy-health/summary");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.engineRevision, "number");
    assert.ok(res.body.engineRevision >= 1, "engine revision seeds at 1");
    assert.equal(typeof res.body.staleForReprocess, "number");
    // Every seeded valid fact carries a null signature → stale-for-reprocess.
    assert.ok(res.body.staleForReprocess >= 1, "legacy null-signature facts read stale-for-reprocess");
  });

  it("stale_for_reprocess lists valid null-signature facts but excludes missing_enrichment", async () => {
    const ids = await listIds("stale_for_reprocess");
    assert.ok(ids.includes(healthyId), "a valid, never-stamped fact is stale-for-reprocess");
    assert.ok(!ids.includes(missingId), "a missing-enrichment fact is NOT stale-for-reprocess (valid-only scope)");
  });

  it("bulk stale re-enrich excludes facts that are ALSO stale-for-reprocess (refresh-first)", async () => {
    // The current signature for THIS shard's engine revision (deterministic).
    const sres = await request(app).get("/api/admin/taxonomy-health/summary");
    const currentSig = currentProcessingSignature(sres.body.engineRevision as number);

    // Overlap fact: stale-enrichment (old prompt version) + null signature →
    // ALSO stale-for-reprocess → must be EXCLUDED from bulk direct re-enrich.
    const overlapId = await insertFact(
      TEXT("stale overlap reprocess"),
      validEnrichment({ classificationPromptVersion: "v0-prehistoric" }),
      MATCHING_COLS,
    );
    // Stale-enrichment but signature is CURRENT → NOT stale-for-reprocess → INCLUDED.
    const [b] = await db
      .insert(factsTable)
      .values({
        text: TEXT("stale not reprocess"),
        submittedById: adminUserId,
        isActive: true,
        enrichment: validEnrichment({ classificationPromptVersion: "v0-prehistoric" }),
        lastProcessedSignature: currentSig,
        ...MATCHING_COLS,
      })
      .returning({ id: factsTable.id });
    factIds.push(b!.id);

    const res = await request(app)
      .post("/api/admin/taxonomy-health/actions/backfill-enrichment")
      .send({ mode: "stale_only", forceOverwriteAdminEdited: true });
    assert.equal(res.status, 200);
    const queuedIds = (res.body.jobs as Array<{ factId: number; jobId: number }>).map((j) => {
      jobIds.push(j.jobId);
      return j.factId;
    });
    assert.ok(!queuedIds.includes(overlapId), "stale+reprocess overlap is NOT bulk-re-enriched");
    assert.ok(queuedIds.includes(b!.id), "a stale-enrichment fact on a current signature is still queued");
  });

  it("refreshInReview is true for a fact with an in-flight refresh candidate, false otherwise", async () => {
    const [f] = await db
      .insert(factsTable)
      .values({ text: TEXT("in-flight refresh fact"), submittedById: adminUserId, isActive: true, enrichment: validEnrichment(), ...MATCHING_COLS })
      .returning({ id: factsTable.id });
    factIds.push(f!.id);
    await db.insert(factEnrichmentVersionsTable).values({
      factId: f!.id,
      versionNo: 1,
      status: "candidate",
      source: "refresh_candidate",
    });

    const res = await request(app)
      .get("/api/admin/taxonomy-health/facts")
      .query({ status: "stale_for_reprocess", search: `TTHA_${RUN}`, limit: "100" });
    assert.equal(res.status, 200);
    const rows = res.body.rows as Array<{ factId: number; refreshInReview: boolean }>;
    const inFlight = rows.find((r) => r.factId === f!.id);
    assert.ok(inFlight, "the in-flight fact is listed");
    assert.equal(inFlight!.refreshInReview, true, "a candidate in review pre-disables its send-back button");
    const other = rows.find((r) => r.factId === healthyId);
    assert.equal(other?.refreshInReview, false, "a fact with no candidate is not marked in-review");
  });

  it("repeatedFailure is true after 3 consecutive terminal fact_send_back failures, false once a later success clears the streak", async () => {
    const [f] = await db
      .insert(factsTable)
      .values({ text: TEXT("repeated failure fact"), submittedById: adminUserId, isActive: true, enrichment: validEnrichment(), ...MATCHING_COLS })
      .returning({ id: factsTable.id });
    factIds.push(f!.id);

    // dedupeKey uniqueness only applies to non-terminal (pending/processing)
    // rows, so multiple done/failed rows can share the same key — exactly
    // like real job history for one fact accumulates over repeated retries.
    async function insertTerminalJob(status: "failed" | "done"): Promise<void> {
      const [row] = await db
        .insert(asyncJobsTable)
        .values({ queue: "fact_send_back", payload: { factId: f!.id }, status, dedupeKey: `fact_send_back:${f!.id}` })
        .returning({ id: asyncJobsTable.id });
      jobIds.push(row!.id);
    }

    await insertTerminalJob("failed");
    await insertTerminalJob("failed");

    let res = await request(app)
      .get("/api/admin/taxonomy-health/facts")
      .query({ status: "stale_for_reprocess", search: `TTHA_${RUN}`, limit: "100" });
    assert.equal(res.status, 200);
    let row = (res.body.rows as Array<{ factId: number; repeatedFailure: boolean }>).find((r) => r.factId === f!.id);
    assert.equal(row?.repeatedFailure, false, "only 2 failures — streak not yet at 3");

    await insertTerminalJob("failed");

    res = await request(app)
      .get("/api/admin/taxonomy-health/facts")
      .query({ status: "stale_for_reprocess", search: `TTHA_${RUN}`, limit: "100" });
    row = (res.body.rows as Array<{ factId: number; repeatedFailure: boolean }>).find((r) => r.factId === f!.id);
    assert.equal(row?.repeatedFailure, true, "3 consecutive terminal failures flags the fact");

    await insertTerminalJob("done");

    res = await request(app)
      .get("/api/admin/taxonomy-health/facts")
      .query({ status: "stale_for_reprocess", search: `TTHA_${RUN}`, limit: "100" });
    row = (res.body.rows as Array<{ factId: number; repeatedFailure: boolean }>).find((r) => r.factId === f!.id);
    assert.equal(row?.repeatedFailure, false, "a later success within the most recent 3 clears the flag");
  });
});
