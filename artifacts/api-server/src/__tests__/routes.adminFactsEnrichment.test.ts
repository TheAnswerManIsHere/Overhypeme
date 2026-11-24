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
import { factsTable, usersTable, asyncJobsTable, pendingReviewsTable, factTaxonomyRunsTable } from "@workspace/db/schema";
import { eq, inArray, like, and, asc } from "drizzle-orm";
import {
  buildPlaceholderFactEnrichment,
  buildPlaceholderGag,
  validateEnrichment,
  CORE_SCENE_RAW_MAX,
  type FactEnrichment,
} from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import gagsRouter from "../routes/gags.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { runEnrichmentForFact } from "../lib/enrichmentJobs.js";
import { EnrichmentError } from "../lib/factEnrichment.js";
import { compileDirect } from "../lib/imagePrompt/compilers/nanoBanana2.js";
import { directGagInput } from "../lib/imagePrompt/directInput.js";
import { withCast } from "./helpers/gagCast.js";

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
  characters: [],
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
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });

    const res = await request(adminApp).get(`/api/admin/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
    assert.equal(res.body.enrichmentStatus, "ok");
    assert.equal((res.body.enrichment as FactEnrichment).primaryArchetype, "superhuman_physical_feat");
  });

  it("omits the embedding and heavy generation blobs", async () => {
    const id = await insertFact({
      enrichment: VALID,
      aiMemeImages: { male: ["blob.png"], female: [], neutral: [] },
    });
    const res = await request(adminApp).get(`/api/admin/facts/${id}`);
    assert.equal(res.status, 200);
    assert.equal("embedding" in res.body, false);
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

describe("GET /admin/facts — a flat list", () => {
  it("lists every matching fact as its own row, counts each one, and carries no nesting", async () => {
    const marker = `zzflat${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const a = await insertFact({ text: `${marker} first fact`, isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    const b = await insertFact({ text: `${marker} second fact`, isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    await insertFact({ text: `zzother${randomUUID().slice(0, 8)} unrelated`, isActive: true, enrichment: buildPlaceholderFactEnrichment() });

    const res = await request(adminApp).get(`/api/admin/facts?search=${marker}`);
    assert.equal(res.status, 200);
    const facts = res.body.facts as Array<Record<string, unknown>>;
    assert.deepEqual(facts.map((f) => f.id).sort(), [a, b].sort());
    assert.equal(res.body.total, 2);
    for (const f of facts) {
      assert.equal("variants" in f, false, "no nested list");
      assert.equal("parentId" in f, false, "no parent link");
      assert.equal("useCase" in f, false, "no use-case label");
    }
  });
});

describe("saving a gag — who and when, and its tokens", () => {
  it("records who saved a gag change and when, and an identical re-save changes neither", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const override = vso({ bubbles: [{ type: "speech", entity: "subject", text: "Light as a feather." }] }, "{NAME} hoists a glowing barbell overhead.");

    assert.equal((await patchVso(id, override)).status, 200);
    const [g1] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
    assert.equal(g1!.pendingBy, adminId, "the acting admin, from the session");
    assert.ok(g1!.pendingAt, "pendingAt stamped");

    assert.equal((await patchVso(id, override)).status, 200);
    const [g2] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
    assert.equal(g2!.pendingAt?.toISOString(), g1!.pendingAt?.toISOString(), "no spurious bump");

    assert.equal((await patchVso(id, { ...override, bubbles: [{ type: "speech", entity: "subject", text: "Heavier than it looks." }] })).status, 200);
    const [g3] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
    assert.notEqual(g3!.pendingAt?.toISOString(), g1!.pendingAt?.toISOString());
  });

  it("canonicalizes {name}/{Name} tokens and rejects unknown tokens in a gag", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const base = vso({}, "{NAME} stands ready in the arena.");
    // {name} canonicalizes to {NAME}.
    const ok = await patchVso(id, { ...base, bubbles: [{ type: "speech", entity: "subject", text: "{name} wins again" }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await storedVso(id))!.bubbles[0]!.text, "{NAME} wins again");

    // An unknown token is rejected.
    const bad = await patchVso(id, { ...base, bubbles: [{ type: "speech", entity: "subject", text: "{BOGUS} token" }] });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /token/i);
  });
});

describe("the taxonomy is read-only (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 2A)", () => {
  it("no route edits, overrides or versions a fact's taxonomy any more", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const gone: Array<[string, () => Promise<{ status: number }>]> = [
      ["PATCH enrichment", () => request(adminApp).patch(`/api/admin/facts/${id}/enrichment`).send({ enrichment: { ...VALID, suggestedHashtags: ["alpha", "beta", "gamma"] } })],
      ["GET enrichment-resolved", () => request(adminApp).get(`/api/admin/facts/${id}/enrichment-resolved`)],
      ["PUT enrichment-overrides", () => request(adminApp).put(`/api/admin/facts/${id}/enrichment-overrides`).send({ path: "/visualComplexity", value: "high" })],
      ["DELETE enrichment-overrides", () => request(adminApp).delete(`/api/admin/facts/${id}/enrichment-overrides`)],
      ["GET enrichment-overrides/history", () => request(adminApp).get(`/api/admin/facts/${id}/enrichment-overrides/history`)],
      ["GET enrichment-versions", () => request(adminApp).get(`/api/admin/facts/${id}/enrichment-versions`)],
      ["POST backfill-enrichment", () => request(adminApp).post(`/api/admin/facts/backfill-enrichment`)],
    ];
    for (const [name, call] of gone) assert.equal((await call()).status, 404, name);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.deepEqual((row.enrichment as FactEnrichment).suggestedHashtags, ["strength", "pushups", "earth"]);
  });
});

describe("POST /admin/facts/:id/enrich", () => {
  it("marks the fact pending and enqueues an enrichment job", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });

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
    assert.deepEqual(jobs[0].payload, { factId: id, origin: "rerun", requestedBy: adminId });
  });

  it("404s an unknown fact and 400s a bad id", async () => {
    assert.equal((await request(adminApp).post(`/api/admin/facts/2000000000/enrich`)).status, 404);
    assert.equal((await request(adminApp).post(`/api/admin/facts/0/enrich`)).status, 400);
  });
});

describe("taxonomy run history (plan item 16; Issue #1018, increment 2.1b)", () => {
  const history = (factId: number) => db.select().from(factTaxonomyRunsTable)
    .where(eq(factTaxonomyRunsTable.factId, factId)).orderBy(asc(factTaxonomyRunsTable.id));

  it("a stored run leaves one ok row carrying its output, origin and who asked", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    await runEnrichmentForFact(id, { classify: async () => ({ ...OTHER }) }, { origin: "rerun", requestedBy: adminId });
    const rows = await history(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "ok");
    assert.equal(rows[0]!.origin, "rerun");
    assert.equal(rows[0]!.requestedBy, adminId);
    assert.equal(rows[0]!.error, null);
    assert.deepEqual(rows[0]!.output, (await db.select().from(factsTable).where(eq(factsTable.id, id)))[0]!.enrichment);
  });

  it("a failed call leaves a failed row with the error and no output, and the earlier taxonomy stays", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: VALID });
    await runEnrichmentForFact(id, { classify: async () => { throw new EnrichmentError("the classifier timed out"); } });
    const rows = await history(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "failed");
    assert.equal(rows[0]!.origin, "unrecorded");
    assert.equal(rows[0]!.output, null);
    assert.match(rows[0]!.error ?? "", /timed out/);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal((row!.enrichment as FactEnrichment).primaryArchetype, VALID.primaryArchetype);
  });

  it("a run whose fact left its state mid-call leaves a discarded row and stores nothing", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: VALID });
    await runEnrichmentForFact(id, {
      classify: async () => {
        await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, id));
        return { ...OTHER };
      },
    }, { origin: "provisional_approval", requestedBy: null });
    const rows = await history(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "discarded");
    assert.equal(rows[0]!.origin, "provisional_approval");
    assert.equal((rows[0]!.output as FactEnrichment).primaryArchetype, OTHER.primaryArchetype);
    assert.match(rows[0]!.error ?? "", /left the state/);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal((row!.enrichment as FactEnrichment).primaryArchetype, VALID.primaryArchetype);
  });

  it("a requester whose account is gone is recorded as nobody, and the result is still stored (Codex 4651288296)", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: VALID });
    const result = await runEnrichmentForFact(id, { classify: async () => ({ ...OTHER }) }, { origin: "rerun", requestedBy: `${USER_PREFIX}deleted-${randomUUID()}` });
    assert.equal(result.ok, true);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row!.enrichmentStatus, "ok");
    assert.equal((row!.enrichment as FactEnrichment).primaryArchetype, OTHER.primaryArchetype);
    const rows = await history(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "ok");
    assert.equal(rows[0]!.requestedBy, null);
  });

  it("a failed call for a requester whose account is gone records a failed row with nobody, and fails as an ordinary classify failure", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: VALID });
    const result = await runEnrichmentForFact(id, { classify: async () => { throw new EnrichmentError("boom"); } }, { origin: "rerun", requestedBy: `${USER_PREFIX}deleted-${randomUUID()}` });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /^classify: boom/);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row!.enrichmentStatus, "failed");
    const rows = await history(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "failed");
    assert.equal(rows[0]!.requestedBy, null);
  });

  it("a skipped run (nothing to classify for) calls nothing and writes no row", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: false });
    let called = false;
    await runEnrichmentForFact(id, { classify: async () => { called = true; return { ...OTHER }; } });
    assert.equal(called, false);
    assert.deepEqual(await history(id), []);
  });

  it("GET /admin/facts/:id/taxonomy-runs lists the runs newest first, naming who asked", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: VALID });
    await runEnrichmentForFact(id, { classify: async () => { throw new EnrichmentError("boom"); } }, { origin: "rerun", requestedBy: adminId });
    await runEnrichmentForFact(id, { classify: async () => ({ ...OTHER }) }, { origin: "rerun", requestedBy: adminId });
    const res = await request(adminApp).get(`/api/admin/facts/${id}/taxonomy-runs`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.runs.map((r: { outcome: string }) => r.outcome), ["ok", "failed"]);
    assert.equal(res.body.runs[0].requestedByName, adminEmail);
    assert.equal(res.body.runs[1].error, "boom");
    assert.equal((await request(adminApp).get(`/api/admin/facts/2000000000/taxonomy-runs`)).status, 404);
    assert.equal((await request(adminApp).get(`/api/admin/facts/0/taxonomy-runs`)).status, 400);
  });

  it("the Facts list reads the archetype from the stored taxonomy (the projection column is gone, 0160)", async () => {
    // An approved fact: the list holds approved facts only (Issue #1018, increment 3.1).
    const id = await insertFact({ enrichment: OTHER, enrichmentStatus: "ok", isActive: true });
    const [row] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, id));
    const res = await request(adminApp).get(`/api/admin/facts`).query({ search: row!.text, visibility: "both" });
    assert.equal(res.status, 200);
    assert.equal(res.body.facts[0].primaryArchetype, OTHER.primaryArchetype);
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

  it("classification ok → enrichmentStatus ok, the classifier's output stored, no preview key", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    const result = await runEnrichmentForFact(id, {
      classify: async () => ({ ...OTHER }),
    });
    assert.equal(result.ok, true);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.enrichmentStatus, "ok");
    assert.equal((row.enrichment as FactEnrichment).primaryArchetype, "object_logic_impossibility");
    const enr = row.enrichment as FactEnrichment & { previewStatus?: unknown; visualPromptPreview?: unknown };
    assert.equal(enr.previewStatus, undefined);
    assert.equal(enr.visualPromptPreview, undefined);
    assert(validateEnrichment(row.enrichment).ok);
  });

  it("a fact's wording cannot drift mid-classify: the database refuses the edit (migration 0141)", async () => {
    const id = await insertFact({ enrichmentStatus: "pending", text: "original wording.", isActive: true, enrichment: buildPlaceholderFactEnrichment() });
    let refused = false;
    const result = await runEnrichmentForFact(id, {
      classify: async () => {
        await db.update(factsTable).set({ text: "re-worded mid-classify." }).where(eq(factsTable.id, id)).catch(() => { refused = true; });
        return { ...OTHER };
      },
    });
    assert.equal(refused, true, "a concurrent wording edit is refused by the database");
    assert.equal(result.ok, true);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, id));
    assert.equal(row.text, "original wording.");
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
      enrichment: VALID,
      enrichmentStatus: "pending",
    }, override);
    insertedFactIds.push(row0.id);

    // The classify stub returns a fresh blob, as the LLM would.
    const result = await runEnrichmentForFact(row0.id, {
      classify: async () => ({ ...OTHER }),
    });
    assert.equal(result.ok, true);

    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, row0.id));
    assert.equal((row.enrichment as FactEnrichment).primaryArchetype, "object_logic_impossibility");
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

/**
 * Save a fact's slot-1 gag through the gag routes: add it, or save a change
 * to it. A gag write comes from a review (plan PLAN_FACT_LIFECYCLE_REBUILD.md,
 * 1F), so a fact with none gets one at the Gags step, opened here once.
 */
async function patchVso(id: number, override: Vso, reviewId?: number) {
  const [existing] = await db.select({ id: factGagsTable.id }).from(factGagsTable).where(eq(factGagsTable.factId, id));
  const scope = reviewId ?? await openReviewFor(id);
  const body = { content: withCast(override), reviewId: scope };
  return existing
    ? request(gagApp).put(`/api/admin/facts/${id}/gags/${existing.id}`).send(body)
    : request(gagApp).post(`/api/admin/facts/${id}/gags`).send(body);
}

/** The fact's open review, opened at the Gags step when it has none. */
async function openReviewFor(id: number): Promise<number> {
  const [open] = await db.select({ id: pendingReviewsTable.id }).from(pendingReviewsTable)
    .where(and(eq(pendingReviewsTable.stagingFactId, id), eq(pendingReviewsTable.status, "pending")));
  if (open) return open.id;
  const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, id));
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: fact!.text, status: "pending", workflowStage: "gags", stagingFactId: id,
  }).returning({ id: pendingReviewsTable.id });
  return review!.id;
}

/** The fact's slot-1 gag as a render would draw it (the pending change, else the approved version). */
async function storedVso(id: number): Promise<Vso | undefined> {
  const [g] = await db.select().from(factGagsTable).where(eq(factGagsTable.factId, id));
  return ((g?.pendingContent ?? g?.approvedContent) as Vso | null) ?? undefined;
}

/** The engine prompt compiled from the fact's stored gag, as a render would (plan PLAN_GAG_DIRECT_RENDER.md, D). */
async function compiledPromptFor(id: number): Promise<string> {
  return compileDirect({
    ...directGagInput(await storedVso(id)),
    subjectRenderMode: "human_identity_i2i",
    stylePrompt: "",
    referenceImageUrl: "https://example.com/ref.png",
    renderControls: {},
    renderedSubject: { name: "David Franklin", pronouns: "he/him" },
  }).imagePrompt!;
}

/** A fact the way Moderation Step 2 holds it: inactive, staged on a pending review. */
async function insertStagingFact(): Promise<{ id: number; reviewId: number }> {
  const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok", isActive: false });
  const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, id));
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: fact.text, status: "pending", workflowStage: "gags", stagingFactId: id,
  }).returning({ id: pendingReviewsTable.id });
  return { id, reviewId: review!.id };
}

describe("saving a gag — Visual Concept budget", () => {
  it("400s a Concept of 200 {NAME} tokens (under the raw cap) with a core_scene_rendered_too_long detail", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const tokenHeavy = "{NAME} ".repeat(200).trim();
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
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const concept = "The hero stands tall in a vast arena. ".repeat(40).slice(0, 1490);
    assert.equal(concept.length, 1490);

    const res = await patchVso(id, vso({}, concept));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await storedVso(id))?.coreSceneOverride, concept);
  });

  it("400s RETIRED_FIELD for content carrying the old art-direction fields, naming them, and stores nothing (PLAN_GAG_DIRECT_RENDER.md, D)", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const line = "a perfectly ordinary guidance sentence of moderate length";
    const res = await patchVso(id, vso({
      roleBindings: [{ entity: "onlooker", visualRole: line }],
      requiredVisualDetails: [line],
      compositionGuidance: [line],
      styleAgnosticPromptAdditions: [line],
    }));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "RETIRED_FIELD");
    assert.match(JSON.stringify(res.body), /roleBindings/);
    assert.match(JSON.stringify(res.body), /requiredVisualDetails/);
    assert.equal(await storedVso(id), undefined, "a refused save stores nothing");
  });

  it("200s a typical Concept with several bubbles", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const override = vso({
      bubbles: [
        { type: "speech", entity: "subject", text: "Is that all?" },
        { type: "thought", entity: "subject", text: "Leg day tomorrow." },
      ],
    }, "{NAME} hoists a barbell overhead in a packed arena while the crowd roars.");

    const res = await patchVso(id, override);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await storedVso(id))?.bubbles, override.bubbles);
  });
});

describe("saving a gag — saved content", () => {
  it("200s a bubble whose entity (the mailman) matches no subject or role binding", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const res = await patchVso(id, vso({ bubbles: [{ type: "speech", entity: "the mailman", text: "Special delivery!" }] }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await storedVso(id))?.bubbles, [{ type: "speech", entity: "the mailman", text: "Special delivery!" }]);
  });

  it("GET /admin/facts/:id/gags returns the edited bubble after the save", async () => {
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    await patchVso(id, vso({ bubbles: [{ type: "speech", entity: "subject", text: "An old line." }] }));

    const res = await patchVso(id, vso({ bubbles: [{ type: "speech", entity: "subject", text: "An edited line." }] }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const read = await request(gagApp).get(`/api/admin/facts/${id}/gags`);
    assert.deepEqual(read.body.gags[0].pendingContent.bubbles, [{ type: "speech", entity: "subject", text: "An edited line." }]);
  });

  it("compiles a saved bubble into the prompt; refuses each retired field saved alone (RETIRED_FIELD), storing nothing", async () => {
    const bubbleId = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
    const bubbles = [{ type: "speech" as const, entity: "subject", text: "Special delivery!" }];
    const saved = await patchVso(bubbleId, vso({ bubbles }));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const stored = await storedVso(bubbleId);
    assert.equal("enabled" in stored!, false, "no enable flag stored");
    assert.deepEqual(stored!.bubbles, bubbles);
    assert.match(await compiledPromptFor(bubbleId), /Special delivery!/, "reaches the compiled prompt");

    const retired: Array<{ name: string; extra: Partial<Vso> }> = [
      { name: "requiredVisualDetails", extra: { requiredVisualDetails: ["a glowing aura"] } },
      { name: "forbiddenVisualDetails", extra: { forbiddenVisualDetails: ["a separate adult version"] } },
      { name: "roleBindings", extra: { roleBindings: [{ entity: "referee", visualRole: "waves a checkered flag" }] } },
      { name: "compositionGuidance", extra: { compositionGuidance: ["low angle wide shot"] } },
      { name: "supportingTextPolicyOverride", extra: { supportingTextPolicyOverride: { mode: "allow", guidance: "a neon sign reading OPEN" } } },
    ];
    for (const c of retired) {
      const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
      const res = await patchVso(id, vso(c.extra));
      assert.equal(res.status, 400, `${c.name}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "RETIRED_FIELD", c.name);
      assert.match(JSON.stringify(res.body), new RegExp(c.name), `${c.name}: named`);
      assert.equal(await storedVso(id), undefined, `${c.name}: nothing stored`);
    }
  });
});

describe("saving a gag — blank scene and typed scene", () => {
  it("refuses a blank scene on a new submission's staging fact with 400 SCENE_REQUIRED and stores nothing", async () => {
    const { id, reviewId } = await insertStagingFact();
    const res = await patchVso(id, vso({ bubbles: [{ type: "speech", entity: "subject", text: "Hi." }] }, "   "), reviewId);
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
    const id = await insertFact({ enrichment: VALID, enrichmentStatus: "ok" });
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
