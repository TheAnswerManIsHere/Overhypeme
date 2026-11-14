/**
 * Image engine routing (launch Phase 8, plan PLAN_PHASE8_ENGINE_EVALUATION.md,
 * A and B, as amended by PLAN_AI_SETTINGS_IN_CODE.md): the engine per render
 * mode is set in code, an attempt records the engine that draws it at
 * construction, the moderation hash folds in the engine a render would use
 * NOW, and a retired config key can change none of it. There is no engines
 * table (decisions.md 2026-11-14), so a test that switches an engine off flips
 * the catalogue definition itself and restores it after each test.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  adminConfigTable,
  factsTable,
  imagePromptAttemptsTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import {
  attemptImageEngineId,
  currentImageEngineIds, currentRenderRouting,
  IMAGE_ENGINE_IDS,
  ImageEngineRoutingError,
  resolveImageEngine,
} from "../lib/imageEngineRouting.js";
import { bustConfigCache } from "../lib/adminConfig.js";
import { clearEngineCaches } from "../lib/engineInterpreter.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { NANO_BANANA_2_SIZES } from "../lib/engines/nano-banana-2.js";
import { FLUX_3 } from "../lib/engines/flux-3.js";
import { computeScenarioInputHash } from "../lib/reviewRenderScenarios.js";
import { isAttemptStale } from "../lib/factRenderScenarios.js";
import { imageGenerationHandler } from "../lib/imagePromptJobs.js";
import { fal } from "../lib/falClient.js";
import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "t-ier-";
const USER_PREFIX = "t-ier-u-";
const RETIRED_KEYS = ["image_engine_t2i", "image_engine_i2i"] as const;

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: [],
  taxonomyConfidence: 0.9,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

let adminUserId: string;
const factIds: number[] = [];
/** Catalogue definitions a test switched off, with their original value; restored after each test. */
const switchedOff = new Map<string, boolean>();
let savedKeys: Array<typeof adminConfigTable.$inferSelect> = [];

async function restore(): Promise<void> {
  for (const [id, isActive] of switchedOff) ALL_ENGINES.find((e) => e.id === id)!.isActive = isActive;
  switchedOff.clear();
  await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, [...RETIRED_KEYS]));
  if (savedKeys.length) await db.insert(adminConfigTable).values(savedKeys);
  bustConfigCache();
  clearEngineCaches();
}

function switchOff(id: string): void {
  const def = ALL_ENGINES.find((e) => e.id === id)!;
  if (!switchedOff.has(id)) switchedOff.set(id, def.isActive);
  def.isActive = false;
}

async function setRetiredKey(key: string, value: string): Promise<void> {
  await db.insert(adminConfigTable)
    .values({ key, value, dataType: "text", label: "test", description: "test", isPublic: false })
    .onConflictDoUpdate({ target: adminConfigTable.key, set: { value } });
  bustConfigCache();
  clearEngineCaches();
}

before(async () => {
  savedKeys = await db.select().from(adminConfigTable).where(inArray(adminConfigTable.key, [...RETIRED_KEYS]));
  adminUserId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminUserId, email: `${adminUserId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  process.env["FAL_KEY"] ||= "test-key";
});

afterEach(async () => {
  await restore();
});

after(async () => {
  if (factIds.length) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  await restore();
});

describe("resolveImageEngine", () => {
  it("routes each mode to the engines set in code, whatever the retired keys say", async () => {
    await setRetiredKey("image_engine_t2i", "flux-3");
    await setRetiredKey("image_engine_i2i", "flux-3-edit");
    assert.deepEqual(IMAGE_ENGINE_IDS, { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" });
    assert.deepEqual(await currentImageEngineIds(), { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" });
    assert.deepEqual((await currentRenderRouting()).recipeVersions, { t2i: null, i2i: null }, "no prompt recipe is promoted: both modes read the baseline");
    assert.equal((await resolveImageEngine("t2i")).id, "nano-banana-2");
    assert.equal((await resolveImageEngine("i2i")).id, "nano-banana-2-edit");
  });

  it("an override wins, and the engine it returns carries the code's definition", async () => {
    const engine = await resolveImageEngine("t2i", "flux-3");
    assert.equal(engine.id, "flux-3");
    assert.equal(engine.endpointId, FLUX_3.endpointId);
    assert.equal(engine.imageMode, "t2i");
    assert.ok(engine.sizeVocabulary);
  });

  it("refuses, never defaults: no code definition, inactive, non-image, wrong mode, no vocabulary", async () => {
    const orphan = `${PREFIX}${randomUUID().slice(0, 12)}`;
    const cases: Array<[string, boolean, "t2i" | "i2i", string]> = [
      [orphan, false, "t2i", "not in the catalogue"],
      ["flux-3", true, "t2i", "inactive"],
      ["openai-general", false, "t2i", "kind is llm"],
      ["nano-banana-2-edit", false, "t2i", "mode is i2i"],
      ["nano-banana-pro", false, "i2i", "no size vocabulary"],
    ];
    for (const [id, off, mode, why] of cases) {
      if (off) switchOff(id);
      await assert.rejects(resolveImageEngine(mode, id), (err: unknown) =>
        err instanceof ImageEngineRoutingError && err.message.includes(why), `${id}: ${why}`);
      await restore();
    }
  });
});

describe("attribution", () => {
  it("a stored engine wins; a null left by an older release reads as that release's engine for its mode", () => {
    assert.equal(attemptImageEngineId({ actualImageEngineId: "x-engine", generationMode: "i2i" }), "x-engine");
    assert.equal(attemptImageEngineId({ actualImageEngineId: null, generationMode: "i2i" }), "nano-banana-2-edit");
    assert.equal(attemptImageEngineId({ actualImageEngineId: null, generationMode: "t2i" }), "nano-banana-2");
  });

  it("the moderation hash follows the mode's current engine, and an older attempt reads stale", () => {
    const engines = { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" };
    const before = computeScenarioInputHash("generic_t2i", 1, "{NAME} lifts a truck.", ENRICHMENT, engines);
    const changedOtherMode = computeScenarioInputHash("generic_t2i", 1, "{NAME} lifts a truck.", ENRICHMENT, { ...engines, i2i: "other" });
    const changedOwnMode = computeScenarioInputHash("generic_t2i", 1, "{NAME} lifts a truck.", ENRICHMENT, { ...engines, t2i: "other" });
    assert.equal(changedOtherMode, before, "the i2i key does not touch a t2i scenario");
    assert.notEqual(changedOwnMode, before);
    const attempt = { reviewRenderInputHash: before } as never;
    assert.equal(isAttemptStale(attempt, before), false);
    assert.equal(isAttemptStale(attempt, changedOwnMode), true);
  });
});

describe("the worker renders through the engine recorded at construction", () => {
  it("an attempt renders through its recorded engine's code definition, and records its request settings", async () => {
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} lifts a truck.", isActive: false, enrichment: ENRICHMENT }).returning({ id: factsTable.id });
    factIds.push(fact!.id);
    const [attempt] = await db.insert(imagePromptAttemptsTable).values({
      factId: fact!.id,
      renderJobId: randomUUID(),
      generationMode: "t2i",
      subjectRenderMode: "t2i_fallback",
      targetEngine: "nano_banana_2",
      actualImageEngineId: (await resolveImageEngine("t2i")).id,
      sourceImageAnalysis: {} as never,
      identityPolicy: {} as never,
      renderControls: { aspectRatio: "portrait" } as never,
      factEnrichmentSnapshot: ENRICHMENT as never,
      archetypeStrategyVersion: "v2",
      compiledPrompt: { imagePrompt: "a truck, lifted" } as never,
    }).returning({ id: imagePromptAttemptsTable.id });

    const calls: Array<{ endpoint: string; input: Record<string, unknown> }> = [];
    const original = fal.subscribe;
    (fal as { subscribe: unknown }).subscribe = async (endpoint: string, opts: { input: Record<string, unknown> }) => {
      calls.push({ endpoint, input: opts.input });
      throw new Error("stub: stop before download");
    };
    try {
      await imageGenerationHandler.run({ attemptId: attempt!.id }, {} as never);
    } finally {
      (fal as { subscribe: unknown }).subscribe = original;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.endpoint, "fal-ai/nano-banana-2", "the code's endpoint");
    const codeResolutions = NANO_BANANA_2_SIZES.options.map((o) => (o.params as Record<string, unknown>)["resolution"]);
    assert.ok(codeResolutions.includes(calls[0]!.input["resolution"]), `a resolution from the code's vocabulary, got ${String(calls[0]!.input["resolution"])}`);
    const [row] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attempt!.id));
    assert.equal(row!.actualImageEngineId, "nano-banana-2");
  });
});

describe("the retired keys", () => {
  it("the generic config route refuses both", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminRouter);
    for (const key of RETIRED_KEYS) {
      const res = await request(app).patch(`/api/admin/config/${key}`).send({ value: "anything" });
      assert.equal(res.status, 403, key);
    }
    assert.deepEqual(await currentImageEngineIds(), { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" });
  });
});
