// The direct compile (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, A and D): a
// prompt compiled from one selected gag's content and fixed wording, with no
// planner — since the switch, the only compile there is. These tests hold what
// the plan names for it: the gag leads verbatim; no section the switch removed
// appears; the cast binds bubble speakers; a bubble's directive is the one
// composeBubbleDirective writes; the one violence sentence is always present;
// the pet line appears for a pet's photo only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compileDirect,
  composeBubbleDirective,
  DIRECT_FILL_INSTRUCTION,
  DIRECT_PET_INSTRUCTION,
  type DirectCompileArgs,
} from "../lib/imagePrompt/compilers/nanoBanana2.js";
import { BASELINE_RECIPE, baselineRecipeFor, fillPiece } from "../lib/imagePrompt/recipe.js";
import { VIOLENCE_RULE } from "../lib/imagePrompt/violenceRule.js";
import { castSourceKey, type FactEnrichment, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import { directGagInput, DirectGagInputError, renderedGagProjection } from "../lib/imagePrompt/directInput.js";
import { renderAffectingEnrichment } from "../lib/factRenderScenarios.js";

const base = (over: Partial<DirectCompileArgs> = {}): DirectCompileArgs => ({
  gag: { scene: "{NAME} drives {POSS} mom home from the hospital, tiny hands on the wheel.", bubbles: [] },
  cast: [],
  subjectRenderMode: "human_identity_i2i",
  renderedSubject: { name: "David", pronouns: "he/him" },
  referenceImageUrl: "https://example.test/ref.jpg",
  ...over,
});

const ids = (out: ReturnType<typeof compileDirect>) =>
  (out.promptBreakdown ?? []).filter((s) => s.status === "included").map((s) => s.id);

describe("compileDirect", () => {
  it("leads with the gag's scene, token-rendered and otherwise verbatim", () => {
    const out = compileDirect(base());
    assert.ok(out.prompt.startsWith(fillPiece(BASELINE_RECIPE, "shape.section", {
      label: fillPiece(BASELINE_RECIPE, "label.coreScene"),
      body: "David drives his mom home from the hospital, tiny hands on the wheel.",
    })));
    assert.equal(out.referenceImageUrl, "https://example.test/ref.jpg");
  });

  it("emits no planner section and nothing the switch removes", () => {
    const out = compileDirect(base({ renderControls: { negativeSpacePreference: "top" } }));
    assert.deepEqual(ids(out), ["core_scene", "identity_reference", "additional_details", "composition", "render_style", "strict_constraints"]);
    // The removed sections' labels and the opening words of the removed
    // binding and do-not lines, as the baseline wrote them before the switch.
    for (const gone of ["SUBJECT BINDING", "SUBJECT REALIZATION", "ROLE DETAILS", "SUBJECT DETAILS", "ENVIRONMENT:", "LIGHTING:", "a single instance", "Do not duplicate, clone, or mirror", "performs the central action"]) {
      assert.ok(!out.prompt.includes(gone), `${gone} is absent`);
    }
    assert.ok(out.prompt.includes(DIRECT_FILL_INSTRUCTION));
    assert.ok(out.prompt.includes(fillPiece(BASELINE_RECIPE, "composition.captionSpace", { side: "top" })));
  });

  it("always carries the one violence sentence, with the overlay-text exclusion", () => {
    const out = compileDirect(base({ gag: { scene: "{NAME} waters a houseplant.", bubbles: [] } }));
    assert.ok(out.prompt.includes(VIOLENCE_RULE));
    assert.ok(out.prompt.includes(fillPiece(BASELINE_RECIPE, "text.incidental")));
    assert.equal(out.prompt.split(VIOLENCE_RULE).length - 1, 1, "exactly once");
  });

  it("adds the pet line for a pet's photo only", () => {
    assert.ok(!compileDirect(base()).prompt.includes(DIRECT_PET_INSTRUCTION));
    const pet = compileDirect(base({ subjectRenderMode: "nonhuman_subject_i2i", renderedSubject: { name: "Mango", pronouns: "he/him" } }));
    assert.ok(pet.prompt.includes(DIRECT_PET_INSTRUCTION));
    assert.ok(pet.prompt.includes(fillPiece(BASELINE_RECIPE, "identity.pet")));
  });

  it("binds each speaker from the cast, with the bubble directive composeBubbleDirective writes, byte for byte", () => {
    const bubbles = [
      { type: "speech" as const, entity: "mom", text: "Slow down, {NAME}!" },
      { type: "thought" as const, entity: "subject", text: "Nailed it." },
    ];
    const out = compileDirect(base({ gag: { scene: "{NAME} drives; mom grips the dashboard.", bubbles }, cast: [{ label: "mom", description: "the older woman in the passenger seat" }] }));
    assert.ok(out.prompt.includes("mom: the older woman in the passenger seat."));
    assert.ok(out.prompt.includes(composeBubbleDirective({ type: "speech", text: "Slow down, David!" }, "mom")));
    assert.ok(out.prompt.includes(composeBubbleDirective({ type: "thought", text: "Nailed it." }, "David")));
    assert.deepEqual(out.diagnostics?.warnings ?? [], []);
  });

  it("warns, and still renders the balloon, when a speaker has no cast entry", () => {
    const out = compileDirect(base({ gag: { scene: "{NAME} drives.", bubbles: [{ type: "speech", entity: "nurse", text: "Bye!" }] } }));
    assert.equal(out.diagnostics?.warnings?.[0]?.code, "bubble_entity_unresolved");
    assert.ok(out.prompt.includes(composeBubbleDirective({ type: "speech", text: "Bye!" }, "nurse")));
  });

  it("refuses a no-photo render and an empty scene", () => {
    assert.throws(() => compileDirect(base({ subjectRenderMode: "t2i_fallback" })), /retired/);
    assert.throws(() => compileDirect(base({ gag: { scene: "  ", bubbles: [] } })), /scene/);
  });

  it("uses a chosen look in place of the photoreal line, and fits each engine family's wording", () => {
    for (const family of ["gpt-image-2-6", "nano-banana-2-1", "nano-banana-2"]) {
      const r = baselineRecipeFor(family);
      const plain = compileDirect(base({ recipe: r }));
      assert.ok(plain.prompt.includes(fillPiece(r, "style.photoreal")), family);
      const styled = compileDirect(base({ recipe: r, stylePrompt: "Rendered as a 1950s comic book panel." }));
      assert.ok(styled.prompt.includes("Rendered as a 1950s comic book panel."), family);
      assert.equal(styled.diagnostics?.requiredBudgetOverflow, undefined, family);
    }
  });
});

// ─── The selected gag is the whole input (plan, D; Q11: 1) ───────────────────


/** A stored gag's content with a cast read from its own scene and speakers. */
function gagContent(scene: string, bubbles: VisualPromptStrategyOverride["bubbles"], cast: Array<{ label: string; description: string }>): VisualPromptStrategyOverride {
  return {
    version: 1, coreSceneOverride: scene, bubbles, cast,
    castExtraction: { promptVersion: "test", extractedAt: "2026-11-17T00:00:00Z", sourceKey: castSourceKey(scene, bubbles) },
    requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [], compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
  } as VisualPromptStrategyOverride;
}

describe("one selected gag is the compile's whole fact-specific input", () => {
  const gagA = gagContent("{NAME} drives {POSS} mom home from the hospital as a newborn.", [{ type: "speech", entity: "mom", text: "Slow down!" }], [{ label: "mom", description: "the woman in the passenger seat" }]);
  const gagB = gagContent("{NAME} parallel parks an aircraft carrier in one move.", [{ type: "thought", entity: "subject", text: "Easy." }], []);
  const compileGag = (g: VisualPromptStrategyOverride) => compileDirect(base({ ...directGagInput(g) })).prompt;

  it("two gags of one fact compile to prompts that share no gag-owned text", () => {
    const [a, b] = [compileGag(gagA), compileGag(gagB)];
    const owned = (g: VisualPromptStrategyOverride) => [
      g.coreSceneOverride!.replace(/\{NAME\}/g, "David").replace(/\{POSS\}/g, "his"),
      ...g.bubbles.map((x) => x.text),
      ...(g.cast ?? []).map((c) => c.description),
    ];
    for (const t of owned(gagA)) { assert.ok(a.includes(t), `A carries its own "${t}"`); assert.ok(!b.includes(t), `B carries none of A's "${t}"`); }
    for (const t of owned(gagB)) { assert.ok(b.includes(t), `B carries its own "${t}"`); assert.ok(!a.includes(t), `A carries none of B's "${t}"`); }
  });

  it("refuses a gag with no scene, or whose cast was not read from its scene as it stands", () => {
    assert.throws(() => directGagInput(null), (e: unknown) => e instanceof DirectGagInputError && e.code === "gag_scene_missing");
    const stale = { ...gagA, coreSceneOverride: `${gagA.coreSceneOverride} A nurse waves.` };
    assert.throws(() => directGagInput(stale), (e: unknown) => e instanceof DirectGagInputError && e.code === "gag_cast_not_current");
    const never = { ...gagA, cast: undefined, castExtraction: undefined };
    assert.throws(() => directGagInput(never), (e: unknown) => e instanceof DirectGagInputError && e.code === "gag_cast_not_current");
  });

  it("render freshness reads the gag alone: no classification field or fact character moves it; a cast entry does; the marker does not", () => {
    const classification = {
      primaryArchetype: "superhuman_physical_feat", subtype: "force_scaled_action", modifiers: ["age_transform_baby"],
      visualLiteralness: "literal_dramatization", visualComplexity: "medium", overhypeFit: "strong", adultSuitability: "safe",
      adultSuitabilityNotes: "", suggestedHashtags: [], taxonomyConfidence: 0.9, adminReviewNotes: "", culturalReferences: [], semanticEntities: [],
      characters: [{ label: "mom", description: "the subject's mother" }],
    } as unknown as FactEnrichment;
    const hash = (e: FactEnrichment) => JSON.stringify(renderAffectingEnrichment(e));
    const withGag = (e: FactEnrichment, g: VisualPromptStrategyOverride) => ({ ...e, visualPromptStrategyOverride: g }) as FactEnrichment;
    const before = hash(withGag(classification, gagA));
    const reclassified = { ...classification, primaryArchetype: "temporal_causality_inversion", subtype: "x", modifiers: ["violence", "avoid_duplicate_subject"], visualLiteralness: "symbolic", culturalReferences: [{ sourcePhrase: "x" }], semanticEntities: [{ surfaceText: "y" }], characters: [] } as unknown as FactEnrichment;
    assert.equal(hash(withGag(reclassified, gagA)), before, "a classification edit leaves the render fresh");
    const recast = { ...gagA, cast: [{ label: "mom", description: "an older woman in a red coat" }] };
    assert.notEqual(hash(withGag(classification, recast)), before, "a changed cast entry is a different picture");
    const reread = { ...gagA, castExtraction: { ...gagA.castExtraction!, extractedAt: "2026-12-01T00:00:00Z", promptVersion: "test2" } };
    assert.equal(hash(withGag(classification, reread)), before, "the extraction marker is not part of the picture");
    assert.deepEqual(renderedGagProjection(gagA)?.cast, [{ label: "mom", description: "the woman in the passenger seat" }]);
  });
});
