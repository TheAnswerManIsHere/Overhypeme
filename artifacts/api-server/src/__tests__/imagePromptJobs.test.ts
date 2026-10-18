/**
 * Regression lock for the subject_fact_compatibility_poor block removal.
 *
 * The invariant under test: subjectFactCompatibility is advisory only and NEVER
 * gates whether image_generation is enqueued — a "poor" (or "risky") rating must
 * still persist the advisory rating, leave `error` NULL, and chain the SAME
 * image_generation job (queue + dedupe key) as any other successful attempt.
 *
 * This is deterministic proof of the removed gate: a live Replit render can't
 * prove it because the planner runs at nonzero temperature and may not redraw
 * "poor" on a rerun.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, imagePromptAttemptsTable, asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import {
  persistImagePromptPlanAndEnqueueGeneration,
  imagePromptGenerationHandler,
  IMAGE_GENERATION_QUEUE,
} from "../lib/imagePromptJobs.js";
import { __setUtilityLLMClientForTest } from "../lib/utilityLLM.js";
import { defaultIdentityPolicyForRenderMode } from "@workspace/api-zod";

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
    captchaVerified: true,
  });
});

after(async () => {
  __setUtilityLLMClientForTest(null);
  await cleanup();
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("persistImagePromptPlanAndEnqueueGeneration — compatibility rating never blocks", () => {
  for (const rating of ["poor", "risky"] as const) {
    it(`${rating}: persists the advisory rating, leaves error NULL, and enqueues image_generation`, async () => {
      const attemptId = await seedAttempt();
      const compatibility = { rating, reason: "test", recommendedFallback: "none" };

      await persistImagePromptPlanAndEnqueueGeneration({
        attemptId,
        visualPlan: { coreScene: "test scene" } as never,
        compiledPrompt: { prompt: "test prompt", imagePrompt: "test prompt" } as never,
        subjectFactCompatibility: compatibility,
        archetypeStrategyVersion: "v2",
      });

      const [row] = await db
        .select()
        .from(imagePromptAttemptsTable)
        .where(eq(imagePromptAttemptsTable.id, attemptId));
      assert.equal(row!.error, null);
      assert.deepEqual(row!.subjectFactCompatibility, compatibility);

      const [job] = await db
        .select()
        .from(asyncJobsTable)
        .where(eq(asyncJobsTable.dedupeKey, `image_generation:attempt:${attemptId}`));
      assert.ok(job, "expected an image_generation job to be enqueued");
      assert.equal(job!.queue, IMAGE_GENERATION_QUEUE);
      assert.equal((job!.payload as { attemptId: number }).attemptId, attemptId);
      assert.equal(job!.status, "pending");
    });
  }
});

// ── image_prompt_generation handler: Concept warnings + deterministic terminal failures ──
//
// Drives the real handler on a seeded attempt. The only double is the OpenAI
// client behind callUtilityLLM (via its test seam), returning a valid planner
// plan; the real planner validation and Nano Banana 2 compiler still run.

const PLAN = {
  visualPlan: {
    sceneConcept: "David stares at books until they surrender their knowledge",
    visualGoal: "Convey awe-inspiring presence",
    visualApproach: "Cinematic close-up",
    archetypeApplication: {
      primaryArchetype: "presence_induced_reaction_aura",
      subtype: "awe_deference",
      selectedFrame: "direct_action",
      strategyRationale: "Presence causes objects to react.",
    },
    coreScene: "David stands in a library, books glowing around him as he stares them down.",
    subjectDetails: ["intense focused gaze", "calm commanding posture"],
    environment: ["library shelves towering overhead", "soft glow from books"],
    lightingAndStyle: "dramatic chiaroscuro lighting",
    keyVisualElements: ["David central", "glowing books", "library setting", "dramatic lighting", "subtle shimmer"],
    subjectTreatment: {
      roleInScene: "Legendary protagonist",
      subjectRenderMode: "human_identity_i2i",
      identityPreservation: "human_face",
      nonhumanSubjectTreatment: {
        applicable: false, subjectKind: "not_applicable", preserveTraits: [],
        anthropomorphicTreatment: "none", doNotTransformIntoHuman: false,
      },
      fallbackSubjectGender: "not_applicable",
      expressionAndPose: "Confident, intense, unfazed",
      ageLifeStageTransform: { applies: false, targetState: "" },
    },
    subjectFactCompatibility: { rating: "strong", reason: "Human protagonist works well.", recommendedFallback: "none" },
    composition: {
      subjectFraming: "Medium close-up", negativeSpace: "top", cameraStyle: "Cinematic 35mm",
      sceneReadability: "Glowing books and intense gaze readable at a glance",
    },
    supportingTextPolicy: {
      allowSupportingText: false, supportingTextElements: [],
      forbiddenTextTypes: [
        "full meme captions", "full fact text", "hashtags", "watermarks", "real logos", "brand marks",
        "long explanatory paragraphs",
      ],
    },
    secondaryCharacters: [],
    semanticEntitiesUsed: [],
    culturalReferencesUsed: [],
    contentNotes: "SFW",
    debugNotes: "",
    targetEngine: "nano_banana_2",
    generationMode: "i2i",
  },
  compiledPrompt: {
    prompt:
      "Image-to-image edit using the reference image as the person's facial identity source. Preserve the reference person's recognizable face. David stands in a library surrounded by glowing books, staring them down with an intense gaze.",
    negativePrompt: "",
    engineNotes: "",
  },
};

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
    ...(override
      ? {
          visualPromptStrategyOverride: {
            version: 1,
            requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
            compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
            bubbles: [],
            ...override,
          },
        }
      : {}),
  } as unknown as FactEnrichment;
}

let llmCalls = 0;
function installPlannerDouble(): void {
  llmCalls = 0;
  __setUtilityLLMClientForTest({
    chat: {
      completions: {
        create: async () => {
          llmCalls++;
          return { choices: [{ message: { content: JSON.stringify(PLAN) } }] };
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
    installPlannerDouble();
    const attemptId = await seedHandlerAttempt({
      snapshot: handlerEnrichment({
        coreSceneOverride: "{NAME} rides a T-Rex through the office. Ensure {NAME}'s recognizable face is preserved.",
      }),
    });

    const res = await runHandler(attemptId);
    assert.equal(res.ok, true, JSON.stringify(res));

    const row = await attemptRow(attemptId);
    assert.equal(row.error, null);
    assert.equal(row.errorCode, null);
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
    installPlannerDouble();
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

  it("a corrupt frozen enrichment → invalid_persisted_enrichment, before any planner call", async () => {
    installPlannerDouble();
    const attemptId = await seedHandlerAttempt({ snapshot: { primaryArchetype: "nope" } });
    await assertTerminal(attemptId, "invalid_persisted_enrichment");
    assert.equal(llmCalls, 0, "planner never called");
  });

  it("a leaked {NAME} token in the frozen fact text → rendered_fact_unresolved_token, before any planner call", async () => {
    installPlannerDouble();
    const attemptId = await seedHandlerAttempt({
      snapshot: handlerEnrichment(),
      renderedFactText: "{NAME} doesn't read books.",
    });
    await assertTerminal(attemptId, "rendered_fact_unresolved_token");
    assert.equal(llmCalls, 0, "planner never called");
  });

  it("required content over the engine budget → required_budget_overflow", async () => {
    installPlannerDouble();
    // 40 (the schema maximum) very long required details cannot fit the prompt budget.
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
    await assertTerminal(attemptId, "required_budget_overflow");
  });
});
