/**
 * Tests for surfacing the Visual Taxonomy Enrichment editor on the admin Facts
 * page:
 *
 *   GET   /admin/facts/:id            — admin detail shape (enrichment + status,
 *                                        no embedding / heavy blobs)
 *   PATCH /admin/facts/:id/enrichment — persist edits + re-sync projection cols
 *   POST  /admin/facts/:id/enrich     — re-run classification (enqueue job)
 *
 * Plus the enrichment job's fact branch (runEnrichmentForFact) with injected
 * classify/preview stubs, asserting the three precise outcomes.
 *
 * 401/403 auth coverage for these routes lives in routes.admin.auth.test.ts
 * (parameterised + drift-checked against adminRouter.stack).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { factsTable, usersTable, asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray, like, and } from "drizzle-orm";
import { validateEnrichment, type FactEnrichment, type VisualPromptPreview } from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { runEnrichmentForFact } from "../lib/enrichmentJobs.js";
import { buildFactEnrichmentColumns, EnrichmentError } from "../lib/factEnrichment.js";

const USER_PREFIX = "tfactsenrich-";
const TEXT_PREFIX = "t_factsenrich ";

const VALID: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["clear_causal_relationship"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "pushups", "earth"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

// A different valid blob to confirm projection columns are re-synced on PATCH.
const OTHER: FactEnrichment = {
  ...VALID,
  primaryArchetype: "object_logic_impossibility",
  subtype: "mechanical_contradiction",
  overhypeFit: "questionable",
  adultSuitability: "requires_review",
  suggestedHashtags: ["impossible", "doors", "legendary"],
};

const STUB_PREVIEW: VisualPromptPreview = {
  archetypeApplication: "x",
  selectedFrame: "x",
  sceneConcept: "x",
  visualGoal: "x",
  visualApproach: "x",
  keyVisualElements: ["a"],
  engineNeutralVisualPlan: "x",
  exampleI2iPrompt: "x",
  exampleT2iPrompt: "x",
  promptGuardrailsPreview: "x",
  supportingTextPolicy: { allowed: [], forbidden: [], notes: "" },
  culturalReferencesUsed: [],
  interpretationWarnings: [],
  previewAssumptions: {
    sampleName: "David",
    generationMode: "i2i_and_t2i_preview",
    style: "default_sfw_cinematic",
    preserveFace: true,
    preservePhysique: false,
  },
};

let adminId: string;
let adminApp: Express;
const insertedFactIds: number[] = [];

async function insertFact(values: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text: `${TEXT_PREFIX}${randomUUID()}`, ...values } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  insertedFactIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (insertedFactIds.length) {
    await db.delete(asyncJobsTable).where(
      inArray(asyncJobsTable.dedupeKey, insertedFactIds.map((id) => `enrichment:fact:${id}`)),
    );
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: adminId,
    email: `${adminId}@test.local`,
    membershipTier: "registered",
    isAdmin: true,
  });
  adminApp = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
});

after(cleanup);

describe("GET /admin/facts/:id", () => {
  it("returns the enrichment, enrichmentStatus and derived previewStatus", async () => {
    const enrichment = { ...VALID, previewStatus: "ok" as const, visualPromptPreview: STUB_PREVIEW };
    const id = await insertFact({ ...buildFactEnrichmentColumns(enrichment), enrichmentStatus: "ok" });

    const res = await request(adminApp).get(`/api/admin/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
    assert.equal(res.body.enrichmentStatus, "ok");
    assert.equal(res.body.previewStatus, "ok");
    assert.equal((res.body.enrichment as FactEnrichment).primaryArchetype, "superhuman_physical_feat");
  });

  it("omits the embedding and heavy generation blobs", async () => {
    const id = await insertFact({
      ...buildFactEnrichmentColumns(VALID),
      aiScenePrompts: { foo: "bar" },
      aiMemeImages: { foo: "bar" },
      pexelsImages: { foo: "bar" },
    });
    const res = await request(adminApp).get(`/api/admin/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal("embedding" in res.body, false);
    assert.equal("aiScenePrompts" in res.body, false);
    assert.equal("aiMemeImages" in res.body, false);
    assert.equal("pexelsImages" in res.body, false);
    // but the derived presence flags are present
    assert.equal(typeof res.body.hasPexelsImages, "boolean");
  });

  it("404s an unknown fact and 400s a non-positive id", async () => {
    assert.equal((await request(adminApp).get(`/api/admin/facts/2000000000`)).status, 404);
    assert.equal((await request(adminApp).get(`/api/admin/facts/0`)).status, 400);
    assert.equal((await request(adminApp).get(`/api/admin/facts/-3`)).status, 400);
    assert.equal((await request(adminApp).get(`/api/admin/facts/abc`)).status, 400);
  });
});

describe("PATCH /admin/facts/:id/enrichment", () => {
  it("persists the blob, re-syncs projection columns, and sets status ok", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: null });

    const res = await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: OTHER });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.projection.primaryArchetype, "object_logic_impossibility");
    assert.equal(res.body.projection.adultSuitability, "requires_review");

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.primaryArchetype, "object_logic_impossibility");
    assert.equal(row.subtype, "mechanical_contradiction");
    assert.equal(row.overhypeFit, "questionable");
    assert.equal(row.adultSuitability, "requires_review");
    assert.equal(row.enrichmentStatus, "ok");
    assert.equal((row.enrichment as FactEnrichment).primaryArchetype, "object_logic_impossibility");
  });

  it("rejects invalid enrichment with 400 and does not touch the row", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID) });
    // subtype belongs to a different archetype → invalid
    const res = await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, subtype: "mechanical_contradiction" } });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /Invalid enrichment/);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.primaryArchetype, "superhuman_physical_feat"); // unchanged
  });

  it("404s an unknown fact and 400s a bad id", async () => {
    assert.equal(
      (await request(adminApp).patch(`/api/admin/facts/2000000000/enrichment`).send({ enrichment: VALID })).status,
      404,
    );
    assert.equal(
      (await request(adminApp).patch(`/api/admin/facts/abc/enrichment`).send({ enrichment: VALID })).status,
      400,
    );
  });
});

describe("POST /admin/facts/:id/enrich", () => {
  it("marks the fact pending and enqueues an enrichment job", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });

    const res = await request(adminApp).post(`/api/admin/facts/${id}/enrich`);
    assert.equal(res.status, 200);
    assert.equal(res.body.enrichmentStatus, "pending");

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "pending");

    const jobs = await db
      .select()
      .from(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "enrichment"), eq(asyncJobsTable.dedupeKey, `enrichment:fact:${id}`)));
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].payload as { factId?: number }).factId, id);
  });

  it("404s an unknown fact and 400s a bad id", async () => {
    assert.equal((await request(adminApp).post(`/api/admin/facts/2000000000/enrich`)).status, 404);
    assert.equal((await request(adminApp).post(`/api/admin/facts/0/enrich`)).status, 400);
  });
});

describe("runEnrichmentForFact — outcome branches (req: enrichmentStatus tracks classification only)", () => {
  it("classification failure → enrichmentStatus failed", async () => {
    const id = await insertFact({ enrichmentStatus: "pending" });
    const result = await runEnrichmentForFact(id, {
      classify: async () => { throw new EnrichmentError("boom"); },
      preview: async () => STUB_PREVIEW,
    });
    assert.equal(result.ok, false);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "failed");
  });

  it("classification ok + preview failure → enrichmentStatus ok, previewStatus failed", async () => {
    const id = await insertFact({ enrichmentStatus: "pending" });
    const result = await runEnrichmentForFact(id, {
      classify: async () => ({ ...VALID }),
      preview: async () => { throw new Error("preview boom"); },
    });
    // job returns ok (non-fatal preview failure) so it isn't retried forever
    assert.equal(result.ok, true);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "ok");
    assert.equal((row.enrichment as FactEnrichment).previewStatus, "failed");
    // classification still projected
    assert.equal(row.primaryArchetype, "superhuman_physical_feat");
    assert(validateEnrichment(row.enrichment).ok);
  });

  it("classification ok + preview ok → both updated", async () => {
    const id = await insertFact({ enrichmentStatus: "pending" });
    const result = await runEnrichmentForFact(id, {
      classify: async () => ({ ...OTHER }),
      preview: async () => STUB_PREVIEW,
    });
    assert.equal(result.ok, true);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "ok");
    assert.equal(row.primaryArchetype, "object_logic_impossibility");
    const enr = row.enrichment as FactEnrichment;
    assert.equal(enr.previewStatus, "ok");
    assert.ok(enr.visualPromptPreview);
  });
});
