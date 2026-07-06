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
import { validateEnrichment, type FactEnrichment } from "@workspace/api-zod";

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

let adminId: string;
let adminEmail: string;
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
  adminEmail = `${adminId}@test.local`;
  await db.insert(usersTable).values({
    id: adminId,
    email: adminEmail,
    membershipTier: "registered",
    isAdmin: true,
  });
  adminApp = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
});

after(cleanup);

describe("GET /admin/facts/:id", () => {
  it("returns the enrichment and enrichmentStatus", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });

    const res = await request(adminApp).get(`/api/admin/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
    assert.equal(res.body.enrichmentStatus, "ok");
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

describe("GET /admin/facts — variant hierarchy", () => {
  it("nests variants under their root, paginates by root, and groups search matches under the parent", async () => {
    const marker = `zzhier${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const rootId = await insertFact({ text: `${marker} root fact` });
    const v1 = await insertFact({ text: `${marker} variant one`, parentId: rootId });
    const v2 = await insertFact({ text: `${marker} variant two`, parentId: rootId });

    const res = await request(adminApp).get(`/api/admin/facts?search=${marker}`);
    assert.equal(res.status, 200);
    const facts = res.body.facts as Array<{ id: number; variants?: Array<{ id: number }> }>;
    // Only the root is a top-level entry; total counts roots, not variants.
    assert.deepEqual(facts.map((f) => f.id), [rootId]);
    assert.equal(res.body.total, 1);
    // Both variants are nested under the root, not listed as top-level rows.
    assert.deepEqual((facts[0].variants ?? []).map((v) => v.id).sort(), [v1, v2].sort());
    assert.equal(facts.some((f) => f.id === v1 || f.id === v2), false);
  });

  it("surfaces the parent root when only a variant's text matches the search", async () => {
    const marker = `zzhier${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const rare = `zzonly${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const rootId = await insertFact({ text: `${marker} plain root` });
    const v = await insertFact({ text: `${marker} ${rare} special variant`, parentId: rootId });

    const res = await request(adminApp).get(`/api/admin/facts?search=${rare}`);
    assert.equal(res.status, 200);
    const facts = res.body.facts as Array<{ id: number; variants?: Array<{ id: number }> }>;
    assert.deepEqual(facts.map((f) => f.id), [rootId]);            // parent pulled in for context
    assert.deepEqual((facts[0].variants ?? []).map((x) => x.id), [v]); // only the matching variant
  });
});

describe("PATCH /admin/facts/:id/enrichment", () => {
  it("rejects a PATCH that changes a tracked field (use the override endpoints)", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: null });

    // OTHER changes primaryArchetype etc — tracked fields that PATCH may not mutate.
    const res = await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: OTHER });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /override endpoints/i);
    assert.ok(Array.isArray(res.body.trackedPaths) && res.body.trackedPaths.includes("/primaryArchetype"));

    // The row is untouched.
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.primaryArchetype, "superhuman_physical_feat");
  });

  it("accepts a PATCH that leaves tracked fields unchanged (visual override / hashtags)", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: null });
    const res = await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, suggestedHashtags: ["alpha", "beta", "gamma"] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.deepEqual((row.enrichment as FactEnrichment).suggestedHashtags, ["alpha", "beta", "gamma"]);
    // Tracked projection columns are unchanged.
    assert.equal(row.primaryArchetype, "superhuman_physical_feat");
  });

  it("stamps server-owned override provenance on change and preserves it when unchanged", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const override = {
      version: 1 as const,
      enabled: true,
      requiredVisualDetails: ["a glowing aura"],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
    };

    // First save: provenance is stamped by the server (never sent by the client).
    await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, visualPromptStrategyOverride: override } });
    let [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    const ov1 = (row.enrichment as FactEnrichment & { visualPromptStrategyOverride?: { updatedBy?: string; updatedAt?: string } }).visualPromptStrategyOverride!;
    // A human-readable actor label (email, since this test admin has no display
    // name) — never the raw admin user id.
    assert.equal(ov1.updatedBy, adminEmail);
    assert.ok(ov1.updatedAt, "updatedAt stamped");

    // Re-save identical override → provenance preserved (no spurious bump).
    await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, visualPromptStrategyOverride: override } });
    [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    const ov2 = (row.enrichment as FactEnrichment & { visualPromptStrategyOverride?: { updatedAt?: string } }).visualPromptStrategyOverride!;
    assert.equal(ov2.updatedAt, ov1.updatedAt);

    // Changed content → updatedAt refreshed.
    await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, visualPromptStrategyOverride: { ...override, requiredVisualDetails: ["a new detail"] } } });
    [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    const ov3 = (row.enrichment as FactEnrichment & { visualPromptStrategyOverride?: { updatedAt?: string } }).visualPromptStrategyOverride!;
    assert.notEqual(ov3.updatedAt, ov1.updatedAt);
  });

  it("canonicalizes {name}/{Name} tokens and rejects unknown tokens in the override", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const base = {
      version: 1 as const,
      enabled: true,
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
    };
    // {name} canonicalizes to {NAME}.
    const ok = await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, visualPromptStrategyOverride: { ...base, requiredVisualDetails: ["{name}'s face"] } } });
    assert.equal(ok.status, 200);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    const ov = (row.enrichment as FactEnrichment & { visualPromptStrategyOverride?: { requiredVisualDetails: string[] } }).visualPromptStrategyOverride!;
    assert.equal(ov.requiredVisualDetails[0], "{NAME}'s face");

    // An unknown token is rejected.
    const bad = await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, visualPromptStrategyOverride: { ...base, requiredVisualDetails: ["{BOGUS} token"] } } });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /token/i);
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

describe("runEnrichmentForFact — outcome branches (classify-only)", () => {
  it("classification failure → enrichmentStatus failed", async () => {
    const id = await insertFact({ enrichmentStatus: "pending" });
    const result = await runEnrichmentForFact(id, {
      classify: async () => { throw new EnrichmentError("boom"); },
    });
    assert.equal(result.ok, false);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "failed");
  });

  it("classification ok → enrichmentStatus ok, projection synced, no preview key", async () => {
    const id = await insertFact({ enrichmentStatus: "pending" });
    const result = await runEnrichmentForFact(id, {
      classify: async () => ({ ...OTHER }),
    });
    assert.equal(result.ok, true);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "ok");
    assert.equal(row.primaryArchetype, "object_logic_impossibility");
    const enr = row.enrichment as FactEnrichment & { previewStatus?: unknown; visualPromptPreview?: unknown };
    assert.equal(enr.previewStatus, undefined);
    assert.equal(enr.visualPromptPreview, undefined);
    assert(validateEnrichment(row.enrichment).ok);
  });

  it("renders {NAME}/{SUBJ}/… tokens before passing factText to the classify stub", async () => {
    // Seed a fact whose text is a raw template with identity tokens.
    const id = await insertFact({
      enrichmentStatus: "pending",
      text: "{NAME} bench-presses the Earth while {SUBJ} hums {POSS} favourite tune.",
    });

    let classifyReceivedText: string | undefined;

    const result = await runEnrichmentForFact(id, {
      classify: async (input) => {
        classifyReceivedText = input.factText;
        return { ...VALID };
      },
    });

    assert.equal(result.ok, true);
    // The stub must receive fully-rendered canonical text — no raw tokens.
    assert.ok(classifyReceivedText, "classify stub must have been called");
    assert.doesNotMatch(classifyReceivedText!, /\{NAME\}|\{SUBJ\}|\{POSS\}/,
      "classify received raw identity token (renderCanonical not applied)");
    // Spot-check: canonical name "Alex" was substituted in.
    assert.match(classifyReceivedText!, /Alex/);
  });

  it("preserves the moderator visual-strategy override across re-classification", async () => {
    const override = {
      version: 1 as const,
      enabled: true,
      requiredVisualDetails: ["adult head on a newborn body"],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
      updatedBy: "tfactsenrich-prior-admin",
      updatedAt: "2026-06-13T00:00:00.000Z",
    };
    const id = await insertFact({
      ...buildFactEnrichmentColumns({ ...VALID, visualPromptStrategyOverride: override } as FactEnrichment),
      enrichmentStatus: "pending",
    });

    // The classify stub returns a fresh blob WITHOUT any override (as the LLM would).
    const result = await runEnrichmentForFact(id, {
      classify: async () => ({ ...OTHER }),
    });
    assert.equal(result.ok, true);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    const enr = row.enrichment as FactEnrichment & {
      visualPromptStrategyOverride?: { requiredVisualDetails: string[]; updatedBy?: string; updatedAt?: string };
    };
    // Re-classification swapped the taxonomy but the override (incl. provenance) survived.
    assert.equal(row.primaryArchetype, "object_logic_impossibility");
    assert.ok(enr.visualPromptStrategyOverride, "override preserved");
    assert.equal(enr.visualPromptStrategyOverride!.requiredVisualDetails[0], "adult head on a newborn body");
    assert.equal(enr.visualPromptStrategyOverride!.updatedBy, "tfactsenrich-prior-admin");
    assert.equal(enr.visualPromptStrategyOverride!.updatedAt, "2026-06-13T00:00:00.000Z");
  });
});
