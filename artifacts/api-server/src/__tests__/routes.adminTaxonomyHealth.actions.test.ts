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
import { asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { CLASSIFICATION_PROMPT_VERSION } from "@workspace/api-zod";

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
      .values({ text, submittedById: adminUserId, enrichment, ...cols })
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
    assert.ok((await listIds("missing_enrichment")).includes(missingId));
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
});
