/**
 * Image engine routing (launch Phase 8, plan PLAN_PHASE8_ENGINE_EVALUATION.md,
 * A and B): the engine per render mode is a config key, an attempt records
 * the engine that draws it at construction, the moderation hash folds in the
 * engine a render would use NOW, and "Set default" is the keys' one writer.
 *
 * Touches the real test DB: engine rows under `t-ier-`, and the two
 * `image_engine_*` config keys, restored to their seeded values after each test.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  adminConfigTable,
  enginesTable,
  factsTable,
  imagePromptAttemptsTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import {
  attemptImageEngineId,
  currentImageEngineIds, currentRenderRouting,
  IMAGE_ENGINE_CONFIG_KEYS,
  ImageEngineRoutingError,
  resolveImageEngine,
} from "../lib/imageEngineRouting.js";
import { bustConfigCache } from "../lib/adminConfig.js";
import { clearEngineCaches } from "../lib/engineInterpreter.js";
import { computeScenarioInputHash } from "../lib/reviewRenderScenarios.js";
import { isAttemptStale } from "../lib/factRenderScenarios.js";
import { imageGenerationHandler } from "../lib/imagePromptJobs.js";
import { fal } from "../lib/falClient.js";
import adminEnginesRouter from "../routes/adminEngines.js";
import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const PREFIX = "t-ier-";
const USER_PREFIX = "t-ier-u-";

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

const VOCAB = { options: [{ params: { resolution: "1K" }, megapixels: 1 }, { params: { resolution: "2K" }, megapixels: 4 }] };

interface SeedOpts {
  imageMode?: "t2i" | "i2i" | null;
  isActive?: boolean;
  retired?: boolean;
  deleted?: boolean;
  kind?: string;
  sizeVocabulary?: unknown;
}

async function seedEngine(opts: SeedOpts = {}): Promise<string> {
  const id = `${PREFIX}${randomUUID().slice(0, 12)}`;
  await db.insert(enginesTable).values({
    id,
    provider: "fal",
    endpointId: `fal-ai/test/${id}`,
    label: `Routing test ${id}`,
    kind: opts.kind ?? "image",
    isActive: opts.isActive ?? true,
    imageMode: opts.imageMode === undefined ? "t2i" : opts.imageMode,
    family: "t-ier",
    sizeVocabulary: (opts.sizeVocabulary === undefined ? VOCAB : opts.sizeVocabulary) as never,
    retired: opts.retired ?? false,
    deletedAt: opts.deleted ? new Date() : null,
    paramSchema: {
      params: [
        { name: "prompt", from: "imagePrompt", type: "string", required: true },
        { name: "resolution", from: "resolution", type: "string" },
        { name: "image_urls", from: "referenceImageUrl", type: "stringArray" },
      ],
    } as never,
  });
  return id;
}

async function setKey(mode: "t2i" | "i2i", value: string): Promise<void> {
  // Upsert: a runner's cloned database may hold the schema without 0123's seed rows.
  await db.insert(adminConfigTable)
    .values({ key: IMAGE_ENGINE_CONFIG_KEYS[mode], value, dataType: "text", label: "test", description: "test", isPublic: false })
    .onConflictDoUpdate({ target: adminConfigTable.key, set: { value } });
  bustConfigCache();
  clearEngineCaches();
}

async function restoreKeys(): Promise<void> {
  await setKey("t2i", "nano-banana-2");
  await setKey("i2i", "nano-banana-2-edit");
}

let adminUserId: string;
const factIds: number[] = [];

before(async () => {
  adminUserId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminUserId, email: `${adminUserId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  process.env["FAL_KEY"] ||= "test-key";
});

afterEach(async () => {
  await restoreKeys();
});

after(async () => {
  if (factIds.length) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(enginesTable).where(like(enginesTable.id, `${PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  await restoreKeys();
});



describe("resolveImageEngine", () => {
  it("the seeded keys route each mode to the engines the worker always used", async () => {
    assert.deepEqual(await currentImageEngineIds(), { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" });
    assert.deepEqual((await currentRenderRouting()).recipeVersions, { t2i: null, i2i: null }, "no prompt recipe is promoted: both modes read the baseline");
    assert.equal((await resolveImageEngine("t2i")).id, "nano-banana-2");
    assert.equal((await resolveImageEngine("i2i")).id, "nano-banana-2-edit");
  });

  it("a key change routes that mode only; an override wins over the key", async () => {
    const t2i = await seedEngine({ imageMode: "t2i" });
    await setKey("t2i", t2i);
    assert.equal((await resolveImageEngine("t2i")).id, t2i);
    assert.equal((await resolveImageEngine("i2i")).id, "nano-banana-2-edit");
    assert.equal((await resolveImageEngine("t2i", "nano-banana-2")).id, "nano-banana-2");
  });

  it("refuses, never defaults: unknown, inactive, archived, retired, non-image, wrong mode, no vocabulary", async () => {
    const cases: Array<[string, string]> = [
      [`${PREFIX}missing`, "not in the catalogue"],
      [await seedEngine({ isActive: false }), "inactive"],
      [await seedEngine({ deleted: true }), "archived"],
      [await seedEngine({ retired: true }), "retired"],
      [await seedEngine({ kind: "utility", imageMode: null }), "kind is utility"],
      [await seedEngine({ imageMode: "i2i" }), "mode is i2i"],
      [await seedEngine({ sizeVocabulary: null }), "no size vocabulary"],
    ];
    for (const [id, why] of cases) {
      await assert.rejects(resolveImageEngine("t2i", id), (err: unknown) =>
        err instanceof ImageEngineRoutingError && err.message.includes(why), id);
      await setKey("t2i", id);
      await assert.rejects(resolveImageEngine("t2i"), ImageEngineRoutingError, `${id} via the key`);
      await setKey("t2i", "nano-banana-2");
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
  it("an attempt made under engine A still renders through A after the key moves to B, and records its request settings", async () => {
    const a = await seedEngine({ imageMode: "t2i" });
    const b = await seedEngine({ imageMode: "t2i" });
    await setKey("t2i", a);
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

    await setKey("t2i", b);

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
    assert.equal(calls[0]!.endpoint, `fal-ai/test/${a}`, "rendered through A, not the new default B");
    assert.equal(calls[0]!.input["resolution"], "2K", "a member render is final: the option nearest four megapixels");
    const [row] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attempt!.id));
    assert.equal(row!.actualImageEngineId, a);
    assert.deepEqual(row!.requestSettings, { engineId: a, purpose: "final", aspectRatio: "portrait", sizeParams: { resolution: "2K" }, megapixels: 4 });
  });
});

describe("Set default is the keys' one writer", () => {
  it("writes the engine's own mode key and leaves the other mode and isDefault alone", async () => {
    const i2i = await seedEngine({ imageMode: "i2i" });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${i2i}/set-default`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.isDefault, false);
    assert.deepEqual(await currentImageEngineIds(), { t2i: "nano-banana-2", i2i });
  });

  it("refuses an engine that cannot draw its mode, and changes nothing", async () => {
    const noMode = await seedEngine({ imageMode: null });
    const inactive = await seedEngine({ imageMode: "t2i", isActive: false });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    for (const id of [noMode, inactive]) {
      const res = await request(app).post(`/api/admin/engines/${id}/set-default`).send({});
      assert.equal(res.status, 400, id);
    }
    assert.deepEqual(await currentImageEngineIds(), { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" });
  });

  it("the editor's default toggle cannot change an image engine's flag, and an unchanged flag still saves", async () => {
    const id = await seedEngine({ imageMode: "t2i" });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const refused = await request(app).patch(`/api/admin/engines/${id}`).send({ isDefault: true });
    assert.equal(refused.status, 400);
    const saved = await request(app).patch(`/api/admin/engines/${id}`).send({ isDefault: false, sortOrder: 5 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });

  it("the list says which mode each image engine is the default for", async () => {
    const t2i = await seedEngine({ imageMode: "t2i" });
    await setKey("t2i", t2i);
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get("/api/admin/engines");
    assert.equal(res.status, 200);
    const rows = res.body.engines as Array<{ id: string; defaultForImageMode: string | null }>;
    assert.equal(rows.find((r) => r.id === t2i)?.defaultForImageMode, "t2i");
    assert.equal(rows.find((r) => r.id === "nano-banana-2")?.defaultForImageMode ?? null, null);
    assert.deepEqual(res.body.imageEngines, { t2i, i2i: "nano-banana-2-edit" });
  });

  it("the generic config route refuses both keys", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminRouter);
    for (const key of Object.values(IMAGE_ENGINE_CONFIG_KEYS)) {
      const res = await request(app).patch(`/api/admin/config/${key}`).send({ value: "anything" });
      assert.equal(res.status, 403, key);
    }
    assert.deepEqual(await currentImageEngineIds(), { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" });
  });
});
