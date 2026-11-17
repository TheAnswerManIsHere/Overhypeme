/**
 * The render worker (image_prompt_generation) and the image job
 * (image_generation). Since the render planner was removed (plan
 * docs/plans/PLAN_GAG_DIRECT_RENDER.md, D), the worker compiles the gag frozen
 * on the attempt directly, makes no model call, and stores only the compiled
 * prompt; a frozen gag that cannot be drawn ends the render terminally.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, imagePromptAttemptsTable, asyncJobsTable, promptRecipeVersionsTable, imageProvenanceTable, imageGenerationRequestsTable } from "@workspace/db/schema";
import type { EngineFallbackRecord } from "@workspace/db";
import sharp from "sharp";
import { ApiError, ValidationError } from "@fal-ai/client";
import { eq, inArray } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import {
  persistCompiledPromptAndEnqueueGeneration,
  imagePromptGenerationHandler,
  IMAGE_GENERATION_QUEUE,
  imageGenerationHandler,
} from "../lib/imagePromptJobs.js";
import { fal } from "../lib/falClient.js";
import { fallbackEngineIdFor } from "../lib/imageEngineRouting.js";
import { fallbackLineFor } from "../lib/reviewRenderScenarios.js";
import { isAttemptStale } from "../lib/factRenderScenarios.js";
import { buildRenderStatusPayload } from "../lib/imagePromptAttempts.js";
import { traceIdOrLink } from "../lib/provenance/trace.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";
import { __setUtilityLLMClientForTest } from "../lib/utilityLLM.js";
import { defaultIdentityPolicyForRenderMode } from "@workspace/api-zod";
import { withCast } from "./helpers/gagCast.js";

const USER_PREFIX = "t_ipj_";

const VALID_ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
  characters: [],
};

let userId: string;
const insertedFactIds: number[] = [];
const insertedAttemptIds: number[] = [];

async function seedAttempt(): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({
      text: "{NAME} bench-presses the Earth.",
      submittedById: userId,
      isActive: false,
      enrichment: VALID_ENRICHMENT,
    })
    .returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);

  const [attempt] = await db
    .insert(imagePromptAttemptsTable)
    .values({
      factId: fact!.id,
      userId,
      renderJobId: randomUUID(),
      generationMode: "t2i",
      subjectRenderMode: "t2i_fallback",
      targetEngine: "nano_banana_2",
      sourceImageAnalysis: {} as never,
      identityPolicy: {} as never,
      renderControls: { aspectRatio: "portrait" } as never,
      factEnrichmentSnapshot: VALID_ENRICHMENT as never,
      archetypeStrategyVersion: "v2",
    })
    .returning({ id: imagePromptAttemptsTable.id });
  insertedAttemptIds.push(attempt!.id);
  return attempt!.id;
}

async function cleanup() {
  if (insertedAttemptIds.length) {
    await db
      .delete(asyncJobsTable)
      .where(
        inArray(
          asyncJobsTable.dedupeKey,
          insertedAttemptIds.map((id) => `image_generation:attempt:${id}`),
        ),
      );
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.id, insertedAttemptIds));
    insertedAttemptIds.length = 0;
  }
  if (insertedFactIds.length) {
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
}

before(async () => {
  userId = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id: userId,
    email: `${userId}@test.local`,
    isAdmin: false,
    membershipTier: "registered",
    emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
  });
});

after(async () => {
  __setUtilityLLMClientForTest(null);
  await cleanup();
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("persistCompiledPromptAndEnqueueGeneration — stores the prompt and chains image_generation", () => {
  it("stores the compiled prompt and no plan, leaves error NULL, and enqueues image_generation", async () => {
    const attemptId = await seedAttempt();

    await persistCompiledPromptAndEnqueueGeneration({
      attemptId,
      compiledPrompt: { prompt: "test prompt", imagePrompt: "test prompt" },
    });

    const [row] = await db
      .select()
      .from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.id, attemptId));
    assert.equal(row!.error, null);
    assert.deepEqual(row!.compiledPrompt, { prompt: "test prompt", imagePrompt: "test prompt" });
    assert.equal(row!.visualPlan, null, "a direct attempt stores no plan");
    assert.equal(row!.subjectFactCompatibility, null, "nor a planner's compatibility rating");
    assert.equal(buildRenderStatusPayload(row!).status, "prompt_ready", "prompt_ready derives from the compiled prompt");

    const [job] = await db
      .select()
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
    assert.ok(job, "expected an image_generation job to be enqueued");
    assert.equal(job!.queue, IMAGE_GENERATION_QUEUE);
    assert.equal((job!.payload as { attemptId: number }).attemptId, attemptId);
    assert.equal(job!.status, "pending");
  });
});

// ── image_prompt_generation handler: Concept warnings + deterministic terminal failures ──
//
// Drives the real handler on a seeded attempt. The OpenAI client behind
// callUtilityLLM is replaced by a counter (via its test seam) that fails the
// test's expectations if anything calls it: the render makes no model call.

const FACT_TEXT_RENDERED = "David doesn't read books. He stares them down until he gets the information he wants.";

function handlerEnrichment(override?: Record<string, unknown>): FactEnrichment {
  return {
    primaryArchetype: "presence_induced_reaction_aura",
    subtype: "awe_deference",
    modifiers: [],
    visualLiteralness: "mixed",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["books", "reading", "legendary"],
    taxonomyConfidence: 0.9,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    characters: [],
    ...(override
      ? {
          // The gag frozen on the attempt carries a cast read from its own
          // scene (PLAN_GAG_DIRECT_RENDER.md, C); a test that wants a stale or
          // missing cast overrides it after.
          visualPromptStrategyOverride: withCast({
            version: 1,
            requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
            compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
            bubbles: [],
            ...override,
          } as never),
        }
      : {}),
  } as unknown as FactEnrichment;
}

let llmCalls = 0;
/** Counts any model call; the render worker should make none. */
function installLlmCounter(): void {
  llmCalls = 0;
  __setUtilityLLMClientForTest({
    chat: {
      completions: {
        create: async () => {
          llmCalls++;
          throw new Error("the render worker makes no model call");
        },
      },
    },
  } as never);
}

/** An attempt shaped like a fresh human-i2i render with a frozen identity + fact text. */
async function seedHandlerAttempt(opts: {
  snapshot: unknown;
  renderedFactText?: string | null;
}): Promise<number> {
  const [fact] = await db
    .insert(factsTable)
    .values({ text: "{NAME} doesn't read books.", submittedById: userId, isActive: false, enrichment: VALID_ENRICHMENT })
    .returning({ id: factsTable.id });
  insertedFactIds.push(fact!.id);
  const [attempt] = await db
    .insert(imagePromptAttemptsTable)
    .values({
      factId: fact!.id,
      userId,
      renderJobId: randomUUID(),
      generationMode: "i2i",
      subjectRenderMode: "human_identity_i2i",
      targetEngine: "nano_banana_2",
      sourceImageAnalysis: {
        subjectKind: "human_face", confidence: "high", hasUsableHumanFace: true, hasUsableSubject: true,
        subjectCount: 1, warnings: [], suggestedRenderMode: "human_identity_i2i",
        classificationMethod: "fal_detector", analyzerVersion: "v1",
      } as never,
      identityPolicy: defaultIdentityPolicyForRenderMode("human_identity_i2i") as never,
      renderControls: {
        aspectRatio: "portrait",
        contentMode: "sfw",
        promptIdentity: { version: 1, name: "David", pronouns: "he/him", source: "review_sample" },
      } as never,
      factEnrichmentSnapshot: opts.snapshot as never,
      renderedFactText: opts.renderedFactText === undefined ? FACT_TEXT_RENDERED : opts.renderedFactText,
      archetypeStrategyVersion: "v2",
    })
    .returning({ id: imagePromptAttemptsTable.id });
  insertedAttemptIds.push(attempt!.id);
  return attempt!.id;
}

async function runHandler(attemptId: number) {
  return imagePromptGenerationHandler.run({ attemptId }, {} as never);
}

async function attemptRow(attemptId: number) {
  const [row] = await db.select().from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attemptId));
  return row!;
}

async function generationJob(attemptId: number) {
  const [job] = await db
    .select()
    .from(asyncJobsTable)
    .where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
  return job;
}

describe("image_prompt_generation handler — Concept with compiler-owned language", () => {
  it("enqueues image_generation (does not fail) and persists the owned-language warning", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({
      snapshot: handlerEnrichment({
        coreSceneOverride: "{NAME} rides a T-Rex through the office. Ensure {NAME}'s recognizable face is preserved.",
      }),
    });

    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(llmCalls, 0, "no model call: the gag is compiled directly");

    const row = await attemptRow(attemptId);
    assert.equal(row.error, null);
    assert.equal(row.errorCode, null);
    assert.equal(row.visualPlan, null, "no plan is stored");
    const compiled = row.compiledPrompt as {
      imagePrompt: string;
      diagnostics?: { warnings?: Array<{ code: string }> };
    };
    assert.ok(
      compiled.diagnostics?.warnings?.some((w) => w.code === "moderator_core_scene_owned_language"),
      JSON.stringify(compiled.diagnostics?.warnings),
    );
    // Kept verbatim, with the subject name resolved.
    assert.match(compiled.imagePrompt, /Ensure David's recognizable face is preserved\./);

    const job = await generationJob(attemptId);
    assert.ok(job, "expected an image_generation job");
    assert.equal(job!.queue, IMAGE_GENERATION_QUEUE);
  });
});

describe("image_prompt_generation handler — stored bubble token", () => {
  it("compiles a {NAME} bubble with the attempt's identity into the rendered name, no raw token", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({
      snapshot: handlerEnrichment({
        coreSceneOverride: "{NAME} stands in a library surrounded by glowing books.",
        bubbles: [{ type: "speech", entity: "subject", text: "{NAME} did it again!" }],
      }),
    });

    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));

    const compiled = (await attemptRow(attemptId)).compiledPrompt as { imagePrompt: string };
    assert.ok(compiled.imagePrompt.includes('containing exactly the text "David did it again!"'), compiled.imagePrompt);
    assert.doesNotMatch(compiled.imagePrompt, /\{NAME\}/);
    assert.ok(await generationJob(attemptId), "image_generation enqueued");
  });
});

describe("image_prompt_generation handler — the prompt recipe it was queued with (the prompt tuner)", () => {
  it("compiles with the attempt's recipe version, and recompiling its frozen gag with other wording needs no model call", async () => {
    installLlmCounter();
    const family = `t-ipj-${randomUUID().slice(0, 6)}`;
    const [version] = await db.insert(promptRecipeVersionsTable).values({
      engineFamily: family, number: 1, note: "test", pieces: { "identity.person": "Use the photo as the person's face, exactly." },
    }).returning({ id: promptRecipeVersionsTable.id });
    try {
      const attemptId = await seedHandlerAttempt({ snapshot: handlerEnrichment({ coreSceneOverride: "{NAME} lifts a library." }) });
      await db.update(imagePromptAttemptsTable).set({ recipeVersionId: version!.id }).where(eq(imagePromptAttemptsTable.id, attemptId));
      const res = await runHandler(attemptId);
      assert.equal(res.ok, true, JSON.stringify(res));
      const row = await attemptRow(attemptId);
      const prompt = (row.compiledPrompt as { imagePrompt: string }).imagePrompt;
      assert.match(prompt, /IDENTITY & REFERENCE: Use the photo as the person's face, exactly\./);
      assert.doesNotMatch(prompt, /identity source/, "the baseline identity paragraph is replaced, not added to");

      const calls = llmCalls;
      const { recompileStoredAttempt } = await import("../lib/imagePromptJobs.js");
      const { recipeFrom } = await import("../lib/imagePrompt/recipe.js");
      const again = await recompileStoredAttempt(row, recipeFrom(null, { "identity.person": "Another wording." }));
      assert.ok(again);
      assert.match(again!.prompt, /IDENTITY & REFERENCE: Another wording\./);
      assert.match(again!.prompt, /lifts a library/, "the same stored scene");
      assert.equal(llmCalls, calls, "no model call");

      // The preview's highlighting reads the same stored scene, marked: the
      // wording comes back as its piece and the text is otherwise unchanged.
      const { markRecipe, segmentsOf } = await import("../lib/imagePrompt/recipeHighlight.js");
      const marked = await recompileStoredAttempt(row, markRecipe(recipeFrom(null, { "identity.person": "Another wording." })));
      const plain = new Map((again!.promptBreakdown ?? []).map((sec) => [sec.id, sec.text]));
      for (const sec of marked!.promptBreakdown ?? []) {
        assert.equal(segmentsOf(sec.text).map((g) => g.text).join(""), plain.get(sec.id), `section ${sec.id} reads back unchanged`);
      }
      const all = (marked!.promptBreakdown ?? []).flatMap((sec) => segmentsOf(sec.text));
      assert.ok(all.some((g) => g.piece === "identity.person" && g.text === "Another wording."), "the edited piece is marked as itself");
      assert.equal(llmCalls, calls, "still no model call");
    } finally {
      await db.update(imagePromptAttemptsTable).set({ recipeVersionId: null }).where(eq(imagePromptAttemptsTable.recipeVersionId, version!.id));
      await db.delete(promptRecipeVersionsTable).where(eq(promptRecipeVersionsTable.id, version!.id));
    }
  });
});

describe("image_prompt_generation handler — deterministic failures are terminal on the first attempt", () => {
  async function assertTerminal(attemptId: number, code: string) {
    const res = await runHandler(attemptId);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.ok(!res.ok && res.retryable === false, "terminal, not retryable");
    assert.ok(!res.ok && "code" in res && res.code === code, JSON.stringify(res));
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, code);
    assert.ok(row.error, "human-readable error persisted alongside the code");
    assert.equal(await generationJob(attemptId), undefined, "no image_generation job enqueued");
  }

  it("a corrupt frozen enrichment → invalid_persisted_enrichment", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({ snapshot: { primaryArchetype: "nope" } });
    await assertTerminal(attemptId, "invalid_persisted_enrichment");
    assert.equal(llmCalls, 0);
  });

  it("a frozen gag with no scene → gag_scene_missing", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({ snapshot: handlerEnrichment() });
    await assertTerminal(attemptId, "gag_scene_missing");
  });

  it("a frozen gag whose cast was not read from its scene as it stands → gag_cast_not_current", async () => {
    installLlmCounter();
    const stale = handlerEnrichment({ coreSceneOverride: "{NAME} stands in a library." }) as unknown as { visualPromptStrategyOverride: Record<string, unknown> };
    stale.visualPromptStrategyOverride.coreSceneOverride = "{NAME} stands in a different library.";
    const staleId = await seedHandlerAttempt({ snapshot: stale });
    await assertTerminal(staleId, "gag_cast_not_current");

    const noCast = handlerEnrichment({ coreSceneOverride: "{NAME} stands in a library." }) as unknown as { visualPromptStrategyOverride: Record<string, unknown> };
    delete noCast.visualPromptStrategyOverride.cast;
    delete noCast.visualPromptStrategyOverride.castExtraction;
    const noCastId = await seedHandlerAttempt({ snapshot: noCast });
    await assertTerminal(noCastId, "gag_cast_not_current");
  });

  it("the frozen fact text is not an input: a leaked {NAME} token in it does not stop the render", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({
      snapshot: handlerEnrichment({ coreSceneOverride: "{NAME} stands in a library surrounded by glowing books." }),
      renderedFactText: "{NAME} doesn't read books.",
    });
    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));
    const compiled = (await attemptRow(attemptId)).compiledPrompt as { imagePrompt: string };
    assert.doesNotMatch(compiled.imagePrompt, /\{NAME\}/);
    assert.ok(await generationJob(attemptId), "image_generation enqueued");
  });

  it("the retired art-direction fields frozen on an older gag reach no prompt and cannot overflow it", async () => {
    installLlmCounter();
    // 40 (the schema maximum) very long required details: while the planner
    // path compiled them this overflowed the budget (required_budget_overflow).
    const hugeRequired = Array.from(
      { length: 40 },
      (_, i) => `mandatory prop number ${i} ` + `rendered in painstaking detail${i} `.repeat(8),
    );
    const attemptId = await seedHandlerAttempt({
      snapshot: handlerEnrichment({
        coreSceneOverride: "{NAME} stands in a library surrounded by glowing books.",
        requiredVisualDetails: hugeRequired,
      }),
    });
    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));
    const compiled = (await attemptRow(attemptId)).compiledPrompt as { imagePrompt: string };
    assert.doesNotMatch(compiled.imagePrompt, /mandatory prop number/);
  });
});

// ─── The photoreal fallback (plan PLAN_NB_FALLBACK.md, Issue #980) ───────────

describe("image_generation — the photoreal fallback: GPT Image refuses, Nano Banana draws", () => {
  const photos = photoBackgrounds();
  const GPT = "openai/gpt-image-2.6/sunburst/edit";
  const NB = "google/nano-banana-2.1/edit";
  const REFUSAL = "The content could not be processed because it contained material flagged by a content checker.";
  let png: Buffer;
  const factIdsHere: number[] = [];

  before(async () => {
    photos.setUp();
    png = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#456" } }).png().toBuffer();
  });
  after(async () => {
    if (factIdsHere.length) {
      await db.delete(imageProvenanceTable).where(inArray(imageProvenanceTable.factId, factIdsHere));
      await db.delete(imageGenerationRequestsTable).where(inArray(imageGenerationRequestsTable.factId, factIdsHere));
    }
    await photos.tearDown();
  });

  function refusal() {
    return new ValidationError({ message: "Unprocessable Entity", status: 422, body: { detail: [{ loc: ["body", "prompt"], msg: REFUSAL, type: "content_policy_violation" }] } });
  }

  /**
   * A prepared photoreal attempt routed to GPT Image, with its fallback frozen as
   * at queue time. `moderation` marks it an ephemeral moderation render; without
   * it the attempt is member-shaped (the `final` purpose, mirrored to legacy storage).
   */
  async function plannedAttempt(opts: { moderation?: boolean; engine?: string; frozen?: boolean } = {}): Promise<number> {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({ snapshot: handlerEnrichment({ coreSceneOverride: "{NAME} lifts a library." }) });
    const row = await attemptRow(attemptId);
    factIdsHere.push(row.factId);
    const engine = opts.engine ?? "gpt-image-2-6-edit";
    await db.update(imagePromptAttemptsTable).set({
      actualImageEngineId: engine,
      renderControls: {
        ...(row.renderControls as Record<string, unknown>),
        referenceImageUrl: "https://example.test/reference.png",
        ...(opts.moderation ? { mirrorToLegacyStorage: false } : {}),
        ...(opts.frozen === false || engine !== "gpt-image-2-6-edit" ? {} : { engineFallback: { engineId: "nano-banana-2-1-edit", recipeVersionId: null } }),
      } as never,
    }).where(eq(imagePromptAttemptsTable.id, attemptId));
    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));
    return attemptId;
  }

  /** Run the image job with fal answering per endpoint; returns the result and the endpoints called. */
  async function draw(attemptId: number, answer: (endpoint: string, n: number) => unknown) {
    const calls: Array<{ endpoint: string; input: Record<string, unknown> }> = [];
    const original = fal.subscribe;
    (fal as { subscribe: unknown }).subscribe = async (endpoint: string, o: { input: Record<string, unknown> }) => {
      calls.push({ endpoint, input: o.input });
      const a = answer(endpoint, calls.filter((c) => c.endpoint === endpoint).length);
      if (a instanceof Error) throw a;
      return a;
    };
    const priorKey = process.env["FAL_AI_API_KEY"];
    process.env["FAL_AI_API_KEY"] = priorKey ?? "test-fal-key";
    try {
      const out = await imageGenerationHandler.run({ attemptId }, {} as never);
      return { out, calls };
    } finally {
      (fal as { subscribe: unknown }).subscribe = original;
      if (priorKey === undefined) delete process.env["FAL_AI_API_KEY"];
      else process.env["FAL_AI_API_KEY"] = priorKey;
    }
  }
  const picture = () => ({ requestId: `req-${randomUUID()}`, data: { images: [{ url: `data:image/png;base64,${png.toString("base64")}` }] } });

  it("routing names a fallback for the photoreal engines only", () => {
    assert.equal(fallbackEngineIdFor("gpt-image-2-6-edit"), "nano-banana-2-1-edit");
    assert.equal(fallbackEngineIdFor("gpt-image-2-6"), "nano-banana-2-1");
    assert.equal(fallbackEngineIdFor("nano-banana-2-1-edit"), null, "the styled engine, and the fallback itself, have none");
    assert.equal(fallbackEngineIdFor("nano-banana-2-edit"), null);
  });

  it("a member-shaped render: GPT refuses once, Nano Banana draws the same scene, and every trace of the picture names Nano Banana", async () => {
    const attemptId = await plannedAttempt();
    const before = await attemptRow(attemptId);
    const modelCalls = llmCalls;
    const { out, calls } = await draw(attemptId, (e) => (e === GPT ? refusal() : picture()));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(calls.map((c) => c.endpoint), [GPT, NB], "GPT once, no retry on it, then Nano Banana once");
    assert.equal(llmCalls, modelCalls, "no model call: the frozen gag is compiled again");

    const after = await attemptRow(attemptId);
    assert.equal(after.actualImageEngineId, "nano-banana-2-1-edit", "the attempt names the engine that drew it");
    assert.equal(after.error, null);
    assert.equal(after.errorCode, null);
    assert.ok(after.generatedImageObjectPath);
    const fb = after.engineFallback as EngineFallbackRecord;
    assert.equal(fb.state, "switched");
    assert.equal(fb.routedEngineId, "gpt-image-2-6-edit");
    assert.equal(fb.reason, REFUSAL);
    assert.equal(fb.fallbackEngineId, "nano-banana-2-1-edit");
    assert.equal(fb.resolvedAtHandover, false, "the fallback frozen at queue time was used");
    assert.ok(fb.refusedGenerationRequestId, "the refused request is linked");

    // Preserved: the frozen inputs. Changed: only the recipe, prompt and engine.
    for (const k of ["renderControls", "sourceImageAnalysis", "identityPolicy", "factEnrichmentSnapshot", "renderedFactText", "generationMode", "subjectRenderMode"] as const) {
      assert.deepEqual(after[k], before[k], `${k} is unchanged`);
    }
    const prompt = (after.compiledPrompt as { imagePrompt: string; referenceImageUrl?: string }).imagePrompt;
    assert.match(prompt, /lifts a library/, "the same scene");
    assert.equal((after.compiledPrompt as { referenceImageUrl?: string }).referenceImageUrl, "https://example.test/reference.png", "the same photo");
    assert.equal(calls[1]!.input["prompt"], prompt, "Nano Banana received the recompiled prompt");
    assert.deepEqual(calls[1]!.input["image_urls"] ?? calls[1]!.input["image_url"] ?? null, calls[0]!.input["image_urls"] ?? calls[0]!.input["image_url"] ?? null, "the same reference sent to both");

    // Provenance: the record, its request and its prompt all name Nano Banana.
    const [record] = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.attemptId, attemptId));
    assert.ok(record);
    assert.equal(record!.engineId, "nano-banana-2-1-edit");
    const [request] = await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.id, record!.generationRequestId!));
    assert.equal(request!.engineId, "nano-banana-2-1-edit");
    assert.equal(request!.endpointId, NB);
    assert.equal((record!.snapshot as { prompt: string }).prompt, prompt);
    const [refused] = await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.id, fb.refusedGenerationRequestId!));
    assert.equal(refused!.endpointId, GPT, "the refused request is GPT's");

    // The trace reads the refusal from the record's frozen snapshot, after the attempt is gone.
    await db.delete(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attemptId));
    const traced = await traceIdOrLink(String(record!.id));
    const m = traced.matches[0]!;
    assert.equal(m.record.engineId, "nano-banana-2-1-edit");
    assert.equal(m.engineFallback?.record.routedEngineId, "gpt-image-2-6-edit");
    assert.equal(m.engineFallback?.record.reason, REFUSAL);
    assert.equal(m.engineFallback?.refusedRequest?.endpointId, GPT);
  });

  it("both refuse: the render ends at once, naming both refusals; one call to each engine", async () => {
    const attemptId = await plannedAttempt({ moderation: true });
    const { out, calls } = await draw(attemptId, () => refusal());
    assert.equal(out.ok, false);
    assert.equal((out as { retryable?: boolean }).retryable, false, "terminal, not retried");
    assert.deepEqual(calls.map((c) => c.endpoint), [GPT, NB]);
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, "vendor_content_refused");
    assert.match(row.error ?? "", /gpt-image-2-6-edit refused this picture/);
    assert.match(row.error ?? "", /refused it too/);
    assert.equal((row.engineFallback as EngineFallbackRecord).reason, REFUSAL, "GPT's refusal stays recorded");
  });

  it("a non-content failure never falls back and is not written to the render while the queue retries", async () => {
    const attemptId = await plannedAttempt({ moderation: true });
    const { out, calls } = await draw(attemptId, () => new ApiError({ message: "Internal Server Error", status: 500, body: {} }));
    assert.equal(out.ok, false);
    assert.notEqual((out as { retryable?: boolean }).retryable, false, "retryable");
    assert.deepEqual(calls.map((c) => c.endpoint), [GPT]);
    const row = await attemptRow(attemptId);
    assert.equal(row.engineFallback, null);
    assert.equal(row.error, null, "the render still reads as rendering");
    assert.equal(buildRenderStatusPayload(row).status, "prompt_ready");
  });

  it("a retry after the handover draws on Nano Banana; GPT is called once in total", async () => {
    const attemptId = await plannedAttempt({ moderation: true });
    const first = await draw(attemptId, (e) => (e === GPT ? refusal() : new ApiError({ message: "Bad Gateway", status: 502, body: {} })));
    assert.equal(first.out.ok, false);
    let row = await attemptRow(attemptId);
    assert.equal((row.engineFallback as EngineFallbackRecord).state, "switched");
    assert.equal(row.error, null, "still rendering");
    const second = await draw(attemptId, () => picture());
    assert.equal(second.out.ok, true, JSON.stringify(second.out));
    assert.deepEqual([...first.calls, ...second.calls].map((c) => c.endpoint), [GPT, NB, NB]);
    row = await attemptRow(attemptId);
    assert.ok(row.generatedImageObjectPath);
    assert.equal(fallbackLineFor(row, "done")?.drawnByEngineId, "nano-banana-2-1-edit", "the tile's line, once the picture is in");
    assert.equal(fallbackLineFor(row, "rendering"), null, "and not before");
  });

  it("a refusal recorded mid-preparation resumes the preparation, never GPT", async () => {
    const attemptId = await plannedAttempt({ moderation: true });
    const row = await attemptRow(attemptId);
    const record: EngineFallbackRecord = {
      state: "preparing", routedEngineId: "gpt-image-2-6-edit", routedRecipeVersionId: null,
      refusedGenerationRequestId: null, refusedVendorRequestId: null, reason: REFUSAL,
      fallbackEngineId: "nano-banana-2-1-edit", fallbackRecipeVersionId: null, resolvedAtHandover: false, at: new Date().toISOString(),
    };
    await db.update(imagePromptAttemptsTable).set({ engineFallback: record }).where(eq(imagePromptAttemptsTable.id, row.id));
    const { out, calls } = await draw(attemptId, () => picture());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(calls.map((c) => c.endpoint), [NB]);
    assert.equal((await attemptRow(attemptId)).actualImageEngineId, "nano-banana-2-1-edit");
  });

  it("a fallback prompt that cannot be built ends the render with its own code, keeping GPT's refusal", async () => {
    const attemptId = await plannedAttempt({ moderation: true });
    // Its frozen gag can no longer be drawn (a cast not read from its scene): the fallback cannot be compiled.
    const frozen = (await attemptRow(attemptId)).factEnrichmentSnapshot as { visualPromptStrategyOverride: Record<string, unknown> };
    await db.update(imagePromptAttemptsTable).set({ factEnrichmentSnapshot: { ...frozen, visualPromptStrategyOverride: { ...frozen.visualPromptStrategyOverride, coreSceneOverride: "{NAME} lifts a different library." } } as never }).where(eq(imagePromptAttemptsTable.id, attemptId));
    const { out, calls } = await draw(attemptId, (e) => (e === GPT ? refusal() : picture()));
    assert.equal((out as { retryable?: boolean }).retryable, false);
    assert.deepEqual(calls.map((c) => c.endpoint), [GPT], "no Nano Banana call");
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, "fallback_compile_failed");
    assert.match(row.error ?? "", /refused this picture under its content policy/);
    assert.equal((row.engineFallback as EngineFallbackRecord).state, "preparing");
    assert.equal(row.actualImageEngineId, "gpt-image-2-6-edit", "not switched");
  });

  it("an attempt queued before fallbacks were frozen resolves its fallback at the handover, and says so", async () => {
    const attemptId = await plannedAttempt({ moderation: true, frozen: false });
    const { out } = await draw(attemptId, (e) => (e === GPT ? refusal() : picture()));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(((await attemptRow(attemptId)).engineFallback as EngineFallbackRecord).resolvedAtHandover, true);
  });

  it("a styled render's content refusal ends the render at once, named, with no fallback (Q17 option 1)", async () => {
    const attemptId = await plannedAttempt({ moderation: true, engine: "nano-banana-2-1-edit" });
    const { out, calls } = await draw(attemptId, () => refusal());
    assert.equal(out.ok, false);
    assert.equal((out as { retryable?: boolean }).retryable, false, "terminal, not retried");
    assert.deepEqual(calls.map((c) => c.endpoint), [NB]);
    const row = await attemptRow(attemptId);
    assert.equal(row.engineFallback, null);
    assert.equal(row.errorCode, "vendor_content_refused");
    assert.match(row.error ?? "", /refused this picture under its content policy/);
    assert.equal(buildRenderStatusPayload(row).status, "failed", "the tile reads failed now, not Drawing…");
  });

  it("a render whose stored input cannot be drawn ends at once, without calling the vendor (Q17 option 1)", async () => {
    // A photo-based render with no reference photo: every retry would fail the same way.
    const missingPhoto = await plannedAttempt({ moderation: true });
    const row0 = await attemptRow(missingPhoto);
    const { referenceImageUrl: _drop, ...noRef } = row0.compiledPrompt as Record<string, unknown>;
    await db.update(imagePromptAttemptsTable).set({ compiledPrompt: noRef }).where(eq(imagePromptAttemptsTable.id, missingPhoto));
    const a = await draw(missingPhoto, () => picture());
    assert.equal((a.out as { retryable?: boolean }).retryable, false, "terminal");
    assert.deepEqual(a.calls, [], "no vendor call");
    const rowA = await attemptRow(missingPhoto);
    assert.equal(rowA.errorCode, "render_input_invalid");
    assert.equal(rowA.error, "i2i_missing_reference_url");
    assert.equal(buildRenderStatusPayload(rowA).status, "failed");

    // An empty stored prompt: the same.
    const noPrompt = await plannedAttempt({ moderation: true });
    await db.update(imagePromptAttemptsTable).set({ compiledPrompt: { referenceImageUrl: "https://example.test/reference.png" } }).where(eq(imagePromptAttemptsTable.id, noPrompt));
    const b = await draw(noPrompt, () => picture());
    assert.equal((b.out as { retryable?: boolean }).retryable, false);
    assert.deepEqual(b.calls, []);
    assert.equal((await attemptRow(noPrompt)).errorCode, "render_input_invalid");
  });

  it("when the queue gives up, the last failure is written to the render; a render with a picture is left alone", async () => {
    const attemptId = await plannedAttempt({ moderation: true });
    await imageGenerationHandler.onAbandon!({ payload: { attemptId }, lastError: "fal submit failed: Bad Gateway" } as never);
    const row = await attemptRow(attemptId);
    assert.equal(row.error, "fal submit failed: Bad Gateway");
    assert.equal(buildRenderStatusPayload(row).status, "failed");
  });

  it("freshness: a fallback alone is current; a newer fallback recipe makes it stale; a GPT picture ignores the fallback's wording", () => {
    const fb = { state: "switched", fallbackRecipeVersionId: null } as never;
    const fellBack = { reviewRenderInputHash: "h", engineFallback: fb } as never;
    const gptDrawn = { reviewRenderInputHash: "h", engineFallback: null } as never;
    assert.equal(isAttemptStale(fellBack, "h", null), false);
    assert.equal(isAttemptStale(fellBack, "h", 7), true);
    assert.equal(isAttemptStale(fellBack, "other", null), true, "content and routing changes keep their effect");
    assert.equal(isAttemptStale(gptDrawn, "h", 7), false);
    assert.equal(isAttemptStale(fellBack, "h"), false, "a caller that read no fallback recipe compares the hash alone");
  });
});
