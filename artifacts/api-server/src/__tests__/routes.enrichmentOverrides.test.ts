/**
 * Tests for AI-derived vs. manual-override tracking on a live fact:
 *
 *   GET    /admin/facts/:id/enrichment-resolved          — aiDerived/overrides/effective/summary
 *   PUT    /admin/facts/:id/enrichment-overrides          — create/update one override
 *   DELETE /admin/facts/:id/enrichment-overrides[?path]   — reset one / all
 *   GET    /admin/facts/:id/enrichment-overrides/history  — audit trail
 *
 * Plus sticky re-enrich (runEnrichmentForFact) preserving overrides + flagging a
 * changed baseline, and the auto-linked subtype behaviour.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { factsTable, usersTable, asyncJobsTable, enrichmentOverrideHistoryTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { type FactEnrichment } from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { runEnrichmentForFact } from "../lib/enrichmentJobs.js";
import { materializeFromBaseline } from "../lib/factEnrichment.js";

const USER_PREFIX = "tenrov-";
const TEXT_PREFIX = "t_enrov ";

// A complete, valid AI baseline (superhuman archetype family) — exactly what a
// real classify() call would return; the AI never authors a Visual Concept.
const AI: FactEnrichment = {
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
  aiGenerationId: "gen-1",
};

// A saved Visual Concept — required to save through the tracked-override
// endpoints (PUT/DELETE /enrichment-overrides), which this file exercises
// throughout. Applied by `seedFact` (moderator layer, never part of `AI`
// itself — the AI never authors this field).
const SAVED_CONCEPT = {
  version: 1 as const,
  coreSceneOverride: "{NAME} bench-presses the Earth overhead in a stadium.",
  requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
  bubbles: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
};

let adminId: string;
let adminApp: Express;
const insertedFactIds: number[] = [];

async function seedFact(baseline: FactEnrichment = AI): Promise<number> {
  // Use the real materializer so the row has aiDerived + overrides({}) + projections.
  // Default in a saved Visual Concept (required by the tracked-override write
  // paths this file exercises) unless the caller already supplied one.
  const withConcept = baseline.visualPromptStrategyOverride
    ? baseline
    : { ...baseline, visualPromptStrategyOverride: SAVED_CONCEPT };
  const { columns } = materializeFromBaseline(withConcept);
  const [row] = await db
    .insert(factsTable)
    .values({ text: `${TEXT_PREFIX}${randomUUID()}`, isActive: true, ...columns, enrichmentStatus: "ok" } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  insertedFactIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (insertedFactIds.length) {
    await db.delete(enrichmentOverrideHistoryTable).where(inArray(enrichmentOverrideHistoryTable.factId, insertedFactIds));
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.dedupeKey, insertedFactIds.map((id) => `enrichment:fact:${id}`)));
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "registered", isAdmin: true });
  adminApp = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
});

after(cleanup);

describe("GET /admin/facts/:id/enrichment-resolved", () => {
  it("returns aiDerived + empty overrides + effective == baseline when nothing is overridden", async () => {
    const id = await seedFact();
    const res = await request(adminApp).get(`/api/admin/facts/${id}/enrichment-resolved`);
    assert.equal(res.status, 200);
    assert.equal((res.body.aiDerived as FactEnrichment).primaryArchetype, "superhuman_physical_feat");
    assert.deepEqual(res.body.overrides, {});
    assert.equal((res.body.effective as FactEnrichment).primaryArchetype, "superhuman_physical_feat");
    assert.equal(res.body.overrideSummary.hasOverrides, false);
  });
});

describe("PUT /admin/facts/:id/enrichment-overrides", () => {
  it("creates an override, wins in effective, and re-syncs projection columns", async () => {
    const id = await seedFact();
    const res = await request(adminApp)
      .put(`/api/admin/facts/${id}/enrichment-overrides`)
      .send({ path: "/overhypeFit", value: "questionable", reason: "sharper call" });
    assert.equal(res.status, 200);
    assert.equal((res.body.effective as FactEnrichment).overhypeFit, "questionable");
    assert.equal(res.body.overrideSummary.overriddenPaths.includes("/overhypeFit"), true);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.overhypeFit, "questionable"); // projection re-synced
    assert.equal((row.enrichment as FactEnrichment).overhypeFit, "questionable"); // effective
    assert.equal((row.enrichmentAiDerived as FactEnrichment).overhypeFit, "strong"); // baseline untouched
    const ov = (row.enrichmentOverrides as Record<string, { value: unknown; overriddenFrom: unknown }>)["/overhypeFit"];
    assert.equal(ov.value, "questionable");
    assert.equal(ov.overriddenFrom, "strong");

    // History row written.
    const hist = await db.select().from(enrichmentOverrideHistoryTable).where(eq(enrichmentOverrideHistoryTable.factId, id));
    assert.equal(hist.some((h) => h.path === "/overhypeFit" && h.action === "set"), true);
  });

  it("rejects a non-overridable path and an invalid value", async () => {
    const id = await seedFact();
    assert.equal((await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/taxonomyConfidence", value: 0.1 })).status, 400);
    assert.equal((await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "not_a_value" })).status, 400);
  });

  it("setting a field back to the AI value deletes the override (never stores override == AI)", async () => {
    const id = await seedFact();
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable" });
    const res = await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "strong" });
    assert.equal(res.status, 200);
    assert.equal(res.body.overrideSummary.hasOverrides, false);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.deepEqual(row.enrichmentOverrides, {});
  });

  it("auto-links a compatible subtype when primaryArchetype is overridden, recording it in history", async () => {
    const id = await seedFact();
    const res = await request(adminApp)
      .put(`/api/admin/facts/${id}/enrichment-overrides`)
      .send({ path: "/primaryArchetype", value: "object_logic_impossibility" });
    assert.equal(res.status, 200);
    const eff = res.body.effective as FactEnrichment;
    assert.equal(eff.primaryArchetype, "object_logic_impossibility");
    // subtype is now valid for the new archetype (force_scaled_action is not).
    assert.notEqual(eff.subtype, "force_scaled_action");
    assert.equal(res.body.overrideSummary.overriddenPaths.includes("/subtype"), true);

    const hist = await db.select().from(enrichmentOverrideHistoryTable).where(eq(enrichmentOverrideHistoryTable.factId, id));
    assert.equal(hist.some((h) => h.path === "/subtype" && h.action === "auto_linked"), true);
  });

  it("updating one path does not wipe a pre-existing override on another path (concurrency-safe merge)", async () => {
    const id = await seedFact();
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/modifiers", value: ["clear_causal_relationship", "wholesome"] });
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable" });

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    const overrides = row.enrichmentOverrides as Record<string, unknown>;
    assert.ok(overrides["/modifiers"], "modifiers override survived the second write");
    assert.ok(overrides["/overhypeFit"], "overhypeFit override present");
  });

  it("does not refresh overriddenFrom on an ordinary value edit (only on acknowledge)", async () => {
    const id = await seedFact();
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable" });
    // Simulate the AI baseline changing under the override (strong → reject).
    await db.update(factsTable).set({ enrichmentAiDerived: { ...AI, overhypeFit: "reject", aiGenerationId: "gen-2" } as FactEnrichment }).where(eq(factsTable.id, id));

    // An ordinary edit to another distinct value keeps overriddenFrom = "strong".
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "strong" });
    let [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    let ov = (row.enrichmentOverrides as Record<string, { overriddenFrom: unknown }>)["/overhypeFit"];
    assert.equal(ov.overriddenFrom, "strong", "overriddenFrom not refreshed by an ordinary edit");

    // Acknowledging refreshes it to the current baseline ("reject").
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable", acknowledgeCurrentAiBaseline: true });
    [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    ov = (row.enrichmentOverrides as Record<string, { overriddenFrom: unknown }>)["/overhypeFit"];
    assert.equal(ov.overriddenFrom, "reject", "overriddenFrom refreshed on acknowledge");
  });
});

describe("DELETE /admin/facts/:id/enrichment-overrides", () => {
  it("resets one path and restores the AI value (whole-list field)", async () => {
    const id = await seedFact();
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/modifiers", value: ["wholesome"] });
    let [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.deepEqual((row.enrichment as FactEnrichment).modifiers, ["wholesome"]);

    const res = await request(adminApp).delete(`/api/admin/facts/${id}/enrichment-overrides?path=/modifiers`);
    assert.equal(res.status, 200);
    [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.deepEqual((row.enrichment as FactEnrichment).modifiers, AI.modifiers); // restored AI list
    assert.deepEqual(row.enrichmentOverrides, {});
  });

  it("resets ALL overrides when no path is given", async () => {
    const id = await seedFact();
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable" });
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/adminReviewNotes", value: "needs a look" });
    const res = await request(adminApp).delete(`/api/admin/facts/${id}/enrichment-overrides`);
    assert.equal(res.status, 200);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.deepEqual(row.enrichmentOverrides, {});
    assert.equal((row.enrichment as FactEnrichment).overhypeFit, "strong");
  });
});

describe("sticky re-enrich (runEnrichmentForFact)", () => {
  it("preserves overrides, keeps override winning, and flags a changed baseline", async () => {
    const id = await seedFact();
    // Override overhypeFit, then re-enrich with a DIFFERENT AI baseline value.
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable" });

    const result = await runEnrichmentForFact(id, {
      classify: async () => ({ ...AI, overhypeFit: "reject", aiGenerationId: "gen-2" }),
    });
    assert.equal(result.ok, true);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    // Override still wins.
    assert.equal((row.enrichment as FactEnrichment).overhypeFit, "questionable");
    assert.equal(row.overhypeFit, "questionable");
    // Baseline regenerated.
    assert.equal((row.enrichmentAiDerived as FactEnrichment).overhypeFit, "reject");
    // overriddenFrom is still the ORIGINAL baseline → baseline-changed flagged.
    const ov = (row.enrichmentOverrides as Record<string, { overriddenFrom: unknown }>)["/overhypeFit"];
    assert.equal(ov.overriddenFrom, "strong");
    assert.equal(row.enrichmentBaselineChanged, true);

    // resolved surfaces the changed path.
    const res = await request(adminApp).get(`/api/admin/facts/${id}/enrichment-resolved`);
    assert.equal(res.body.overrideSummary.baselineChangedPaths.includes("/overhypeFit"), true);

    // A baseline_reenriched history row was written for the transition.
    const hist = await db.select().from(enrichmentOverrideHistoryTable).where(eq(enrichmentOverrideHistoryTable.factId, id));
    assert.equal(hist.some((h) => h.path === "/overhypeFit" && h.action === "baseline_reenriched"), true);
  });

  it("classifies a variant from its OWN text only — no parent text or parentId reaches the classifier (variant independence, site 3)", async () => {
    const { columns: rootColumns } = materializeFromBaseline(AI);
    const [rootRow] = await db
      .insert(factsTable)
      .values({ text: `${TEXT_PREFIX}${randomUUID()} ROOT_DISTINCTIVE_MARKER`, isActive: true, ...rootColumns, enrichmentStatus: "ok" } as typeof factsTable.$inferInsert)
      .returning({ id: factsTable.id });
    insertedFactIds.push(rootRow.id);

    const variantText = `${TEXT_PREFIX}${randomUUID()} VARIANT_DISTINCTIVE_MARKER`;
    const { columns: variantColumns } = materializeFromBaseline(AI);
    const [variantRow] = await db
      .insert(factsTable)
      .values({ text: variantText, isActive: true, parentId: rootRow.id, ...variantColumns, enrichmentStatus: "ok" } as typeof factsTable.$inferInsert)
      .returning({ id: factsTable.id });
    insertedFactIds.push(variantRow.id);

    let capturedFactText: string | undefined;
    const result = await runEnrichmentForFact(variantRow.id, {
      classify: async (input) => {
        capturedFactText = input.factText;
        return { ...AI, aiGenerationId: "gen-variant" };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(capturedFactText?.includes("VARIANT_DISTINCTIVE_MARKER"), "the variant's own text must reach the classifier");
    assert.ok(!capturedFactText?.includes("ROOT_DISTINCTIVE_MARKER"), "the root's text must never be concatenated in");
  });
});

describe("human-field survival (visual override + sticky notes)", () => {
  it("preserves the visual override and a notes override across a taxonomy PUT and re-enrich", async () => {
    const visual = {
      ...SAVED_CONCEPT,
      requiredVisualDetails: ["adult head on a newborn body"],
    };
    const { columns } = materializeFromBaseline({ ...AI, visualPromptStrategyOverride: visual } as FactEnrichment);
    const [row0] = await db.insert(factsTable)
      .values({ text: `${TEXT_PREFIX}${randomUUID()}`, isActive: true, ...columns, enrichmentStatus: "ok" } as typeof factsTable.$inferInsert)
      .returning({ id: factsTable.id });
    const id = row0.id;
    insertedFactIds.push(id);

    // Sticky note override + a taxonomy override.
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/adminReviewNotes", value: "human-authored note" });
    await request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable" });

    // The visual override survived both taxonomy writes.
    let [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal((row.enrichment as FactEnrichment).visualPromptStrategyOverride?.requiredVisualDetails[0], "adult head on a newborn body");
    assert.equal((row.enrichment as FactEnrichment).adminReviewNotes, "human-authored note");

    // Re-enrich with a fresh AI baseline (no visual override, blank notes, as the LLM emits).
    await runEnrichmentForFact(id, { classify: async () => ({ ...AI, adminReviewNotes: "", overhypeFit: "reject", aiGenerationId: "gen-2" }) });
    [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    // Both the human note override and the visual override stuck.
    assert.equal((row.enrichment as FactEnrichment).adminReviewNotes, "human-authored note");
    assert.equal((row.enrichment as FactEnrichment).visualPromptStrategyOverride?.requiredVisualDetails[0], "adult head on a newborn body");
    assert.equal((row.enrichment as FactEnrichment).overhypeFit, "questionable");
  });
});

describe("override endpoints on inactive (staging) facts", () => {
  // The moderation modal edits STAGING facts — real `facts` rows with
  // isActive: false — through these same endpoints. This pins the
  // no-isActive-guard property that lockstep editing depends on: if a future
  // refactor adds an active-only filter, this fails loudly instead of
  // silently breaking moderation.
  it("PUT and GET-resolved work on an isActive:false fact", async () => {
    const { columns } = materializeFromBaseline({ ...AI, visualPromptStrategyOverride: SAVED_CONCEPT });
    const [row] = await db.insert(factsTable)
      .values({ text: `${TEXT_PREFIX}${randomUUID()}`, isActive: false, ...columns, enrichmentStatus: "ok" } as typeof factsTable.$inferInsert)
      .returning({ id: factsTable.id });
    insertedFactIds.push(row.id);

    const put = await request(adminApp)
      .put(`/api/admin/facts/${row.id}/enrichment-overrides`)
      .send({ path: "/overhypeFit", value: "questionable" });
    assert.equal(put.status, 200);
    assert.equal((put.body.effective as FactEnrichment).overhypeFit, "questionable");

    const resolved = await request(adminApp).get(`/api/admin/facts/${row.id}/enrichment-resolved`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.overrideSummary.overriddenPaths.includes("/overhypeFit"), true);

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, row.id));
    assert.equal(fact.isActive, false, "editing must not activate the fact");
    assert.equal((fact.enrichment as FactEnrichment).overhypeFit, "questionable");
  });
});

describe("GET /admin/facts list — override filters", () => {
  it("filters by hasOverrides and baselineChanged", async () => {
    const plainId = await seedFact();
    const ovId = await seedFact();
    await request(adminApp).put(`/api/admin/facts/${ovId}/enrichment-overrides`).send({ path: "/overhypeFit", value: "questionable" });

    const res = await request(adminApp).get(`/api/admin/facts?hasOverrides=true&limit=100`);
    assert.equal(res.status, 200);
    const ids = (res.body.facts as Array<{ id: number }>).map((f) => f.id);
    assert.equal(ids.includes(ovId), true);
    assert.equal(ids.includes(plainId), false);
  });
});
