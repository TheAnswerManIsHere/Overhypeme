/**
 * Tests for surfacing the Visual Taxonomy Enrichment editor on the admin Facts
 * page:
 *
 *   GET   /admin/facts/:id            — admin detail shape (enrichment + status,
 *                                        no embedding / heavy blobs)
 *   PATCH /admin/facts/:id/enrichment — persist edits + re-sync projection cols
 *   POST  /admin/facts/:id/enrich     — re-run classification (enqueue job)
 *   POST/PUT /admin/facts/:id/gags    — saving a fact's gag (since migration
 *                                        0139 the gag lives in fact_gags; the
 *                                        PATCH refuses one)
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

import { db, factGagsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { factsTable, usersTable, asyncJobsTable, pendingReviewsTable } from "@workspace/db/schema";
import { eq, inArray, like, and } from "drizzle-orm";
import {
  buildPlaceholderFactEnrichment,
  buildPlaceholderGag,
  validateEnrichment,
  resolveRenderPolicy,
  CORE_SCENE_RAW_MAX,
  type FactEnrichment,
  type ImagePromptGenerationInput,
  type VisualPlan,
} from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import gagsRouter from "../routes/gags.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { runEnrichmentForFact } from "../lib/enrichmentJobs.js";
import { buildFactEnrichmentColumns, EnrichmentError } from "../lib/factEnrichment.js";
import { compileForSubjectRenderMode } from "../lib/imagePrompt/compilers/nanoBanana2.js";

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
let gagApp: Express;
const insertedFactIds: number[] = [];

/** A fact; a live one is inserted with its approved gag (migration 0139). */
async function insertFact(values: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const { isActive, ...rest } = values;
  const row = isActive
    ? await insertLiveFact({ text: `${TEXT_PREFIX}${randomUUID()}`, ...rest } as Omit<typeof factsTable.$inferInsert, "isActive">, buildPlaceholderGag())
    : (await db
        .insert(factsTable)
        .values({ text: `${TEXT_PREFIX}${randomUUID()}`, ...rest } as typeof factsTable.$inferInsert)
        .returning({ id: factsTable.id }))[0]!;
  insertedFactIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (insertedFactIds.length) {
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, insertedFactIds));
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
  gagApp = buildTestApp({ kind: "authenticated", userId: adminId }, gagsRouter);
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
      aiMemeImages: { male: ["blob.png"], female: [], neutral: [] },
    });
    const res = await request(adminApp).get(`/api/admin/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal("embedding" in res.body, false);
    assert.equal("aiScenePrompts" in res.body, false);
    assert.equal("aiMemeImages" in res.body, false);
    // but the derived presence flag is present
    assert.equal(typeof res.body.hasEmbedding, "boolean");
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
    const rootId = await insertFact({ text: `${marker} root fact`, isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    const v1 = await insertFact({ text: `${marker} variant one`, parentId: rootId, isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    const v2 = await insertFact({ text: `${marker} variant two`, parentId: rootId, isActive: true, enrichment: buildPlaceholderFactEnrichment() });

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
    const rootId = await insertFact({ text: `${marker} plain root`, isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    const v = await insertFact({ text: `${marker} ${rare} special variant`, parentId: rootId, isActive: true, enrichment: buildPlaceholderFactEnrichment() });

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

  it("accepts a PATCH that leaves tracked fields unchanged (hashtags)", async () => {
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

  it("refuses a PATCH that carries a gag (400 GAG_IN_ENRICHMENT) and stores nothing", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const res = await request(adminApp)
      .patch(`/api/admin/facts/${id}/enrichment`)
      .send({ enrichment: { ...VALID, suggestedHashtags: ["alpha", "beta", "gamma"], visualPromptStrategyOverride: vso() } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "GAG_IN_ENRICHMENT");
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.deepEqual((row.enrichment as FactEnrichment).suggestedHashtags, ["strength", "pushups", "earth"]);
    assert.equal(await storedVso(id), undefined);
  });

  it("records who saved a gag change and when, and an identical re-save changes neither", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const override = vso({ requiredVisualDetails: ["a glowing aura"] }, "{NAME} hoists a glowing barbell overhead.");

    assert.equal((await patchVso(id, override)).status, 200);
    const [g1] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
    assert.equal(g1!.pendingBy, adminId, "the acting admin, from the session");
    assert.ok(g1!.pendingAt, "pendingAt stamped");

    assert.equal((await patchVso(id, override)).status, 200);
    const [g2] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
    assert.equal(g2!.pendingAt?.toISOString(), g1!.pendingAt?.toISOString(), "no spurious bump");

    assert.equal((await patchVso(id, { ...override, requiredVisualDetails: ["a new detail"] })).status, 200);
    const [g3] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
    assert.notEqual(g3!.pendingAt?.toISOString(), g1!.pendingAt?.toISOString());
  });

  it("canonicalizes {name}/{Name} tokens and rejects unknown tokens in a gag", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const base = vso({}, "{NAME} stands ready in the arena.");
    // {name} canonicalizes to {NAME}.
    const ok = await patchVso(id, { ...base, requiredVisualDetails: ["{name}'s face"] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await storedVso(id))!.requiredVisualDetails[0], "{NAME}'s face");

    // An unknown token is rejected.
    const bad = await patchVso(id, { ...base, requiredVisualDetails: ["{BOGUS} token"] });
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
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    const result = await runEnrichmentForFact(id, {
      classify: async () => { throw new EnrichmentError("boom"); },
    });
    assert.equal(result.ok, false);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "failed");
  });

  it("classification ok → enrichmentStatus ok, projection synced, no preview key", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: buildPlaceholderFactEnrichment() });
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

  it("discards a stale result when the classifier input drifts mid-classify (approved-fact-text lock §E)", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", text: "original wording.", isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    // The classify stub re-words the fact mid-call (a concurrent text edit),
    // then returns OTHER. The worker's full-input recheck must DISCARD it.
    const result = await runEnrichmentForFact(id, {
      classify: async () => {
        await db.update(factsTable).set({ text: "re-worded mid-classify." }).where(eq(factsTable.id, id));
        return { ...OTHER };
      },
    });
    assert.equal(result.ok, true, "a drift-discard retires as a successful no-op");
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    // OTHER's archetype must NOT have been written onto the re-worded fact.
    assert.notEqual(row.primaryArchetype, "object_logic_impossibility");
    // enrichmentStatus stays "pending" (never flipped to "ok" for a discarded result).
    assert.equal(row.enrichmentStatus, "pending");
    assert.equal(row.text, "re-worded mid-classify.");
  });

  it("renders {NAME}/{SUBJ}/… tokens before passing factText to the classify stub", async () => {
    // Seed a fact whose text is a raw template with identity tokens.
    const id = await insertFact({
      enrichmentStatus: "pending",
      text: "{NAME} bench-presses the Earth while {SUBJ} hums {POSS} favourite tune.",
      isActive: true,
      enrichment: buildPlaceholderFactEnrichment(),
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

  it("re-classification leaves the fact's gag untouched (it lives in fact_gags)", async () => {
    const override = {
      version: 1 as const,
      coreSceneOverride: "A hero stands tall.",
      requiredVisualDetails: ["adult head on a newborn body"],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
      bubbles: [],
    };
    const row0 = await insertLiveFact({
      text: `${TEXT_PREFIX}${randomUUID()}`,
      ...buildFactEnrichmentColumns(VALID),
      enrichmentStatus: "pending",
    }, override);
    insertedFactIds.push(row0.id);

    // The classify stub returns a fresh blob, as the LLM would.
    const result = await runEnrichmentForFact(row0.id, {
      classify: async () => ({ ...OTHER }),
    });
    assert.equal(result.ok, true);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, row0.id));
    assert.equal(row.primaryArchetype, "object_logic_impossibility");
    assert.equal((row.enrichment as FactEnrichment).visualPromptStrategyOverride, undefined);
    const [gag] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, row0.id));
    assert.deepEqual(gag!.approvedContent, override, "the gag survived re-classification word for word");
  });
});

// ── Visual Concept budget, blank-concept refusal, and per-field persistence ──

type Vso = NonNullable<FactEnrichment["visualPromptStrategyOverride"]>;

/** A complete override carrying a Visual Concept; `extra` populates other fields. */
function vso(extra: Partial<Vso> = {}, coreSceneOverride = "{NAME} hoists a barbell overhead in an arena."): Vso {
  return {
    version: 1, coreSceneOverride,
    requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [], bubbles: [],
    compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
    ...extra,
  } as Vso;
}

/** Save a fact's slot-1 gag through the gag routes: add it, or save a change to it. */
async function patchVso(id: number, override: Vso, reviewId?: number) {
  const [existing] = await db.select({ id: factGagsTable.id }).from(factGagsTable).where(eq(factGagsTable.factId, id));
  const body = { content: override, ...(reviewId != null ? { reviewId } : {}) };
  return existing
    ? request(gagApp).put(`/api/admin/facts/${id}/gags/${existing.id}`).send(body)
    : request(gagApp).post(`/api/admin/facts/${id}/gags`).send(body);
}

/** The fact's slot-1 gag as a render would draw it (the pending change, else the approved version). */
async function storedVso(id: number): Promise<Vso | undefined> {
  const [g] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
  return ((g?.pendingContent ?? g?.approvedContent) as Vso | null) ?? undefined;
}

// A plan with no AI content, so every line of the compiled prompt that mentions
// the override comes from the stored override itself.
const EMPTY_PLAN = {
  sceneConcept: "", visualGoal: "", visualApproach: "",
  archetypeApplication: { primaryArchetype: "superhuman_physical_feat", subtype: "force_scaled_action", selectedFrame: "direct_action", strategyRationale: "" },
  coreScene: "", subjectDetails: [], environment: [], lightingAndStyle: "", keyVisualElements: [],
  subjectTreatment: {
    roleInScene: "protagonist", subjectRenderMode: "human_identity_i2i", identityPreservation: "human_face",
    nonhumanSubjectTreatment: { applicable: false, subjectKind: "not_applicable", preserveTraits: [], anthropomorphicTreatment: "none", doNotTransformIntoHuman: false },
    fallbackSubjectGender: "not_applicable", expressionAndPose: "", ageLifeStageTransform: { applies: false, targetState: "" },
  },
  secondaryCharacters: [],
  subjectFactCompatibility: { rating: "strong", reason: "", recommendedFallback: "none" },
  composition: { subjectFraming: "", negativeSpace: "none", cameraStyle: "", sceneReadability: "readable" },
  supportingTextPolicy: { allowSupportingText: false, supportingTextElements: [], forbiddenTextTypes: [] },
  semanticEntitiesUsed: [], culturalReferencesUsed: [], contentNotes: "", debugNotes: "",
  targetEngine: "nano_banana_2", generationMode: "i2i",
} as unknown as VisualPlan;

/** The engine prompt compiled from the fact's stored classification and gag, as a render would. */
async function compiledPromptFor(id: number): Promise<string> {
  const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
  const enrichment = { ...(row.enrichment as FactEnrichment), visualPromptStrategyOverride: await storedVso(id) } as FactEnrichment;
  const input = {
    subjectRenderMode: "human_identity_i2i",
    stylePrompt: "",
    referenceImageUrl: "https://example.com/ref.png",
    factText: "",
    enrichment,
    renderControls: { aspectRatio: "portrait", contentMode: "sfw" },
    renderPolicy: resolveRenderPolicy(enrichment),
  } as unknown as ImagePromptGenerationInput;
  return compileForSubjectRenderMode({
    visualPlan: EMPTY_PLAN,
    compiledPrompt: { prompt: "", negativePrompt: "", engineNotes: "" },
    input,
    renderedSubject: { name: "David Franklin", pronouns: "he/him" },
  }).imagePrompt;
}

/** A fact the way Moderation Step 2 holds it: inactive, staged on a pending review. */
async function insertStagingFact(): Promise<{ id: number; reviewId: number }> {
  const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok", isActive: false });
  const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, id));
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: fact.text, status: "pending", workflowStage: "concept_review", stagingFactId: id,
  }).returning({ id: pendingReviewsTable.id });
  return { id, reviewId: review!.id };
}

describe("saving a gag — Visual Concept budget", () => {
  it("400s a Concept of 110 {NAME} tokens (under the raw cap) with a core_scene_rendered_too_long detail", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const tokenHeavy = "{NAME} ".repeat(110).trim();
    assert.ok(tokenHeavy.length <= CORE_SCENE_RAW_MAX, "sanity: raw length is within the raw cap");

    const res = await patchVso(id, vso({}, tokenHeavy));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CONTENT_OVER_BUDGET");
    assert.ok(
      (res.body.details as Array<{ code: string }>).some((d) => d.code === "core_scene_rendered_too_long"),
      JSON.stringify(res.body.details),
    );
    assert.equal(await storedVso(id), undefined, "a refused save stores nothing");
  });

  it("200s and stores a token-free Concept just under the raw cap (~1,490 characters)", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const concept = "The hero stands tall in a vast arena. ".repeat(40).slice(0, 1490);
    assert.equal(concept.length, 1490);

    const res = await patchVso(id, vso({}, concept));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await storedVso(id))?.coreSceneOverride, concept);
  });

  it("400s many role bindings, required details, composition notes and additions together with a moderator_additions_rendered_too_long detail", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const line = "a perfectly ordinary guidance sentence of moderate length";
    // Every entry is individually normal and the raw lists are inside their schema caps.
    const res = await patchVso(id, vso({
      roleBindings: Array.from({ length: 10 }, (_, i) => ({ entity: `onlooker ${i}`, visualRole: line })),
      requiredVisualDetails: Array.from({ length: 10 }, (_, i) => `${line} ${i}`),
      compositionGuidance: Array.from({ length: 10 }, (_, i) => `${line} ${i}`),
      styleAgnosticPromptAdditions: Array.from({ length: 10 }, (_, i) => `${line} ${i}`),
    }));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CONTENT_OVER_BUDGET");
    assert.ok(
      (res.body.details as Array<{ code: string }>).some((d) => d.code === "moderator_additions_rendered_too_long"),
      JSON.stringify(res.body.details),
    );
    assert.equal(await storedVso(id), undefined, "a refused save stores nothing");
  });

  it("200s a typical Concept with several role bindings and required details", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const override = vso({
      roleBindings: [
        { entity: "subject", visualRole: "the hero lifting the barbell" },
        { entity: "crowd", visualRole: "cheering spectators in the stands" },
        { entity: "referee", visualRole: "stands nearby holding a clipboard" },
      ],
      requiredVisualDetails: ["a glowing aura around the barbell", "chalk dust in the air", "a banner reading the arena name"],
    }, "{NAME} hoists a barbell overhead in a packed arena while the crowd roars.");

    const res = await patchVso(id, override);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stored = await storedVso(id);
    assert.deepEqual(stored?.roleBindings, override.roleBindings);
    assert.deepEqual(stored?.requiredVisualDetails, override.requiredVisualDetails);
  });
});

describe("saving a gag — saved content", () => {
  it("200s a bubble whose entity (the mailman) matches no subject or role binding", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const res = await patchVso(id, vso({ bubbles: [{ type: "speech", entity: "the mailman", text: "Special delivery!" }] }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await storedVso(id))?.bubbles, [{ type: "speech", entity: "the mailman", text: "Special delivery!" }]);
  });

  it("reads a saved role binding back with its entity and visualRole unchanged", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const binding = { entity: "crowd/victims", visualRole: "gasping onlookers pressed against the barrier" };
    const res = await patchVso(id, vso({ roleBindings: [binding] }));
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const read = await request(gagApp).get(`/api/admin/facts/${id}/gags`);
    assert.deepEqual(read.body.gags[0].pendingContent.roleBindings, [binding]);
  });

  it("GET /admin/facts/:id/gags returns the edited required visual detail after the save", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    await patchVso(id, vso({ requiredVisualDetails: ["an old detail"] }));

    const res = await patchVso(id, vso({ requiredVisualDetails: ["an edited detail"] }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const read = await request(gagApp).get(`/api/admin/facts/${id}/gags`);
    assert.deepEqual(read.body.gags[0].pendingContent.requiredVisualDetails, ["an edited detail"]);
  });

  it("stores each override field saved alone and compiles it into the prompt with no enable flag", async () => {
    const cases: Array<{ name: string; extra: Partial<Vso>; stored: (o: Vso) => unknown; expected: unknown; prompt: RegExp }> = [
      { name: "required details", extra: { requiredVisualDetails: ["a glowing aura"] }, stored: (o) => o.requiredVisualDetails, expected: ["a glowing aura"], prompt: /REQUIRED VISUAL DETAILS: a glowing aura\./ },
      { name: "forbidden details", extra: { forbiddenVisualDetails: ["a separate adult version"] }, stored: (o) => o.forbiddenVisualDetails, expected: ["a separate adult version"], prompt: /Do not a separate adult version\./ },
      { name: "role assignments", extra: { roleBindings: [{ entity: "referee", visualRole: "waves a checkered flag" }] }, stored: (o) => o.roleBindings, expected: [{ entity: "referee", visualRole: "waves a checkered flag" }], prompt: /waves a checkered flag/ },
      { name: "bubbles", extra: { bubbles: [{ type: "speech", entity: "subject", text: "Special delivery!" }] }, stored: (o) => o.bubbles, expected: [{ type: "speech", entity: "subject", text: "Special delivery!" }], prompt: /Special delivery!/ },
      { name: "composition guidance", extra: { compositionGuidance: ["low angle wide shot"] }, stored: (o) => o.compositionGuidance, expected: ["low angle wide shot"], prompt: /low angle wide shot/ },
      { name: "supporting-text policy", extra: { supportingTextPolicyOverride: { mode: "allow", guidance: "a neon sign reading OPEN" } }, stored: (o) => o.supportingTextPolicyOverride, expected: { mode: "allow", guidance: "a neon sign reading OPEN" }, prompt: /a neon sign reading OPEN/ },
    ];
    for (const c of cases) {
      const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
      const res = await patchVso(id, vso(c.extra));
      assert.equal(res.status, 200, `${c.name}: ${JSON.stringify(res.body)}`);
      const stored = await storedVso(id);
      assert.ok(stored, `${c.name}: override stored`);
      assert.equal("enabled" in stored!, false, `${c.name}: no enable flag stored`);
      assert.deepEqual(c.stored(stored!), c.expected, `${c.name}: stored`);
      assert.match(await compiledPromptFor(id), c.prompt, `${c.name}: reaches the compiled prompt`);
    }
  });

  it("stores a forbidden detail as a Do not line in the compiled prompt, and clearing it to [] removes the line", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    assert.equal((await patchVso(id, vso({ forbiddenVisualDetails: ["a rubber duck"] }))).status, 200);
    assert.deepEqual((await storedVso(id))?.forbiddenVisualDetails, ["a rubber duck"]);
    assert.match(await compiledPromptFor(id), /Do not a rubber duck\./);

    assert.equal((await patchVso(id, vso({ forbiddenVisualDetails: [] }))).status, 200);
    assert.deepEqual((await storedVso(id))?.forbiddenVisualDetails, []);
    assert.doesNotMatch(await compiledPromptFor(id), /a rubber duck/);
  });
});

describe("saving a gag — blank scene and typed scene", () => {
  it("refuses a blank scene on a new submission's staging fact with 400 SCENE_REQUIRED and stores nothing", async () => {
    const { id, reviewId } = await insertStagingFact();
    const res = await patchVso(id, vso({ requiredVisualDetails: ["a detail"] }, "   "), reviewId);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SCENE_REQUIRED");
    assert.equal(await storedVso(id), undefined);
  });

  it("stores the typed scene exactly as coreSceneOverride on the staging fact", async () => {
    const { id, reviewId } = await insertStagingFact();
    const scene = "David rides a giant rubber duck down a waterfall";
    const res = await patchVso(id, vso({}, scene), reviewId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await storedVso(id))?.coreSceneOverride, scene);
  });

  it("refuses a blank scene on an existing gag with 400 SCENE_REQUIRED and leaves the stored scene unchanged", async () => {
    const id = await insertFact({ ...buildFactEnrichmentColumns(VALID), enrichmentStatus: "ok" });
    const scene = "David hoists a barbell overhead in an arena.";
    assert.equal((await patchVso(id, vso({}, scene))).status, 200);

    const res = await patchVso(id, vso({}, ""));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SCENE_REQUIRED");
    assert.equal((await storedVso(id))?.coreSceneOverride, scene);
  });
});

// The "Overridden: Visual Strategy" badge read the enrichment's visual override;
// a fact's gags live in fact_gags since migration 0139, so the enrichment's
// override summary no longer reports one and the Facts editor shows gags in its
// Gags panel instead.
