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
import { fallbackEngineIdFor } from "../lib/imageEngineRouting.js";
import { fallbackLineFor } from "../lib/reviewRenderScenarios.js";
import { isAttemptStale } from "../lib/factRenderScenarios.js";
import { buildRenderStatusPayload } from "../lib/imagePromptAttempts.js";
import { traceIdOrLink } from "../lib/provenance/trace.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";
import { __setUtilityLLMClientForTest } from "../lib/utilityLLM.js";
import { __setRenderFalForTest, type FalHistoryEntry, type RenderFal } from "../lib/renderFalTransport.js";
import { __setRecoveryClockForTest, recoverLostReceipt } from "../lib/renderRequestRecovery.js";
import { defaultIdentityPolicyForRenderMode, IMAGE_PROMPT_GENERATION_VERSION, PROMPT_GENERATION_VERSION_KEY } from "@workspace/api-zod";
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
  renderControls?: Record<string, unknown>;
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
      renderControls: (opts.renderControls ?? {
        aspectRatio: "portrait",
        contentMode: "sfw",
        promptIdentity: { version: 1, name: "David", pronouns: "he/him", source: "review_sample" },
      }) as never,
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
    assert.equal((compiled as Record<string, unknown>)[PROMPT_GENERATION_VERSION_KEY], IMAGE_PROMPT_GENERATION_VERSION,
      "the stored prompt records the generation that compiled it (needs-attention, plan 2C)");

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

describe("image_prompt_generation handler — the image model gets the shortened name (Issue #693)", () => {
  it("a moderation render's sample subject reaches the prompt as its first name only", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({
      snapshot: handlerEnrichment({
        coreSceneOverride: "{NAME} stands in a library surrounded by glowing books.",
        bubbles: [{ type: "speech", entity: "subject", text: "{NAME} did it again!" }],
      }),
      renderControls: {
        aspectRatio: "portrait",
        contentMode: "sfw",
        reviewRenderSubject: { name: "Raena Franklin", pronouns: "she/her" },
      },
    });

    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));

    const compiled = (await attemptRow(attemptId)).compiledPrompt as { imagePrompt: string };
    assert.ok(compiled.imagePrompt.includes('containing exactly the text "Raena did it again!"'), compiled.imagePrompt);
    assert.doesNotMatch(compiled.imagePrompt, /Franklin/);
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

/**
 * A failed render's reason is shown to a moderator as written (Issue #1020):
 * it reads as a sentence, never as a code. A reason may end with technical
 * detail in brackets, for whoever diagnoses it, but it never opens with a
 * snake_case or camelCase identifier.
 */
function assertReadsAsSentence(reason: string | null | undefined) {
  assert.ok(reason, "a reason is recorded");
  const opening = reason.split(/[\s:(]/)[0] ?? "";
  assert.ok(reason.includes(" "), `a sentence, not a single token: ${reason}`);
  assert.ok(!/_|[a-z][A-Z]/.test(opening), `opens with words, not a code: ${reason}`);
}

describe("image_prompt_generation handler — deterministic failures are terminal on the first attempt", () => {
  async function assertTerminal(attemptId: number, code: string) {
    const res = await runHandler(attemptId);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.ok(!res.ok && res.retryable === false, "terminal, not retryable");
    assert.ok(!res.ok && "code" in res && res.code === code, JSON.stringify(res));
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, code);
    assert.ok(row.error, "human-readable error persisted alongside the code");
    assertReadsAsSentence(row.error);
    assert.equal(await generationJob(attemptId), undefined, "no image_generation job enqueued");
  }

  it("a corrupt frozen gag → invalid_persisted_enrichment (the classification beside it is not read)", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({ snapshot: { primaryArchetype: "nope", visualPromptStrategyOverride: { version: 99 } } });
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

  /**
   * Run the image job with fal answering per endpoint; returns the result and
   * the endpoints submitted to. The render's transport is a submit followed by
   * status and result reads (plan PLAN_JOB_RESUME.md §C). A content refusal, as
   * at fal, surfaces when the result is read; any other error fails the submit.
   */
  async function draw(attemptId: number, answer: (endpoint: string, n: number) => unknown) {
    const calls: Array<{ endpoint: string; input: Record<string, unknown> }> = [];
    const answers = new Map<string, unknown>();
    __setRenderFalForTest({
      async submit(endpoint, input) {
        calls.push({ endpoint, input });
        const a = answer(endpoint, calls.filter((c) => c.endpoint === endpoint).length);
        // A gateway error is fal refusing the submission itself; a content refusal comes with the result.
        if (a instanceof Error && (a as { status?: number }).status !== 422) throw a;
        const id = `req-${randomUUID()}`;
        answers.set(id, a);
        return id;
      },
      async status() { return "COMPLETED"; },
      async result(_endpoint, requestId) {
        const a = answers.get(requestId);
        if (a instanceof Error) throw a;
        return (a as { data?: unknown }).data ?? a;
      },
      async history() { throw new Error("no history in this test"); },
    });
    const priorKey = process.env["FAL_AI_API_KEY"];
    process.env["FAL_AI_API_KEY"] = priorKey ?? "test-fal-key";
    try {
      const out = await imageGenerationHandler.run({ attemptId }, {} as never);
      return { out, calls };
    } finally {
      __setRenderFalForTest(null);
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
    // The stored prompt records an older generation: the fallback's recompile
    // must record the one that compiled it, not keep the stored one (PR #1181).
    const [{ stored }] = await db.select({ stored: imagePromptAttemptsTable.compiledPrompt }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attemptId));
    await db.update(imagePromptAttemptsTable)
      .set({ compiledPrompt: { ...((stored ?? {}) as Record<string, unknown>), [PROMPT_GENERATION_VERSION_KEY]: "v0-older" } })
      .where(eq(imagePromptAttemptsTable.id, attemptId));
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
    assert.equal((after.compiledPrompt as Record<string, unknown>)[PROMPT_GENERATION_VERSION_KEY], IMAGE_PROMPT_GENERATION_VERSION,
      "the recompiled prompt records the generation that compiled it (needs-attention, plan 2C)");
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
    assert.equal(rowA.error, "this picture is drawn from a reference photo, but none was saved with the render");
    assertReadsAsSentence(rowA.error);
    assert.equal(buildRenderStatusPayload(rowA).status, "failed");

    // An empty stored prompt: the same.
    const noPrompt = await plannedAttempt({ moderation: true });
    await db.update(imagePromptAttemptsTable).set({ compiledPrompt: { referenceImageUrl: "https://example.test/reference.png" } }).where(eq(imagePromptAttemptsTable.id, noPrompt));
    const b = await draw(noPrompt, () => picture());
    assert.equal((b.out as { retryable?: boolean }).retryable, false);
    assert.deepEqual(b.calls, []);
    const rowB = await attemptRow(noPrompt);
    assert.equal(rowB.errorCode, "render_input_invalid");
    assertReadsAsSentence(rowB.error);
  });

  // Issue #1020: the permanent rejections that still read "Drawing…" for ~10½ hours.
  it("fal rejecting the request itself (not on content grounds) ends the render at once, with fal's reason", async () => {
    // A malformed request, answered with the result (fal's validation 422, no content_policy_violation).
    const malformed = await plannedAttempt({ moderation: true });
    const invalid = new ValidationError({ message: "Unprocessable Entity", status: 422, body: { detail: [{ loc: ["body", "image_size"], msg: "Input should be a valid enumeration member", type: "enum" }] } });
    const a = await draw(malformed, () => invalid);
    assert.equal((a.out as { retryable?: boolean }).retryable, false, "terminal, not retried");
    assert.deepEqual(a.calls.map((c) => c.endpoint), [GPT], "one call; a rejection is not a refusal, so no fallback");
    const rowA = await attemptRow(malformed);
    assert.equal(rowA.errorCode, "vendor_request_rejected");
    assert.equal(rowA.engineFallback, null);
    assert.match(rowA.error ?? "", /rejected the request for this picture, which will not change on a retry \(HTTP 422: Input should be a valid enumeration member\)/);
    assertReadsAsSentence(rowA.error);
    assert.equal(buildRenderStatusPayload(rowA).status, "failed", "the tile reads failed now, not Drawing…");

    // A reference photo fal can no longer fetch (its stored link has expired), refused at submission.
    const expired = await plannedAttempt({ moderation: true });
    const gone = new ApiError({ message: "Bad Request", status: 400, body: { detail: "Failed to download the file. Please check if the URL is accessible." } });
    const b = await draw(expired, () => gone);
    assert.equal((b.out as { retryable?: boolean }).retryable, false);
    const rowB = await attemptRow(expired);
    assert.equal(rowB.errorCode, "vendor_request_rejected");
    assert.match(rowB.error ?? "", /HTTP 400: Failed to download the file/);
  });

  it("a rejection a retry can clear still retries: our key or account (401/403), rate limits, and a request fal no longer knows", async () => {
    for (const status of [401, 403, 429]) {
      const attemptId = await plannedAttempt({ moderation: true });
      const { out } = await draw(attemptId, () => new ApiError({ message: `HTTP ${status}`, status, body: {} }));
      assert.notEqual((out as { retryable?: boolean }).retryable, false, `${status} is retried`);
      assert.equal((await attemptRow(attemptId)).error, null, `${status}: still rendering`);
    }
    // A status read answered 404: our request is unknown or gone, which a new
    // submission can fix, so this is never the request's own rejection.
    const attemptId = await plannedAttempt({ moderation: true });
    __setRenderFalForTest({
      async submit() { return `req-${randomUUID()}`; },
      async status() { throw new ApiError({ message: "Not Found", status: 404, body: { detail: "Request not found" } }); },
      async result() { throw new Error("not reached"); },
      async history() { throw new Error("no history in this test"); },
    });
    const priorKey = process.env["FAL_AI_API_KEY"];
    process.env["FAL_AI_API_KEY"] = priorKey ?? "test-fal-key";
    try {
      const out = await imageGenerationHandler.run({ attemptId }, {} as never);
      assert.notEqual((out as { retryable?: boolean }).retryable, false, "a lost request is retried");
      assert.equal((await attemptRow(attemptId)).error, null);
    } finally {
      __setRenderFalForTest(null);
      if (priorKey === undefined) delete process.env["FAL_AI_API_KEY"];
      else process.env["FAL_AI_API_KEY"] = priorKey;
    }
  });

  it("a render with no compiled prompt at all ends at once, without calling the vendor", async () => {
    const attemptId = await plannedAttempt({ moderation: true });
    await db.update(imagePromptAttemptsTable).set({ compiledPrompt: null }).where(eq(imagePromptAttemptsTable.id, attemptId));
    const { out, calls } = await draw(attemptId, () => picture());
    assert.equal((out as { retryable?: boolean }).retryable, false, "terminal");
    assert.deepEqual(calls, []);
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, "render_input_invalid");
    assert.match(row.error ?? "", /no compiled prompt/);
    assert.equal(buildRenderStatusPayload(row).status, "failed");
  });

  // PR #1004's other two fail-at-once paths (Issue #1020, housekeeping).
  it("an engine that cannot draw this kind of render ends it at once, without calling the vendor", async () => {
    // A text-only engine recorded on a photo-based render: routing refuses it on every retry.
    const attemptId = await plannedAttempt({ moderation: true, engine: "gpt-image-2-6" });
    const { out, calls } = await draw(attemptId, () => picture());
    assert.equal((out as { retryable?: boolean }).retryable, false, "terminal");
    assert.deepEqual(calls, [], "no vendor call");
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, "render_input_invalid");
    assert.match(row.error ?? "", /cannot draw a picture from a reference photo: it draws pictures from a written description instead/);
    assert.doesNotMatch(row.error ?? "", /\b[it]2i\b/, "the reason a moderator reads uses words, never i2i or t2i (Issue #1020)");
    assert.equal(buildRenderStatusPayload(row).status, "failed");
  });

  it("a stored picture shape the engine offers no size for ends the render at once, in words (Issue #1020)", async () => {
    const attemptId = await plannedAttempt({ moderation: true, engine: "nano-banana-2-1-edit" });
    const row0 = await attemptRow(attemptId);
    await db.update(imagePromptAttemptsTable)
      .set({ renderControls: { ...(row0.renderControls as Record<string, unknown>), aspectRatio: "panorama" } as never })
      .where(eq(imagePromptAttemptsTable.id, attemptId));
    const { out, calls } = await draw(attemptId, () => picture());
    assert.equal((out as { retryable?: boolean }).retryable, false, "terminal, not retried for hours");
    assert.deepEqual(calls, [], "no vendor call");
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, "render_input_invalid");
    assert.match(row.error ?? "", /the picture cannot be requested from the image engine "nano-banana-2-1-edit": its shape "panorama" is not landscape, square or portrait/);
    assert.equal(buildRenderStatusPayload(row).status, "failed");
  });

  it("a request that cannot be built from the stored render ends it at once, without calling the vendor", async () => {
    // A prompt of spaces passes the empty-prompt check but leaves the engine's required prompt empty.
    const attemptId = await plannedAttempt({ moderation: true });
    const row0 = await attemptRow(attemptId);
    await db.update(imagePromptAttemptsTable)
      .set({ compiledPrompt: { ...(row0.compiledPrompt as Record<string, unknown>), imagePrompt: "   ", prompt: "   " } })
      .where(eq(imagePromptAttemptsTable.id, attemptId));
    const { out, calls } = await draw(attemptId, () => picture());
    assert.equal((out as { retryable?: boolean }).retryable, false, "terminal");
    assert.deepEqual(calls, [], "no vendor call");
    const row = await attemptRow(attemptId);
    assert.equal(row.errorCode, "render_input_invalid");
    assert.match(row.error ?? "", /could not be built from this render/);
    assertReadsAsSentence(row.error);
    assert.equal(buildRenderStatusPayload(row).status, "failed");
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

// ─── A resumed render collects, never re-pays (plan PLAN_JOB_RESUME.md §C, Issue #1000) ───

describe("image_generation — a resumed render collects what was already paid for (plan PLAN_JOB_RESUME.md §C)", () => {
  const photos = photoBackgrounds();
  const NB = "google/nano-banana-2.1/edit";
  let png: Buffer;
  const factIdsHere: number[] = [];

  before(async () => {
    photos.setUp();
    png = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#654" } }).png().toBuffer();
    // The waits (the lost-receipt horizon, status polling) take no real time here.
    __setRecoveryClockForTest({ sleep: async () => {} });
  });
  after(async () => {
    __setRecoveryClockForTest(null);
    if (factIdsHere.length) {
      await db.delete(imageProvenanceTable).where(inArray(imageProvenanceTable.factId, factIdsHere));
      await db.delete(imageGenerationRequestsTable).where(inArray(imageGenerationRequestsTable.factId, factIdsHere));
    }
    await photos.tearDown();
  });

  const pictureData = () => ({ images: [{ url: `data:image/png;base64,${png.toString("base64")}` }] });

  /** A compiled attempt on the styled engine (no fallback), as a moderation render. */
  async function planned(): Promise<{ attemptId: number; factId: number }> {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({ snapshot: handlerEnrichment({ coreSceneOverride: "{NAME} lifts a library." }) });
    const row = await attemptRow(attemptId);
    factIdsHere.push(row.factId);
    await db.update(imagePromptAttemptsTable).set({
      actualImageEngineId: "nano-banana-2-1-edit",
      renderControls: { ...(row.renderControls as Record<string, unknown>), referenceImageUrl: "https://example.test/reference.png", mirrorToLegacyStorage: false } as never,
    }).where(eq(imagePromptAttemptsTable.id, attemptId));
    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));
    return { attemptId, factId: row.factId };
  }

  /** A fake fal: each request has a status script and an answer; every submit is counted. */
  function fakeFal(opts: { history?: () => Promise<FalHistoryEntry[]> } = {}) {
    const requests = new Map<string, { statuses: string[]; answer: unknown }>();
    const submits: string[] = [];
    const transport: RenderFal = {
      async submit(endpoint) {
        submits.push(endpoint);
        const id = `new-${randomUUID()}`;
        requests.set(id, { statuses: ["IN_PROGRESS", "COMPLETED"], answer: pictureData() });
        return id;
      },
      async status(_endpoint, id) {
        const r = requests.get(id);
        if (!r) throw new ApiError({ message: "Not Found", status: 404, body: {} });
        return r.statuses.length > 1 ? r.statuses.shift()! : r.statuses[0]!;
      },
      async result(_endpoint, id) {
        const r = requests.get(id)!;
        if (r.answer instanceof Error) throw r.answer;
        return r.answer;
      },
      async history() {
        if (opts.history) return opts.history();
        throw new Error("history unavailable in this test");
      },
    };
    return { transport, requests, submits };
  }

  async function run(attemptId: number, fake: ReturnType<typeof fakeFal>) {
    __setRenderFalForTest(fake.transport);
    const priorKey = process.env["FAL_AI_API_KEY"];
    process.env["FAL_AI_API_KEY"] = priorKey ?? "test-fal-key";
    try {
      return await imageGenerationHandler.run({ attemptId }, {} as never);
    } finally {
      __setRenderFalForTest(null);
      if (priorKey === undefined) delete process.env["FAL_AI_API_KEY"];
      else process.env["FAL_AI_API_KEY"] = priorKey;
    }
  }

  /** A request row an earlier run recorded for this attempt. */
  async function earlierRequest(attemptId: number, factId: number, over: {
    vendorRequestId?: string | null; vendorStatus?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "LOST" | null;
    request?: Record<string, unknown>; minutesAgo?: number;
  } = {}) {
    const [row] = await db.insert(imageGenerationRequestsTable).values({
      producer: "review_render", engineId: "nano-banana-2-1-edit", endpointId: NB,
      request: over.request ?? { prompt: `earlier ${randomUUID()}` },
      vendorRequestId: over.vendorRequestId ?? null, vendorStatus: over.vendorStatus ?? null,
      attemptId, factId, actorKind: "system",
      createdAt: new Date(Date.now() - (over.minutesAgo ?? 10) * 60_000),
    }).returning();
    return row!;
  }

  async function requestRow(id: number) {
    const [row] = await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.id, id));
    return row!;
  }

  it("the request id is on record and fal is still drawing it: the run collects it, with no new submit", async () => {
    const { attemptId, factId } = await planned();
    const fake = fakeFal();
    const prior = await earlierRequest(attemptId, factId, { vendorRequestId: "v-running", vendorStatus: "IN_PROGRESS" });
    fake.requests.set("v-running", { statuses: ["IN_PROGRESS", "IN_PROGRESS", "COMPLETED"], answer: pictureData() });
    const out = await run(attemptId, fake);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(fake.submits, [], "nothing new is paid for");
    assert.ok((await attemptRow(attemptId)).generatedImageObjectPath);
    assert.equal((await requestRow(prior.id)).vendorStatus, "COMPLETED");
  });

  it("the request had completed: the run stores it, with no new submit", async () => {
    const { attemptId, factId } = await planned();
    const fake = fakeFal();
    await earlierRequest(attemptId, factId, { vendorRequestId: "v-done", vendorStatus: "COMPLETED" });
    fake.requests.set("v-done", { statuses: ["COMPLETED"], answer: pictureData() });
    const out = await run(attemptId, fake);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(fake.submits, []);
    assert.ok((await attemptRow(attemptId)).generatedImageObjectPath);
  });

  it("the earlier request failed: it is marked failed, the existing retry applies, and the retry submits once", async () => {
    const { attemptId, factId } = await planned();
    const fake = fakeFal();
    const prior = await earlierRequest(attemptId, factId, { vendorRequestId: "v-bad", vendorStatus: "IN_PROGRESS" });
    // A failure a retry can clear (a 400 or 422 would be the request's own
    // permanent rejection, which ends the render instead: Issue #1020).
    fake.requests.set("v-bad", { statuses: ["COMPLETED"], answer: new ApiError({ message: "Service Unavailable", status: 503, body: {} }) });
    const first = await run(attemptId, fake);
    assert.equal(first.ok, false);
    assert.notEqual((first as { retryable?: boolean }).retryable, false, "the queue retries it, as before");
    assert.equal((await requestRow(prior.id)).vendorStatus, "FAILED", "a known failure is never collected again");
    const second = await run(attemptId, fake);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(fake.submits.length, 1, "one new submit in total");
  });

  for (const status of [500, 504]) {
    it(`fal finished the request with a model ${status}: the row is marked failed and the retry draws anew, once (PR #1017 round 2)`, async () => {
      const { attemptId, factId } = await planned();
      const fake = fakeFal();
      const prior = await earlierRequest(attemptId, factId, { vendorRequestId: `v-model-${status}`, vendorStatus: "IN_PROGRESS" });
      fake.requests.set(`v-model-${status}`, { statuses: ["COMPLETED"], answer: new ApiError({ message: "model error", status, body: { detail: "internal_server_error" } }) });
      const first = await run(attemptId, fake);
      assert.equal(first.ok, false);
      assert.notEqual((first as { retryable?: boolean }).retryable, false, "the existing retry applies");
      assert.equal((await requestRow(prior.id)).vendorStatus, "FAILED", "a finished failure is never collected again");
      assert.deepEqual(fake.submits, []);
      const second = await run(attemptId, fake);
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(fake.submits.length, 1, "exactly one new draw");
    });
  }

  it("a fresh request fal finishes with no picture is failed, and the retry draws anew, once (PR #1017 round 3)", async () => {
    const { attemptId } = await planned();
    const fake = fakeFal();
    let firstSubmit = true;
    const submitOf = fake.transport.submit.bind(fake.transport);
    fake.transport.submit = async (endpoint, input, signal) => {
      const id = await submitOf(endpoint, input, signal);
      if (firstSubmit) {
        firstSubmit = false;
        fake.requests.set(id, { statuses: ["COMPLETED"], answer: { images: [] } });
      }
      return id;
    };
    const first = await run(attemptId, fake);
    assert.equal(first.ok, false);
    assert.notEqual((first as { retryable?: boolean }).retryable, false, "the existing retry applies");
    assert.match((first as { error: string }).error, /missing image url/);
    const [row] = await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.attemptId, attemptId));
    assert.equal(row!.vendorStatus, "FAILED", "an empty answer is never collected again");
    const second = await run(attemptId, fake);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(fake.submits.length, 2, "two submissions in total, as before");
  });

  it("a recorded request that finished with no picture: no submit on that run, failed, then exactly one submit on the next", async () => {
    const { attemptId, factId } = await planned();
    const fake = fakeFal();
    const prior = await earlierRequest(attemptId, factId, { vendorRequestId: "v-empty", vendorStatus: "IN_PROGRESS" });
    fake.requests.set("v-empty", { statuses: ["COMPLETED"], answer: { images: [] } });
    const first = await run(attemptId, fake);
    assert.equal(first.ok, false);
    assert.deepEqual(fake.submits, []);
    assert.equal((await requestRow(prior.id)).vendorStatus, "FAILED");
    const second = await run(attemptId, fake);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(fake.submits.length, 1);
  });

  it("a result read that got no HTTP answer leaves the request open, and the retry collects it with no new submit", async () => {
    const { attemptId, factId } = await planned();
    const fake = fakeFal();
    const prior = await earlierRequest(attemptId, factId, { vendorRequestId: "v-flaky", vendorStatus: "IN_PROGRESS" });
    let reads = 0;
    fake.requests.set("v-flaky", { statuses: ["COMPLETED"], answer: pictureData() });
    const resultOf = fake.transport.result.bind(fake.transport);
    fake.transport.result = async (endpoint, id) => {
      if (id === "v-flaky" && ++reads === 1) throw new TypeError("fetch failed");
      return resultOf(endpoint, id);
    };
    const first = await run(attemptId, fake);
    assert.equal(first.ok, false);
    assert.notEqual((await requestRow(prior.id)).vendorStatus, "FAILED", "nothing was learned, so nothing is closed");
    const second = await run(attemptId, fake);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(fake.submits, [], "collected, never paid again");
  });

  it("a status word fal does not document is not taken as a failure: the request stays open", async () => {
    const { attemptId, factId } = await planned();
    const fake = fakeFal();
    const prior = await earlierRequest(attemptId, factId, { vendorRequestId: "v-odd", vendorStatus: "IN_PROGRESS" });
    fake.requests.set("v-odd", { statuses: ["CANCELLING"], answer: new ApiError({ message: "Bad Request", status: 400, body: {} }) });
    const out = await run(attemptId, fake);
    assert.equal(out.ok, false);
    assert.notEqual((await requestRow(prior.id)).vendorStatus, "FAILED");
    assert.deepEqual(fake.submits, []);
  });

  it("the receipt was lost and fal's history holds exactly one unclaimed match: it is collected", async () => {
    const { attemptId, factId } = await planned();
    const input = { prompt: `lost ${randomUUID()}` };
    const fake = fakeFal({ history: async () => [{ requestId: "v-found", input }, { requestId: "v-other", input: { prompt: "someone else" } }] });
    fake.requests.set("v-found", { statuses: ["COMPLETED"], answer: pictureData() });
    const prior = await earlierRequest(attemptId, factId, { request: input });
    const out = await run(attemptId, fake);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(fake.submits, []);
    const row = await requestRow(prior.id);
    assert.equal(row.vendorRequestId, "v-found");
    assert.equal(row.vendorStatus, "COMPLETED");
  });

  for (const [name, history] of [
    ["two identical matches", async () => [{ requestId: "v-a", input: { prompt: "PLACEHOLDER" } }, { requestId: "v-b", input: { prompt: "PLACEHOLDER" } }]],
    ["a history lookup that fails", async () => { throw new Error("fal history returned 500"); }],
    ["no match at all", async () => []],
  ] as const) {
    it(`the receipt was lost and the history gives ${name}: ambiguous, so it is drawn again (Q13: 1), once`, async () => {
      const { attemptId, factId } = await planned();
      const input = { prompt: `ambiguous ${randomUUID()}` };
      const fake = fakeFal({
        history: async () => (await history()).map((e) => ({ ...e, input })),
      });
      const prior = await earlierRequest(attemptId, factId, { request: input });
      const out = await run(attemptId, fake);
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(fake.submits.length, 1, "drawn again once");
      const row = await requestRow(prior.id);
      assert.equal(row.vendorStatus, "LOST");
      assert.equal(row.vendorRequestId, null, "nothing collected");
    });
  }

  it("the history's match is already held by another request of ours: ambiguous, never attached twice", async () => {
    const { attemptId, factId } = await planned();
    const other = await planned();
    const input = { prompt: `held ${randomUUID()}` };
    await earlierRequest(other.attemptId, other.factId, { vendorRequestId: `v-held-${attemptId}`, vendorStatus: "COMPLETED", request: input });
    let historyRead = false;
    const fake = fakeFal({ history: async () => { historyRead = true; return [{ requestId: `v-held-${attemptId}`, input }]; } });
    const prior = await earlierRequest(attemptId, factId, { request: input });
    __setRenderFalForTest(fake.transport);
    try {
      assert.equal(await recoverLostReceipt(prior), null);
    } finally {
      __setRenderFalForTest(null);
    }
    assert.ok(historyRead, "decided after reading the history, by the match being held");
    const row = await requestRow(prior.id);
    assert.equal(row.vendorStatus, "LOST");
    assert.equal(row.vendorRequestId, null);
  });

  it("two of our receipt-less requests with the same input and one history match: ambiguous for both, recovered one after the other or together", async () => {
    const a = await planned();
    const b = await planned();
    const input = { prompt: `twin ${randomUUID()}` };
    const earlier = await earlierRequest(a.attemptId, a.factId, { request: input, minutesAgo: 12 });
    const later = await earlierRequest(b.attemptId, b.factId, { request: input, minutesAgo: 8 });
    __setRenderFalForTest(fakeFal({ history: async () => [{ requestId: "v-twin", input }] }).transport);
    try {
      assert.equal(await recoverLostReceipt(later), null, "the later-recorded one first");
      // Both again, together, from their rows as a fresh run would read them.
      const [ra, rb] = await Promise.all([recoverLostReceipt(await requestRow(earlier.id)), recoverLostReceipt(await requestRow(later.id))]);
      assert.equal(ra, null);
      assert.equal(rb, null);
    } finally {
      __setRenderFalForTest(null);
    }
    assert.equal((await requestRow(earlier.id)).vendorRequestId, null, "nothing collected");
    assert.equal((await requestRow(later.id)).vendorRequestId, null);
  });

  it("the picture is already stored: the run finishes with no submit", async () => {
    const { attemptId } = await planned();
    await db.update(imagePromptAttemptsTable).set({ generatedImageObjectPath: "/objects/already-there.png" }).where(eq(imagePromptAttemptsTable.id, attemptId));
    const fake = fakeFal();
    const out = await run(attemptId, fake);
    assert.equal(out.ok, true);
    assert.deepEqual(fake.submits, []);
  });

  it("a fresh render stores fal's receipt the moment it is accepted, before the picture is ready", async () => {
    const { attemptId } = await planned();
    const fake = fakeFal();
    let seenWhileDrawing: { vendorRequestId: string | null; vendorStatus: string | null } | null = null;
    const statusOf = fake.transport.status.bind(fake.transport);
    fake.transport.status = async (endpoint, id) => {
      if (!seenWhileDrawing) {
        const [row] = await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.attemptId, attemptId));
        seenWhileDrawing = { vendorRequestId: row!.vendorRequestId, vendorStatus: row!.vendorStatus };
      }
      return statusOf(endpoint, id);
    };
    const out = await run(attemptId, fake);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fake.submits.length, 1);
    assert.match(seenWhileDrawing!.vendorRequestId ?? "", /^new-/, "the receipt was on record before the first status read");
    assert.equal(seenWhileDrawing!.vendorStatus, "IN_QUEUE");
  });
});

describe("image_prompt_generation — a resumed run reuses the prompt it saved (plan PLAN_JOB_RESUME.md §F)", () => {
  it("never compiles again; the missing image job is created, and only once", async () => {
    installLlmCounter();
    const attemptId = await seedHandlerAttempt({ snapshot: handlerEnrichment({ coreSceneOverride: "{NAME} lifts a library." }) });
    const first = await runHandler(attemptId);
    assert.equal(first.ok, true, JSON.stringify(first));
    const saved = (await attemptRow(attemptId)).compiledPrompt;
    // The run stopped after the prompt was saved; its image job is gone.
    await db.delete(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
    const again = await runHandler(attemptId);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(again.ok && again.result, { attemptId, reusedSavedPrompt: true }, "the saved prompt was reused");
    assert.deepEqual((await attemptRow(attemptId)).compiledPrompt, saved, "the saved prompt is unchanged");
    assert.ok(await generationJob(attemptId), "the missing image job was created");
    assert.equal((await runHandler(attemptId)).ok, true);
    const jobs = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
    assert.equal(jobs.length, 1, "deduped against the one in flight");
    assert.equal(llmCalls, 0, "no model call at any step");
    await db.delete(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
  });
});
