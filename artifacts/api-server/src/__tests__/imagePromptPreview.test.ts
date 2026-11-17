/**
 * Integration tests for POST /admin/image-prompt/preview (Phase 2C — Runtime
 * Compiled Prompt Preview).
 *
 * Mounts adminImagePromptRouter behind buildTestApp() stub auth so requireAdmin
 * runs end-to-end. Since the render planner was removed (plan
 * docs/plans/PLAN_GAG_DIRECT_RENDER.md, D) the preview makes no model call: it
 * compiles the fact's gag directly, exactly as a render would.
 *
 * Touches the real test DB. Seeds facts under id range / userIds under the
 * `t-ipp-` prefix; cleanup deletes only those rows.
 */

import { describe, it, before, after } from "node:test";
import { baselineRecipeFor } from "../lib/imagePrompt/recipe.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db, factGagsTable } from "@workspace/db";
import { usersTable, factsTable, lookStylesTable } from "@workspace/db/schema";
import type { FactEnrichment } from "@workspace/api-zod";
import { eq, inArray, like } from "drizzle-orm";

import adminImagePromptRouter from "../routes/adminImagePrompt.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { withCast } from "./helpers/gagCast.js";

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
  characters: [],
};

/** The gag a fact gets when a test gives none: every preview draws one gag. */
const DEFAULT_GAG = { version: 1, coreSceneOverride: "{NAME} lifts a mountain over {POSS} head with one arm." };

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

/**
 * A fact; a gag in the given enrichment is stored as its slot-1 gag (fact_gags,
 * migration 0139), with a cast read from its own scene (`withCast`; `cast`
 * replaces the entries). With no enrichment given the fact gets DEFAULT_GAG;
 * `noGag` seeds none.
 */
async function seedFact(opts: { text?: string; enrichment?: unknown; cast?: Array<{ label: string; description: string }>; noGag?: boolean } = {}): Promise<number> {
  const { visualPromptStrategyOverride: given, ...classification } = (opts.enrichment ?? VALID_ENRICHMENT) as Record<string, unknown>;
  const gag = opts.noGag ? undefined : given ?? (opts.enrichment === undefined ? DEFAULT_GAG : undefined);
  const [row] = await db
    .insert(factsTable)
    .values({
      text: opts.text ?? `${FACT_TEXT_PREFIX}{NAME} bench-presses the Earth during Shark Week.`,
      enrichment: classification as FactEnrichment,
    })
    .returning({ id: factsTable.id });
  insertedFactIds.push(row!.id);
  // A gag always has a scene now (fact_gags CHECK); a bubble-only fixture gets a plain one.
  if (gag) {
    const content = withCast({ coreSceneOverride: "{NAME} stands in a kitchen.", ...(gag as Record<string, unknown>) });
    await db.insert(factGagsTable).values({
      factId: row!.id, slot: 1,
      pendingContent: opts.cast ? { ...content, cast: opts.cast } : content,
    });
  }
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
  await cleanup();
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
  it("renders fact text, echoes the input summary, preserves face, and carries no planner output", async () => {
    const factId = await seedFact();

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

    // No planner runs since the switch (PLAN_GAG_DIRECT_RENDER.md, D): none of its output is returned.
    for (const k of ["visualPlan", "subjectFactCompatibility", "debug", "promptVersion", "archetypeStrategyVersion"]) {
      assert.equal(res.body[k], undefined, `no ${k}`);
    }
    assert.equal(
      promptSection(String(res.body.compiledPrompt.imagePrompt), "CORE SCENE"),
      "David Franklin lifts a mountain over his head with one arm.",
      "the fact's gag, compiled directly",
    );

    // Compiler injected the transformation-aware human identity paragraph, in
    // the wording of the engine a look-less render is routed to (GPT Image 2.6).
    assert.ok(
      String(res.body.compiledPrompt.imagePrompt).includes(baselineRecipeFor("gpt-image-2-6").pieces["identity.person"]),
      "the routed engine's identity paragraph",
    );
  });
});

describe("image-prompt preview — nonhuman i2i", () => {
  it("injects the do-not-replace-with-a-human clause", async () => {
    const factId = await seedFact();

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "nonhuman_subject_i2i" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inputSummary.subjectRenderMode, "nonhuman_subject_i2i");
    assert.match(String(res.body.compiledPrompt.imagePrompt).toLowerCase(), /do not replace.*human/);
  });
});

describe("image-prompt preview — no picture without a photo", () => {
  it("refuses the retired no-photo mode, naming why", async () => {
    const factId = await seedFact();

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "t2i_fallback", renderControls: { aspectRatio: "portrait", contentMode: "sfw" } });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "no_usable_photo");
  });
});

// ── Style source ────────────────────────────────────────────────────────────

describe("image-prompt preview — style source", () => {
  it("styleSource=selected_look_style with a non-empty suffix when a look style is chosen", async () => {
    const factId = await seedFact();
    const styleId = await seedStyle();

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

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inputSummary.styleSource, "none");
    assert.equal(res.body.inputSummary.stylePrompt, "");
  });
});

// ── Regression: entity / cultural-ref surfacing + non-mutation ───────────────

describe("image-prompt preview — non-mutation", () => {
  it("does not mutate the fact's stored enrichment", async () => {
    const factId = await seedFact();
    const [before] = await db.select({ enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, factId));

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
  // Sections are joined by the routed engine's shape: a space, or paragraph breaks.
  const escape = (t: string) => t.replace(/[\\^$.*+?()[\]{}|&]/g, "\\$&");
  const next = labels.map((l) => body.search(new RegExp(`\\s${escape(l)}: `))).filter((i) => i >= 0);
  return (next.length ? body.slice(0, Math.min(...next)) : body).trim();
}

describe("image-prompt preview — CORE SCENE source", () => {
  it("refuses a fact with no gag to draw, naming why (gag_scene_missing)", async () => {
    const factId = await seedFact({ noGag: true });

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "gag_scene_missing");
    assert.ok(res.body.message);
  });

  it("refuses a gag whose cast was not read from its scene as it stands (gag_cast_not_current)", async () => {
    const factId = await seedFact({ enrichment: overrideEnrichment({ coreSceneOverride: "{NAME} juggles moons." }) });
    await db.update(factGagsTable)
      .set({ pendingContent: { ...withCast({ version: 1, coreSceneOverride: "{NAME} juggles moons." }), coreSceneOverride: "{NAME} juggles planets." } })
      .where(eq(factGagsTable.factId, factId));

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i" });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "gag_cast_not_current");
  });

  it("uses the fact's saved Visual Concept, token-rendered", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        coreSceneOverride: "{NAME} rides a giant rubber duck across a packed stadium.",
      }),
    });

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.equal(promptSection(prompt, "CORE SCENE"), "David rides a giant rubber duck across a packed stadium.");
  });

  it("carries the CORE SCENE but no retired required visual detail an older gag still stores (PLAN_GAG_DIRECT_RENDER.md, D)", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        coreSceneOverride: "{NAME} rides a giant rubber duck across a packed stadium.",
        requiredVisualDetails: ["a scoreboard reading 9999"],
      }),
    });

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.equal(promptSection(prompt, "CORE SCENE"), "David rides a giant rubber duck across a packed stadium.");
    assert.doesNotMatch(prompt, /REQUIRED VISUAL DETAILS|scoreboard reading 9999/);
  });

  it("keeps a Concept with compiler-owned language verbatim and returns the rewrite warning", async () => {
    const owned = "{NAME} rides a T-Rex through the office. Ensure {NAME}'s recognizable face is preserved.";
    const factId = await seedFact({ enrichment: overrideEnrichment({ coreSceneOverride: owned }) });

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
  it("refuses a look that does not exist with a 400, never treating it as no look", async () => {
    const factId = await seedFact();
    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", lookStyleId: "no-such-look-style" });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "look_style_unavailable");
    assert.equal(res.body.reason, "not_found");
  });
});

describe("image-prompt preview — stored speech & thought bubbles", () => {
  it("returns one speech directive quoting the exact text, tail pointing to the preview name", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        bubbles: [{ type: "speech", entity: "subject", text: "You're the man of the house now." }],
      }),
    });

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

  it("returns a cloud-shaped thought balloon whose trail leads to the head of the bartender, bound by the gag's cast", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        bubbles: [{ type: "thought", entity: "the bartender", text: "Not again." }],
      }),
      cast: [{ label: "the bartender", description: "polishing a glass behind the bar" }],
    });

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(
      // v9: the section leads with the speaker's binding, then the directive,
      // which is byte-identical to v8's (PLAN_BUBBLE_SPEAKERS.md, F).
      promptSection(String(res.body.compiledPrompt.imagePrompt), "SPEECH & THOUGHT BUBBLES").startsWith(
        'the bartender: polishing a glass behind the bar. One cloud-shaped thought balloon with a trail of small circles leading to the head of the bartender, containing exactly the text "Not again." in clear, legible lettering.',
      ),
    );
  });

  it("renders a {NAME} token in the stored bubble with the previewName and leaves no raw token", async () => {
    const factId = await seedFact({
      enrichment: overrideEnrichment({
        bubbles: [{ type: "speech", entity: "subject", text: "{NAME} did it again!" }],
      }),
    });

    const res = await request(adminApp())
      .post("/api/admin/image-prompt/preview")
      .send({ factId, subjectRenderMode: "human_identity_i2i", previewName: "David" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const prompt = String(res.body.compiledPrompt.imagePrompt);
    assert.ok(prompt.includes('containing exactly the text "David did it again!"'), prompt);
    assert.doesNotMatch(prompt, /\{NAME\}/);
  });
});
