/**
 * Integration tests for POST /admin/image-prompt/preview (Phase 2C — Runtime
 * Compiled Prompt Preview).
 *
 * Mounts adminImagePromptRouter behind buildTestApp() stub auth so requireAdmin
 * runs end-to-end. The route statically imports the live (OpenAI-backed)
 * generateImagePromptPlan; we stub it via __setPlanGeneratorForTest so NO test
 * hits OpenAI. The real Nano Banana compiler still runs on the stubbed plan.
 *
 * Touches the real test DB. Seeds facts under id range / userIds under the
 * `t-ipp-` prefix; cleanup deletes only those rows.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, lookStylesTable } from "@workspace/db/schema";
import type { FactEnrichment } from "@workspace/api-zod";
import { eq, inArray, like } from "drizzle-orm";

import adminImagePromptRouter, { __setPlanGeneratorForTest } from "../routes/adminImagePrompt.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const USER_PREFIX = "t-ipp-u-";
const STYLE_PREFIX = "t-ipp-style-";
const FACT_TEXT_PREFIX = "t-ipp-fact-";

const insertedUserIds: string[] = [];
const insertedFactIds: number[] = [];
const insertedStyleIds: string[] = [];

let adminUserId: string;
let plainUserId: string;

// ── Fixtures ──────────────────────────────────────────────────────────────

const SHARK_WEEK_CULTURAL_REF = {
  sourcePhrase: "Shark Week",
  referenceType: "cultural_reference" as const,
  canonicalReference: "Discovery Channel's Shark Week",
  explanation: "Annual week of shark programming.",
  visualImplication: "Sharks, ocean, documentary framing.",
  confidence: 0.95,
  requiresAdminReview: false,
};

const EARTH_ENTITY = {
  surfaceText: "Earth",
  normalizedText: "earth",
  entityKind: "celestial_body" as const,
  visualReferent: "the planet Earth",
  capitalizationSignal: "capitalized_named_entity" as const,
  materiallyAffectsVisualPrompt: true,
  requiresAdminReview: false,
  confidence: 0.95,
  notes: "Capitalized Earth → the planet, not soil.",
};

const VALID_ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["clear_causal_relationship", "single_subject_focus"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "pushups", "earth", "legendary"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [SHARK_WEEK_CULTURAL_REF],
  semanticEntities: [EARTH_ENTITY],
};

// A full ImagePromptGenerationOutput the stubbed generator returns. The route
// feeds output.visualPlan/compiledPrompt into the real Nano Banana compiler.
function makeOutput(overrides: {
  subjectRenderMode?: "human_identity_i2i" | "nonhuman_subject_i2i" | "t2i_fallback";
  promptText?: string;
  semanticEntitiesUsed?: Array<{ surfaceText: string; visualReferentUsed: string; effectOnVisualPlan: string }>;
  culturalReferencesUsed?: Array<{ sourcePhrase: string; canonicalReferenceUsed: string; visualImplicationUsed: string; effectOnVisualPlan: string }>;
  keyVisualElements?: string[];
  secondaryCharacters?: Array<{ label: string; visualRole: string }>;
} = {}) {
  const mode = overrides.subjectRenderMode ?? "human_identity_i2i";
  const generationMode = mode === "t2i_fallback" ? ("t2i" as const) : ("i2i" as const);
  return {
    visualPlan: {
      sceneConcept: "David performing a superhuman feat",
      visualGoal: "Make the feat legible",
      visualApproach: "Cinematic close-up",
      archetypeApplication: {
        primaryArchetype: "superhuman_physical_feat",
        subtype: "force_scaled_action",
        selectedFrame: "direct_action",
        strategyRationale: "Authored strategy applies.",
      },
      coreScene: "David performs a superhuman feat in the foreground as onlookers react.",
      subjectDetails: ["confident focused expression", "mid-exertion heroic pose"],
      environment: ["dramatic stage lighting", "blurred background crowd"],
      lightingAndStyle: "high-contrast cinematic key light",
      keyVisualElements: overrides.keyVisualElements ?? ["David central foreground", "dramatic lighting", "exertion pose"],
      subjectTreatment: {
        roleInScene: "Legendary protagonist",
        subjectRenderMode: mode,
        identityPreservation:
          mode === "human_identity_i2i" ? "human_face" : mode === "nonhuman_subject_i2i" ? "nonhuman_visual_identity" : "none",
        nonhumanSubjectTreatment: {
          applicable: mode === "nonhuman_subject_i2i",
          subjectKind: mode === "nonhuman_subject_i2i" ? "animal_subject" : "not_applicable",
          preserveTraits: mode === "nonhuman_subject_i2i" ? ["fur pattern", "ear shape"] : [],
          anthropomorphicTreatment: "none",
          doNotTransformIntoHuman: mode === "nonhuman_subject_i2i",
        },
        fallbackSubjectGender: mode === "t2i_fallback" ? "female" : "not_applicable",
        expressionAndPose: "Confident, focused",
        ageLifeStageTransform: { applies: false, targetState: "" },
      },
      subjectFactCompatibility: {
        rating: "strong",
        reason: "Stages well on the protagonist.",
        recommendedFallback: "none",
      },
      composition: {
        subjectFraming: "Medium close-up",
        negativeSpace: "top",
        cameraStyle: "Cinematic 35mm",
        sceneReadability: "Subject is the readable element",
      },
      supportingTextPolicy: {
        allowSupportingText: false,
        supportingTextElements: [],
        forbiddenTextTypes: [
          "full meme captions",
          "full fact text",
          "hashtags",
          "watermarks",
          "real logos",
          "brand marks",
          "long explanatory paragraphs",
        ],
      },
      secondaryCharacters: overrides.secondaryCharacters ?? [],
      semanticEntitiesUsed: overrides.semanticEntitiesUsed ?? [],
      culturalReferencesUsed: overrides.culturalReferencesUsed ?? [],
      styleIntegration: "Apply cinematic style",
      contentNotes: "SFW",
      debugNotes: "Strategy v2",
      targetEngine: "nano_banana_2" as const,
      generationMode,
    },
    compiledPrompt: {
      prompt: overrides.promptText ?? "David lifts a mountain over his head with one arm.",
      negativePrompt: "",
      engineNotes: "",
    },
    promptVersion: "test-prompt-v1",
    archetypeStrategyVersion: "test-strategy-v1",
    generatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    generatedBy: "openai" as const,
  };
}

async function createUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.isAdmin ? "legendary" : "registered",
    isAdmin: !!opts.isAdmin,
  });
  insertedUserIds.push(id);
  return id;
}

async function seedFact(opts: { text?: string; enrichment?: unknown } = {}): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({
      text: opts.text ?? `${FACT_TEXT_PREFIX}{NAME} bench-presses the Earth during Shark Week.`,
      enrichment: (opts.enrichment ?? VALID_ENRICHMENT) as FactEnrichment,
    })
    .returning({ id: factsTable.id });
  insertedFactIds.push(row!.id);
  return row!.id;
}

async function seedStyle(): Promise<string> {
  const id = `${STYLE_PREFIX}${randomUUID().slice(0, 8)}`;
  await db.insert(lookStylesTable).values({
    id,
    label: "Test Cinematic",
    promptSuffix: ", cinematic test style suffix",
    promptSuffixReference: ", reimagined in cinematic test style",
  });
  insertedStyleIds.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  if (insertedFactIds.length > 0) {
    await db.delete(factsTable).where(inArray(factsTable.id, insertedFactIds));
    insertedFactIds.length = 0;
  }
  // Prefix-based safety net: catches any facts left by a prior crashed run.
  await db.delete(factsTable).where(like(factsTable.text, `${FACT_TEXT_PREFIX}%`));
  if (insertedStyleIds.length > 0) {
    await db.delete(lookStylesTable).where(inArray(lookStylesTable.id, insertedStyleIds));
    insertedStyleIds.length = 0;
  }
  await db.delete(lookStylesTable).where(like(lookStylesTable.id, `${STYLE_PREFIX}%`));
  if (insertedUserIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
    insertedUserIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  adminUserId = await createUser({ isAdmin: true });
  plainUserId = await createUser({ isAdmin: false });
});

after(async () => {
  __setPlanGeneratorForTest(null);
  await cleanup();
});

afterEach(() => {
  __setPlanGeneratorForTest(null);
});

function adminApp() {
  return buildTestApp({ kind: "authenticated", userId: adminUserId }, adminImagePromptRouter);
}

// ── Auth gate ───────────────────────────────────────────────────────────────

describe("image-prompt preview — auth gate", () => {
  it("returns 401 with no credentials", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminImagePromptRouter);
    const res = await request(app).post("/api/admin/image-prompt/preview").send({ factId: 1 });
    assert.equal(res.status, 401);
  });

  it("returns 403 admin_required for a non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: plainUserId }, adminImagePromptRouter);
    const res = await request(app).post("/api/admin/image-prompt/preview").send({ factId: 1 });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });
});

// ── Validation ────────────────────────────────────────────────────────────

describe("image-prompt preview — validation", () => {
  it("400 when factId is missing", async () => {
    const res = await request(adminApp()).post("/api/admin/image-prompt/preview").send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "factId or reviewId is required");
  });

  it("400 fact_not_found for an unknown fact", async () => {
    const res = await request(adminApp()).post("/api/admin/image-prompt/preview").send({ factId: 999_000_001 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "fact_not_found");
  });

  it("400 fact_enrichment_invalid when the fact has no usable enrichment", async () => {
    const factId = await seedFact({ enrichment: { primaryArchetype: "nope" } });
    const res = await request(adminApp()).post("/api/admin/image-prompt/preview").send({ factId });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "fact_enrichment_invalid");
  });
});

// ── Happy paths ─────────────────────────────────────────────────────────────

describe("image-prompt preview — human i2i", () => {
  it("renders fact text, echoes input summary + debug, preserves face", async () => {
    const factId = await seedFact();
    __setPlanGeneratorForTest(async () => makeOutput({ subjectRenderMode: "human_identity_i2i" }) as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    // {NAME} resolved to the brand protagonist for prompt generation.
    assert.match(res.body.renderedFactText, /David/);
    assert.doesNotMatch(res.body.renderedFactText, /\{NAME\}/);

    assert.equal(res.body.inputSummary.factId, factId);
    assert.equal(res.body.inputSummary.subjectRenderMode, "human_identity_i2i");
    assert.equal(res.body.inputSummary.generationMode, "i2i");
    assert.equal(res.body.inputSummary.targetEngine, "nano_banana_2");
    assert.equal(res.body.inputSummary.styleSource, "none");
    assert.equal(typeof res.body.inputSummary.preservePhysique, "boolean");

    assert.equal(res.body.debug.primaryArchetype, "superhuman_physical_feat");
    assert.equal(res.body.debug.subtype, "force_scaled_action");
    assert.equal(res.body.debug.visualStrategyVersion, "test-strategy-v1");
    assert.equal(res.body.debug.generatedBy, "openai");

    // Compiler injected the transformation-aware human identity preamble.
    assert.match(
      String(res.body.compiledPrompt.imagePrompt).toLowerCase(),
      /preserve the reference person's recognizable identity and likeness/,
    );
  });
});

describe("image-prompt preview — nonhuman i2i", () => {
  it("injects the do-not-replace-with-a-human clause", async () => {
    const factId = await seedFact();
    __setPlanGeneratorForTest(
      async () =>
        makeOutput({
          subjectRenderMode: "nonhuman_subject_i2i",
          promptText: "An orange tabby cat heroically lifts a mountain.",
        }) as never,
    );

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "nonhuman_subject_i2i" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inputSummary.subjectRenderMode, "nonhuman_subject_i2i");
    assert.match(String(res.body.compiledPrompt.imagePrompt).toLowerCase(), /do not replace.*human/);
  });
});

describe("image-prompt preview — t2i fallback", () => {
  it("surfaces fallback gender and bakes it into the prompt", async () => {
    const factId = await seedFact();
    __setPlanGeneratorForTest(
      async () => makeOutput({ subjectRenderMode: "t2i_fallback", promptText: "A protagonist lifts a mountain." }) as never,
    );

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({
        factId,
        subjectRenderMode: "t2i_fallback",
        renderControls: { fallbackSubjectGender: "female", aspectRatio: "portrait", contentMode: "sfw" },
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inputSummary.generationMode, "t2i");
    assert.equal(res.body.inputSummary.fallbackSubjectGender, "female");
    assert.match(String(res.body.compiledPrompt.imagePrompt).toLowerCase(), /female/);
  });
});

// ── Style source ────────────────────────────────────────────────────────────

describe("image-prompt preview — style source", () => {
  it("styleSource=selected_look_style with a non-empty suffix when a look style is chosen", async () => {
    const factId = await seedFact();
    const styleId = await seedStyle();
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", lookStyleId: styleId });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inputSummary.styleSource, "selected_look_style");
    assert.equal(res.body.inputSummary.lookStyleId, styleId);
    assert.ok(res.body.inputSummary.stylePrompt.length > 0);
    // i2i pulls the reference-conditioned suffix and the compiler appends it.
    assert.match(String(res.body.compiledPrompt.imagePrompt), /reimagined in cinematic test style/);
  });

  it("styleSource=none when no look style is chosen", async () => {
    const factId = await seedFact();
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inputSummary.styleSource, "none");
    assert.equal(res.body.inputSummary.stylePrompt, "");
  });
});

// ── Regression: entity / cultural-ref surfacing + non-mutation ───────────────

describe("image-prompt preview — debug surfacing & non-mutation", () => {
  it("echoes semanticEntitiesUsed from the plan and culturalReferencesProvided from enrichment", async () => {
    const factId = await seedFact();
    __setPlanGeneratorForTest(
      async () =>
        makeOutput({
          semanticEntitiesUsed: [
            { surfaceText: "Earth", visualReferentUsed: "the planet Earth", effectOnVisualPlan: "Planet visible in frame" },
          ],
        }) as never,
    );

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.debug.semanticEntitiesUsed.length, 1);
    assert.equal(res.body.debug.semanticEntitiesUsed[0].surfaceText, "Earth");
    // Cultural refs: the plan has no echo array, so we surface what was provided.
    assert.equal(res.body.debug.culturalReferencesProvided.length, 1);
    assert.equal(res.body.debug.culturalReferencesProvided[0].sourcePhrase, "Shark Week");
    assert.deepEqual(res.body.debug.culturalReferencesUsed, []);
  });

  it("does not mutate the fact's stored enrichment", async () => {
    const factId = await seedFact();
    const [before] = await db.select({ enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, factId));
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    const [after] = await db.select({ enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, factId));
    assert.deepEqual(after!.enrichment, before!.enrichment);
  });
});

// ── Stored Visual Concept + bubbles reach the compiled prompt (UAT deferred, #631 7b) ──

function overrideEnrichment(partial: Record<string, unknown>): FactEnrichment {
  return {
    ...VALID_ENRICHMENT,
    visualPromptStrategyOverride: {
      version: 1,
      requiredVisualDetails: [],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
      bubbles: [],
      ...partial,
    },
  } as unknown as FactEnrichment;
}

/** Text of one labeled section of the compiled prompt, up to the next known label. */
function promptSection(prompt: string, label: string): string {
  const labels = [
    "CORE SCENE", "IDENTITY & REFERENCE", "RENDER TASK", "SUBJECT BINDING", "SUBJECT REALIZATION",
    "ROLE DETAILS", "SUBJECT DETAILS", "REQUIRED VISUAL DETAILS", "ENVIRONMENT", "ADDITIONAL DETAILS",
    "SPEECH & THOUGHT BUBBLES", "COMPOSITION", "LIGHTING", "RENDER STYLE", "STRICT CONSTRAINTS",
  ];
  const start = prompt.indexOf(`${label}: `);
  assert.ok(start >= 0, `section ${label} missing from: ${prompt}`);
  const body = prompt.slice(start + label.length + 2);
  const next = labels.map((l) => body.indexOf(` ${l}: `)).filter((i) => i >= 0);
  return (next.length ? body.slice(0, Math.min(...next)) : body).trim();
}

describe("image-prompt preview — CORE SCENE source", () => {
  it("uses the planner's coreScene when the fact has no stored Concept", async () => {
    const factId = await seedFact();
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      promptSection(String(res.body.compiledPrompt.imagePrompt), "CORE SCENE"),
      "David performs a superhuman feat in the foreground as onlookers react.",
    );
  });

  it("uses the fact's saved Visual Concept, token-rendered, instead of the planner's coreScene", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        coreSceneOverride: "{NAME} rides a giant rubber duck across a packed stadium.",
      }),
    });
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.equal(promptSection(prompt, "CORE SCENE"), "David rides a giant rubber duck across a packed stadium.");
    assert.doesNotMatch(prompt, /superhuman feat in the foreground/);
  });

  it("carries both CORE SCENE and the fact's required visual detail in one prompt", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        coreSceneOverride: "{NAME} rides a giant rubber duck across a packed stadium.",
        requiredVisualDetails: ["a scoreboard reading 9999"],
      }),
    });
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.equal(promptSection(prompt, "CORE SCENE"), "David rides a giant rubber duck across a packed stadium.");
    assert.equal(promptSection(prompt, "REQUIRED VISUAL DETAILS"), "a scoreboard reading 9999.");
  });

  it("keeps a Concept with compiler-owned language verbatim and returns the rewrite warning", async () => {
    const owned = "{NAME} rides a T-Rex through the office. Ensure {NAME}'s recognizable face is preserved.";
    const factId = await seedFact({ enrichment: overrideEnrichment({ coreSceneOverride: owned }) });
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      promptSection(String(res.body.compiledPrompt.imagePrompt), "CORE SCENE"),
      "David rides a T-Rex through the office. Ensure David's recognizable face is preserved.",
    );
    const warnings: Array<{ code: string; message: string }> = res.body.compiledPrompt.diagnostics?.warnings ?? [];
    const w = warnings.find((x) => x.code === "moderator_core_scene_owned_language");
    assert.ok(w, JSON.stringify(warnings));
    assert.match(w.message, /rewrite it as visible scene description/);
  });
});

describe("image-prompt preview — look style copy per generation mode", () => {
  it("t2i_fallback compiles the style's declarative promptSuffix, not its promptSuffixReference", async () => {
    const factId = await seedFact();
    const styleId = await seedStyle();
    __setPlanGeneratorForTest(
      async () => makeOutput({ subjectRenderMode: "t2i_fallback", promptText: "A protagonist lifts a mountain." }) as never,
    );

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({
        factId,
        subjectRenderMode: "t2i_fallback",
        lookStyleId: styleId,
        renderControls: { fallbackSubjectGender: "female" },
      });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inputSummary.styleSource, "selected_look_style");
    assert.equal(res.body.inputSummary.stylePrompt, ", cinematic test style suffix");
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.match(promptSection(prompt, "RENDER STYLE"), /cinematic test style suffix/);
    assert.doesNotMatch(prompt, /reimagined in cinematic test style/);
  });
});

describe("image-prompt preview — stored speech & thought bubbles", () => {
  it("returns one speech directive quoting the exact text, tail pointing to the preview name", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        bubbles: [{ type: "speech", entity: "subject", text: "You're the man of the house now." }],
      }),
    });
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.equal(prompt.split("SPEECH & THOUGHT BUBBLES:").length - 1, 1, "one bubbles section");
    assert.equal(prompt.split("speech balloon").length - 1, 1, "one speech directive");
    assert.ok(
      promptSection(prompt, "SPEECH & THOUGHT BUBBLES").startsWith(
        `One clean comic-style speech balloon with its tail pointing to David, containing exactly the text "You're the man of the house now." in clear, legible lettering.`,
      ),
      prompt,
    );
  });

  it("returns a cloud-shaped thought balloon whose trail leads to the head of the bartender", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        bubbles: [{ type: "thought", entity: "the bartender", text: "Not again." }],
      }),
    });
    __setPlanGeneratorForTest(
      async () =>
        makeOutput({ secondaryCharacters: [{ label: "the bartender", visualRole: "polishing a glass behind the bar" }] }) as never,
    );

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(
      promptSection(String(res.body.compiledPrompt.imagePrompt), "SPEECH & THOUGHT BUBBLES").startsWith(
        'One cloud-shaped thought balloon with a trail of small circles leading to the head of the bartender, containing exactly the text "Not again." in clear, legible lettering.',
      ),
    );
  });

  it("renders a {NAME} token in the stored bubble with the previewName and leaves no raw token", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        bubbles: [{ type: "speech", entity: "subject", text: "{NAME} did it again!" }],
      }),
    });
    __setPlanGeneratorForTest(async () => makeOutput() as never);

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.ok(prompt.includes('containing exactly the text "David did it again!"'), prompt);
    assert.doesNotMatch(prompt, /\{NAME\}/);
  });
});
