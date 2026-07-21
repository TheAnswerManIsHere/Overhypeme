/**
 * Unit tests for the Nano Banana 2 prompt compilers.
 *
 * Pure — no DB, no LLM, no IO. The compiler ASSEMBLES the final engine prompt
 * from the structured visualPlan + runtime inputs as a labeled visual contract
 * where the Visual Concept (CORE SCENE) LEADS: CORE SCENE · IDENTITY & REFERENCE
 * / RENDER TASK · SUBJECT BINDING · ROLE DETAILS · SUBJECT DETAILS · ENVIRONMENT
 * · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS.
 *
 * These tests exercise: the transformation-aware preamble, the deterministic
 * SUBJECT BINDING + anti-entity-split guards (the de-aging fix), the removal of
 * authorial-intent commentary, structured directive injection (key elements,
 * composition, supporting text, semantic + cultural references, fact modifiers),
 * the priority-aware char budget, and the empty-negativePrompt invariant.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  compileForSubjectRenderMode,
  compileNanoBanana2NonhumanI2I,
  compileNanoBanana2HumanI2I,
  compileNanoBanana2T2I,
} from "../lib/imagePrompt/compilers/nanoBanana2.js";
import type { ImagePromptGenerationInput, VisualPlan } from "@workspace/api-zod";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.toLowerCase().split(needle.toLowerCase()).length - 1;
}

function makeVisualPlan(overrides: Partial<VisualPlan> = {}): VisualPlan {
  return {
    sceneConcept: "scene",
    visualGoal: "",
    visualApproach: "",
    archetypeApplication: {
      primaryArchetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      selectedFrame: "direct_action",
      strategyRationale: "rationale",
    },
    coreScene: "",
    subjectDetails: [],
    environment: [],
    lightingAndStyle: "",
    keyVisualElements: ["a", "b", "c"],
    subjectTreatment: {
      roleInScene: "protagonist",
      subjectRenderMode: "human_identity_i2i",
      identityPreservation: "human_face",
      nonhumanSubjectTreatment: {
        applicable: false,
        subjectKind: "not_applicable",
        preserveTraits: [],
        anthropomorphicTreatment: "none",
        doNotTransformIntoHuman: false,
      },
      fallbackSubjectGender: "not_applicable",
      expressionAndPose: "confident",
      ageLifeStageTransform: { applies: false, targetState: "" },
    },
    secondaryCharacters: [],
    subjectFactCompatibility: { rating: "strong", reason: "ok", recommendedFallback: "none" },
    composition: { subjectFraming: "", negativeSpace: "none", cameraStyle: "", sceneReadability: "readable" },
    supportingTextPolicy: { allowSupportingText: false, supportingTextElements: [], forbiddenTextTypes: [] },
    semanticEntitiesUsed: [],
    culturalReferencesUsed: [],
    contentNotes: "",
    debugNotes: "",
    targetEngine: "nano_banana_2",
    generationMode: "i2i",
    ...overrides,
  };
}

function makeArgs(opts: {
  subjectRenderMode: ImagePromptGenerationInput["subjectRenderMode"];
  prompt: string;
  stylePrompt?: string;
  fallbackSubjectGender?: "male" | "female" | "neutral";
  referenceImageUrl?: string | null;
  modifiers?: string[];
  visualPlan?: Partial<VisualPlan>;
  negativePrompt?: string;
  renderedSubject?: { name: string; pronouns: string | null };
  factText?: string;
  renderPolicy?: ImagePromptGenerationInput["renderPolicy"];
  override?: unknown;
}) {
  const input = {
    subjectRenderMode: opts.subjectRenderMode,
    stylePrompt: opts.stylePrompt ?? "",
    referenceImageUrl: opts.referenceImageUrl ?? null,
    factText: opts.factText ?? "",
    enrichment: { modifiers: opts.modifiers ?? [], ...(opts.override ? { visualPromptStrategyOverride: opts.override } : {}) },
    renderControls: {
      aspectRatio: "portrait",
      contentMode: "sfw",
      ...(opts.fallbackSubjectGender ? { fallbackSubjectGender: opts.fallbackSubjectGender } : {}),
    },
    ...(opts.renderPolicy ? { renderPolicy: opts.renderPolicy } : {}),
  } as unknown as ImagePromptGenerationInput;
  return {
    visualPlan: makeVisualPlan(opts.visualPlan),
    compiledPrompt: { prompt: opts.prompt, negativePrompt: opts.negativePrompt ?? "", engineNotes: "" },
    input,
    ...(opts.renderedSubject ? { renderedSubject: opts.renderedSubject } : {}),
  };
}

describe("nanoBanana2 — labeled visual contract", () => {
  it("leads with CORE SCENE; the transformation-aware identity clause follows it", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David deadlifts a bus.",
    }));
    // The Visual Concept (CORE SCENE) now leads the prompt.
    assert.match(out.imagePrompt, /^CORE SCENE:/);
    // The identity clause is right after the scene (labeled IDENTITY & REFERENCE,
    // not the old misleading "IMAGE-TO-IMAGE TASK").
    assert.match(out.imagePrompt, /IDENTITY & REFERENCE: Image-to-image edit using the reference image/);
    const coreAt = out.imagePrompt.indexOf("CORE SCENE:");
    const idAt = out.imagePrompt.indexOf("IDENTITY & REFERENCE:");
    assert.ok(coreAt >= 0 && idAt > coreAt, "identity clause must follow CORE SCENE");
    // Identity preservation is transformation-aware (likeness, not a frozen face).
    assert.match(out.imagePrompt.toLowerCase(), /recognizable identity and likeness/);
    assert.match(out.imagePrompt.toLowerCase(), /allow apparent age, body proportions, hair, clothing, and life stage to transform/);
  });

  it("emits the contract section headers", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands in a thunderstorm holding a trophy.",
    }));
    assert.match(out.imagePrompt, /IDENTITY & REFERENCE:/);
    assert.match(out.imagePrompt, /CORE SCENE:/);
    assert.match(out.imagePrompt, /STRICT CONSTRAINTS:/);
  });

  it("never emits the old abstract intent line", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
      visualPlan: { visualGoal: "Make the feat feel legendary", visualApproach: "Ground it cinematically" },
    }));
    assert.doesNotMatch(out.imagePrompt, /Intent:/);
    assert.doesNotMatch(out.imagePrompt, /Stage it as:/);
    // The internal goal/approach text is not leaked into the engine prompt.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /make the feat feel legendary/);
  });
});

describe("nanoBanana2 — initialisms survive sentence splitting", () => {
  it("keeps 'M.C. Hammer' intact in CORE SCENE (does not shatter on abbreviation periods)", () => {
    const out = compileNanoBanana2T2I(makeArgs({
      subjectRenderMode: "t2i_fallback",
      prompt: "M.C. Hammer dances on stage in his trademark pants.",
      fallbackSubjectGender: "male",
    }));
    assert.match(out.imagePrompt, /M\.C\. Hammer/);
    // The old splitter dropped the leading "M." and left a bare "C. Hammer".
    assert.doesNotMatch(out.imagePrompt, /(^|[^.A-Za-z])C\. Hammer/);
  });

  it("preserves an initialism while still splitting real sentence boundaries", () => {
    const out = compileNanoBanana2T2I(makeArgs({
      subjectRenderMode: "t2i_fallback",
      prompt: "J.R.R. Tolkien writes at a cluttered desk. A pipe rests beside the manuscript.",
      fallbackSubjectGender: "male",
    }));
    assert.match(out.imagePrompt, /J\.R\.R\. Tolkien/);
    // Both real sentences' content survives (dedup/fit still operate per-sentence).
    assert.match(out.imagePrompt.toLowerCase(), /cluttered desk/);
    assert.match(out.imagePrompt.toLowerCase(), /pipe rests beside the manuscript/);
  });
});

describe("nanoBanana2 — subject binding (de-aging fix)", () => {
  it("binds the reference person to the transformed life stage from an age modifier", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "Baby drives a car with his surprised mother beside him.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["baby_child_version"],
    }));
    assert.match(out.imagePrompt, /SUBJECT BINDING:/);
    assert.match(out.imagePrompt, /The reference person is David\./);
    assert.match(out.imagePrompt, /David is a baby\/young child in this scene\./);
    assert.match(out.imagePrompt, /Render exactly one David\./);
    assert.match(out.imagePrompt, /The transformed baby\/young child IS David/);
  });

  it("prefers the LLM-provided targetState over the modifier default", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "An infant drives a car.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["age_transform"],
      visualPlan: {
        subjectTreatment: {
          ...makeVisualPlan().subjectTreatment,
          ageLifeStageTransform: { applies: true, targetState: "a newborn infant" },
        },
      },
    }));
    assert.match(out.imagePrompt, /David is a newborn infant in this scene\./);
  });

  it("emits anti-entity-split constraints for age transforms", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "An infant drives a car with his surprised mother beside him.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["baby_child_version"],
    }));
    assert.match(out.imagePrompt.toLowerCase(), /do not render the adult reference person separately/);
    assert.match(out.imagePrompt.toLowerCase(), /do not add a second, generic baby\/young child/);
    assert.match(out.imagePrompt.toLowerCase(), /do not show both an adult david and a baby\/young child/);
  });

  it("age modifiers stay a loud de-aging binding, now owned solely by SUBJECT BINDING (no modifier prose)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "An infant drives a car.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["baby_child_version"],
    }));
    // SUBJECT BINDING carries the de-aging fusion (the sole compiled owner now
    // that the modifier→prose channel is gone).
    assert.match(out.imagePrompt.toLowerCase(), /the same person de-aged or aged, not a second person/);
    // The retired modifier-directive prose is gone.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /de-age the reference subject into the baby\/child/);
  });

  it("emits a single-instance binding for avoid_duplicate_subject without an age transform", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David shakes hands with his twin brother.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["avoid_duplicate_subject"],
    }));
    assert.match(out.imagePrompt, /SUBJECT BINDING:/);
    assert.match(out.imagePrompt, /Render exactly one David — a single instance\./);
    assert.match(out.imagePrompt.toLowerCase(), /do not duplicate, clone, or mirror david/);
  });

  it("does not emit person/adult de-aging language for a non-human subject with an age modifier", () => {
    const out = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i",
      prompt: "A tabby kitten bats at a ball of yarn.",
      renderedSubject: { name: "Whiskers", pronouns: "it/its" },
      modifiers: ["age_transform"],
      visualPlan: {
        subjectTreatment: {
          ...makeVisualPlan().subjectTreatment,
          subjectRenderMode: "nonhuman_subject_i2i",
          identityPreservation: "nonhuman_visual_identity",
          nonhumanSubjectTreatment: {
            applicable: true,
            subjectKind: "animal_subject",
            preserveTraits: ["tabby markings"],
            anthropomorphicTreatment: "none",
            doNotTransformIntoHuman: true,
          },
        },
      },
    }));
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /the reference person is/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /adult version/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /\badult\b/);
    // The age transform still compiles loudly — now via mode-appropriate SUBJECT
    // BINDING single-entity wording (the sole compiled owner), not modifier prose.
    assert.match(out.imagePrompt, /SUBJECT BINDING:/);
    assert.match(out.imagePrompt.toLowerCase(), /the same subject rendered at that life stage, not a different individual/);
  });

  it("omits SUBJECT BINDING entirely for a plain non-transform fact", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David deadlifts a bus on a city street.",
      renderedSubject: { name: "David", pronouns: "he/him" },
    }));
    assert.doesNotMatch(out.imagePrompt, /SUBJECT BINDING:/);
  });
});

describe("nanoBanana2 — intent-language scrub", () => {
  it("keeps the concrete clause and drops the authorial-intent clause", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David grips the wheel with both hands, showcasing the absurdity of the situation. The dashboard is covered in toys.",
    }));
    assert.match(out.imagePrompt, /David grips the wheel with both hands/);
    assert.match(out.imagePrompt.toLowerCase(), /the dashboard is covered in toys/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /showcasing the absurdity/);
  });

  it("drops a sentence that is entirely commentary", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A toddler sits in the driver's seat. This emphasizes the humor of the role reversal.",
    }));
    assert.match(out.imagePrompt.toLowerCase(), /a toddler sits in the driver's seat/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /emphasizes the humor/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /humorous contrast/);
  });

  it("scrubs intent commentary from structured subjectDetails entries", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A scene.",
      visualPlan: {
        subjectDetails: ["chubby infant cheeks and wispy hair", "an exaggerated grin highlighting the absurdity"],
      },
    }));
    assert.match(out.imagePrompt.toLowerCase(), /chubby infant cheeks and wispy hair/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /highlighting the absurdity/);
  });
});

describe("nanoBanana2 — preamble + identity guards", () => {
  const LLM_NONHUMAN_PROMPT =
    "An orange tabby cat performs a pushup on cracked ground. " +
    "The ground visibly compresses downward, with dust ripples and nearby objects tilting slightly from the force.";

  it("nonhuman: prepends the i2i lead with the human guard exactly once", () => {
    const out = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i",
      prompt: LLM_NONHUMAN_PROMPT,
    }));
    assert.match(out.imagePrompt.toLowerCase(), /image-to-image edit using the reference image/);
    assert.equal(countOccurrences(out.imagePrompt, "do not replace the subject with a human"), 1, out.imagePrompt);
  });

  it("t2i: bakes in fallback gender once, no i2i identity language, no reference url", () => {
    const out = compileNanoBanana2T2I(makeArgs({
      subjectRenderMode: "t2i_fallback",
      prompt: "A protagonist lifts a mountain.",
      fallbackSubjectGender: "female",
    }));
    // t2i leads with the scene; the render-task clause is brief and has no
    // reference-photo/identity language.
    assert.match(out.imagePrompt.toLowerCase(), /text-to-image generation: render an original protagonist/);
    assert.match(out.imagePrompt, /RENDER TASK:/);
    assert.match(out.imagePrompt.toLowerCase(), /female/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /reference image/);
    assert.equal(out.referenceImageUrl, undefined);
  });

  it("dispatches by subjectRenderMode", () => {
    const out = compileForSubjectRenderMode(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i",
      prompt: LLM_NONHUMAN_PROMPT,
    }));
    assert.equal(countOccurrences(out.imagePrompt, "do not replace the subject with a human"), 1, out.imagePrompt);
  });
});

describe("nanoBanana2 — structured directive injection", () => {
  it("injects key visual elements the scene omitted, and does not duplicate present ones", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands in a thunderstorm.",
      visualPlan: { keyVisualElements: ["a thunderstorm", "a glowing trophy", "a roaring crowd"] },
    }));
    assert.match(out.imagePrompt, /Ensure these elements are clearly visible:/);
    assert.match(out.imagePrompt.toLowerCase(), /glowing trophy/);
    assert.match(out.imagePrompt.toLowerCase(), /roaring crowd/);
    assert.equal(countOccurrences(out.imagePrompt, "a thunderstorm"), 1, out.imagePrompt);
  });

  it("injects composition framing/camera + caption negative space", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
      visualPlan: {
        composition: { subjectFraming: "low-angle hero shot", negativeSpace: "bottom", cameraStyle: "anamorphic 35mm", sceneReadability: "clear" },
      },
    }));
    assert.match(out.imagePrompt, /COMPOSITION:/);
    assert.match(out.imagePrompt.toLowerCase(), /low-angle hero shot/);
    assert.match(out.imagePrompt.toLowerCase(), /anamorphic 35mm/);
    assert.match(out.imagePrompt.toLowerCase(), /negative space at the bottom/);
  });

  it("single-channel style: LIGHTING carries only light/mood, style goes to its own RENDER STYLE section", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
      stylePrompt: "in a painterly oil style",
      visualPlan: { lightingAndStyle: "warm golden-hour rim light" },
    }));
    // LIGHTING (renamed from LIGHTING AND STYLE) holds the physical light only…
    assert.match(out.imagePrompt, /LIGHTING:/);
    assert.match(out.imagePrompt.toLowerCase(), /warm golden-hour rim light/);
    // …and the selected style is its OWN section, not folded into lighting.
    assert.match(out.imagePrompt, /RENDER STYLE: in a painterly oil style/);
    assert.doesNotMatch(out.imagePrompt, /LIGHTING AND STYLE/);
  });

  it("emits the photorealistic default RENDER STYLE when no style is selected", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
      stylePrompt: "",
      visualPlan: { lightingAndStyle: "warm golden-hour rim light" },
    }));
    assert.match(out.imagePrompt, /RENDER STYLE: Photorealistic rendering:/);
  });

  it("renders the planner's in-scene text and excludes overlay text (no blanket ban)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David at a scoreboard.",
      visualPlan: {
        supportingTextPolicy: {
          allowSupportingText: true,
          supportingTextElements: [{ content: "999", kind: "literal_text", purpose: "score", placement: "on the scoreboard" }],
          forbiddenTextTypes: [],
        },
      },
    }));
    assert.match(out.imagePrompt, /Render this in-scene text clearly: "999" \(on the scoreboard\)/);
    // Narrow overlay-text exclusion is present; the old blanket "free of readable
    // text" ban is gone (it would contradict the rendered scoreboard text).
    assert.match(out.imagePrompt.toLowerCase(), /do not bake overlay or caption text into the image/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /free of readable text/);
  });

  it("does NOT emit a blanket no-readable-text ban under the default allow policy", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
    }));
    // The narrow overlay exclusion is always present, but in-world text is
    // allowed silently — no "keep all surfaces free of readable text" line.
    assert.match(out.imagePrompt.toLowerCase(), /do not bake overlay or caption text into the image/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /free of readable text/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /avoid readable in-scene text/);
  });

  it("feeds the resolved semantic referent as a concrete element, NOT an 'interpret X means Y' meta line", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands triumphant.",
      visualPlan: {
        // coreScene omits the planet — the gap-fill must guarantee it reaches the engine.
        coreScene: "David stands triumphant on a cliff.",
        keyVisualElements: ["a triumphant pose", "a cliff edge", "dramatic light"],
        semanticEntitiesUsed: [{ surfaceText: "Earth", visualReferentUsed: "the planet Earth seen from orbit", effectOnVisualPlan: "sets cosmic scale" }],
      },
    }));
    // No interpretation meta.
    assert.doesNotMatch(out.imagePrompt, /Interpret these terms exactly/);
    assert.doesNotMatch(out.imagePrompt, /"Earth" means/);
    // The resolved referent reaches the engine as a concrete visible element.
    assert.match(out.imagePrompt, /Ensure these elements are clearly visible:[^]*the planet Earth seen from orbit/);
  });

  it("cultural reference: the concrete visual reaches the engine, the meta/brand does NOT (safety net)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David on a beach.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        // A generic scene that does NOT bake in the gag — the gap-fill is the only
        // guarantee the implication survives (the validator doesn't enforce baking).
        coreScene: "David stands on a sunny beach.",
        keyVisualElements: ["a sunny beach", "blue sky", "David smiling"],
        culturalReferencesUsed: [{
          sourcePhrase: "Shark Week",
          canonicalReferenceUsed: "Discovery Channel's Shark Week",
          visualImplicationUsed: "sharks circling on a TV screen behind David",
          effectOnVisualPlan: "adds the gag",
        }],
      },
    }));
    // The canonical-reference explanation + brand name must NOT reach the engine.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /treat "shark week" as/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /discovery channel/);
    assert.doesNotMatch(out.imagePrompt, /Cultural references:/);
    // …but the concrete visual implication still reaches the engine (the gag survives).
    assert.match(out.imagePrompt, /Ensure these elements are clearly visible:[^]*sharks circling on a TV screen behind David/);
  });

  it("does not duplicate a cultural visual the scene already states (dedupe)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "Sharks watch David.",
      visualPlan: {
        coreScene: "Sharks circling on a TV screen behind David.",
        keyVisualElements: ["a TV screen", "blue water", "shark fins"],
        culturalReferencesUsed: [{
          sourcePhrase: "Shark Week",
          canonicalReferenceUsed: "Discovery Channel's Shark Week",
          visualImplicationUsed: "sharks circling on a TV screen behind David",
          effectOnVisualPlan: "adds the gag",
        }],
      },
    }));
    assert.equal(countOccurrences(out.imagePrompt, "sharks circling on a TV screen behind David"), 1, out.imagePrompt);
  });

  it("does NOT inject modifier prose into the compiled prompt (the planner owns staging)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands.",
      modifiers: ["mock_heroic", "object_transformation", "metaphorical_visualization"],
    }));
    const lower = out.imagePrompt.toLowerCase();
    // None of the retired modifier-directive sentences appear.
    assert.doesNotMatch(lower, /mock-heroic pose/);
    assert.doesNotMatch(lower, /object mid-transformation/);
    assert.doesNotMatch(lower, /clear visual metaphor/);
    // And the SUBJECT DETAILS section carries no modifier-derived text — it holds
    // only subject details, expression/pose, and genuine key-element gaps.
    const sd = out.promptBreakdown?.find((s) => s.id === "subject_details");
    const sdText = (sd?.rawText ?? "").toLowerCase();
    assert.doesNotMatch(sdText, /mock-heroic|mid-transformation|visual metaphor/);
  });

  it("crowd_reaction keeps its STRUCTURAL failure-mode guard (not prose injection)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["crowd_reaction"],
    }));
    // The old positive prose ("Include a visible crowd reacting to the subject.")
    // is gone; the conservative failure-mode focal-point guard remains.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /include a visible crowd reacting/);
    assert.match(out.imagePrompt, /the crowd reacts to and supports David rather than replacing David/);
  });

  it("resolves residual identity tokens in emitted elements (keyVisualElements + semantic referent) using renderedSubject", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "Subject stands triumphant.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        coreScene: "A triumphant stance on a cliff.",
        keyVisualElements: ["a trophy", "a spotlight", "{NAME}'s banner overhead"],
        semanticEntitiesUsed: [
          { surfaceText: "Earth", visualReferentUsed: "{NAME} standing on the planet", effectOnVisualPlan: "names the hero" },
        ],
      },
    }));
    // No raw template token reaches the engine, from any emitted source.
    assert.doesNotMatch(out.imagePrompt, /\{NAME\}/);
    assert.match(out.imagePrompt, /David's banner overhead/);
    assert.match(out.imagePrompt, /David standing on the planet/);
  });
});

describe("nanoBanana2 — retired text modifiers are inert (de-scaffolding)", () => {
  it("legacy text/logo modifiers + explicit in-scene text: text survives, zero contradiction", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David holds a diary in a trophy room.",
      modifiers: ["no_readable_text", "avoid_readable_ui", "avoid_real_logos"],
      visualPlan: {
        supportingTextPolicy: {
          allowSupportingText: true,
          supportingTextElements: [
            { content: "My Diary - AKA The Guinness Book of World Records", kind: "literal_text", purpose: "cover", placement: "on the diary cover" },
          ],
          forbiddenTextTypes: [],
        },
      },
    }));
    const lower = out.imagePrompt.toLowerCase();
    // The specimen contradiction can never happen: no blanket text/logo bans.
    assert.doesNotMatch(lower, /free of readable text/);
    assert.doesNotMatch(lower, /keep all surfaces free/);
    assert.doesNotMatch(lower, /on-screen ui abstract/);
    assert.doesNotMatch(lower, /do not depict any real-world logos/);
    // The intentional in-scene text is rendered clearly.
    assert.match(out.imagePrompt, /Render this in-scene text clearly: "My Diary - AKA The Guinness Book of World Records"/);
    // The always-on incidental-text guard is present and yields to it.
    assert.match(lower, /keep incidental background text non-readable/);
  });
});

describe("nanoBanana2 — always-on incidental-text guard (yields to intentional text)", () => {
  const GUARD = /keep incidental background text non-readable/;

  function textPolicyOut(opts: Partial<Parameters<typeof makeArgs>[0]> = {}) {
    return compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
      ...opts,
    }));
  }

  it("allow, no guidance: guard present, no in-scene-text directive, no contradiction", () => {
    const out = textPolicyOut({});
    assert.match(out.imagePrompt.toLowerCase(), GUARD);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /free of readable text/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /avoid readable in-scene text/);
  });

  it("allow + guidance: guidance emitted and the guard yields to it", () => {
    const out = textPolicyOut({
      renderPolicy: { supportingText: { mode: "allow", guidance: 'a banner reading "CHAMP"' }, violence: { mode: "allow", intensity: "strong" } },
    });
    assert.match(out.imagePrompt, /a banner reading "CHAMP"/);
    assert.match(out.imagePrompt.toLowerCase(), GUARD);
  });

  it("require: required-text line and guard coexist", () => {
    const out = textPolicyOut({
      renderPolicy: { supportingText: { mode: "require", guidance: "a scoreboard reading 100" }, violence: { mode: "allow", intensity: "strong" } },
    });
    assert.match(out.imagePrompt, /Readable in-scene text is required/);
    assert.match(out.imagePrompt.toLowerCase(), GUARD);
  });

  it("forbid: the avoid line and the guard coexist", () => {
    const out = textPolicyOut({
      renderPolicy: { supportingText: { mode: "forbid" }, violence: { mode: "allow", intensity: "strong" } },
    });
    assert.match(out.imagePrompt.toLowerCase(), /avoid readable in-scene text unless required/);
    assert.match(out.imagePrompt.toLowerCase(), GUARD);
  });

  it("explicit supportingTextElements: rendered, guard present, no contradiction", () => {
    const out = textPolicyOut({
      visualPlan: { supportingTextPolicy: { allowSupportingText: true, supportingTextElements: [{ content: "999", kind: "literal_text", purpose: "score", placement: "on the scoreboard" }], forbiddenTextTypes: [] } },
    });
    assert.match(out.imagePrompt, /Render this in-scene text clearly: "999"/);
    assert.match(out.imagePrompt.toLowerCase(), GUARD);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /free of readable text/);
  });

  it("routes kind=visual_graphic UNQUOTED (never baked in as literal words) while literal_text stays quoted", () => {
    const out = textPolicyOut({
      visualPlan: {
        supportingTextPolicy: {
          allowSupportingText: true,
          supportingTextElements: [
            { content: "COBRA", kind: "literal_text", purpose: "toe tag", placement: "on the tag" },
            { content: "a flat, flatlined heart-monitor trace", kind: "visual_graphic", purpose: "monitor", placement: "on the screen" },
          ],
          forbiddenTextTypes: [],
        },
      },
    });
    // literal glyphs are quoted for exact rendering…
    assert.match(out.imagePrompt, /Render this in-scene text clearly: "COBRA"/);
    // …but the graphic is emitted unquoted as a visual, so the words are not baked in.
    assert.match(out.imagePrompt, /Depict these as visuals, not as written words: a flat, flatlined heart-monitor trace/);
    assert.doesNotMatch(out.imagePrompt, /"a flat, flatlined heart-monitor trace"/);
  });

  it("is compiler-owned: present in the prompt, never counted as stripped planner prose", () => {
    const out = textPolicyOut({});
    assert.match(out.imagePrompt.toLowerCase(), GUARD);
    const removed = out.diagnostics?.removedPlannerProseSentences ?? [];
    assert.ok(removed.every((r) => !/incidental background text/i.test(r.sentence)), "guard must not be stripped");
  });
});

describe("nanoBanana2 — age-transform SUBJECT BINDING across all render modes", () => {
  it("t2i: single-entity life-stage wording, no reference-photo vocabulary", () => {
    const out = compileNanoBanana2T2I(makeArgs({
      subjectRenderMode: "t2i_fallback",
      prompt: "A baby wins a Nobel Prize.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      fallbackSubjectGender: "male",
      modifiers: ["baby_child_version"],
      visualPlan: { subjectTreatment: { ...makeVisualPlan().subjectTreatment, subjectRenderMode: "t2i_fallback" } },
    }));
    assert.match(out.imagePrompt, /SUBJECT BINDING:/);
    assert.match(out.imagePrompt.toLowerCase(), /david is a baby\/young child in this scene — the same subject rendered at that life stage, not a different individual/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /the reference person is/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /reference photo|reference image/);
  });
});

describe("nanoBanana2 — key-element gap-fill (content-word coverage)", () => {
  function gapOut(keyVisualElements: string[], coreScene = "") {
    return compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: coreScene || "David stands.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: { coreScene, keyVisualElements },
    }));
  }

  it("suppresses an element already covered by scattered content words", () => {
    const out = gapOut(["TV screen"], "A large TV screen glows behind David.");
    assert.equal(countOccurrences(out.imagePrompt.toLowerCase(), "tv screen"), 1, out.imagePrompt);
  });

  it("emits short title/number elements that are genuinely absent", () => {
    const out = gapOut(["My Diary", "999"], "David stands in a room.");
    assert.match(out.imagePrompt, /Ensure these elements are clearly visible:/);
    assert.match(out.imagePrompt, /My Diary/);
    assert.match(out.imagePrompt, /999/);
  });

  it("treats singular/plural as covered (naive plural strip)", () => {
    const out = gapOut(["shark fins"], "A shark fin cuts the water behind David.");
    assert.doesNotMatch(out.imagePrompt, /shark fins/);
  });

  it("does not treat 'earth' as covered by 'earthquake' (word boundary, not substring)", () => {
    const out = gapOut(["earth"], "An earthquake rattles the city behind David.");
    assert.match(out.imagePrompt, /Ensure these elements are clearly visible: earth\./);
  });

  it("first emitted element suppresses a near-duplicate second (local haystack)", () => {
    const out = gapOut(["a large golden championship trophy", "a golden trophy"]);
    assert.match(out.imagePrompt, /Ensure these elements are clearly visible: a large golden championship trophy\./);
  });
});

describe("nanoBanana2 — render policy (supporting text + violence)", () => {
  // ── Supporting text ──────────────────────────────────────────────────────

  it("require mode emits a required in-scene text line with the policy guidance", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "Sharks circle on a TV.",
      renderPolicy: {
        supportingText: { mode: "require", guidance: 'the TV title "Shark Week" shown clearly on screen' },
        violence: { mode: "allow", intensity: "strong" },
      },
    }));
    assert.match(out.imagePrompt, /SUPPORTING TEXT: Readable in-scene text is required/);
    assert.match(out.imagePrompt, /the TV title "Shark Week" shown clearly on screen/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /free of readable text/);
  });

  it("require mode renders {NAME} tokens in the guidance via renderedSubject", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "Sharks circle on a TV.",
      renderedSubject: { name: "David Franklin", pronouns: "he/him" },
      renderPolicy: {
        supportingText: { mode: "require", guidance: 'the title "{NAME} Week: Capturing the World\'s Deadliest Predator"' },
        violence: { mode: "allow", intensity: "strong" },
      },
    }));
    assert.match(out.imagePrompt, /"David Franklin Week: Capturing the World's Deadliest Predator"/);
    assert.doesNotMatch(out.imagePrompt, /\{NAME\}/);
  });

  it("forbid mode emits an avoid-in-scene-text line (only when explicitly selected)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
      renderPolicy: {
        supportingText: { mode: "forbid" },
        violence: { mode: "allow", intensity: "strong" },
      },
    }));
    assert.match(out.imagePrompt.toLowerCase(), /avoid readable in-scene text unless required/);
  });

  // ── Violence ─────────────────────────────────────────────────────────────

  it("emits NO violence permission line for a non-violent fact under the default policy", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David solves an impossible equation on a chalkboard.",
      factText: "David is so smart he solved an unsolvable equation.",
    }));
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /requires violence, death, weapons, or destruction/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /soften violent consequences/);
  });

  it("emits the self-conditioned violence permission line for a violent fact (default policy)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "Fifty soldiers lie on the ground as a grenade explodes behind David.",
      factText: "David threw a grenade and killed 50 people, then it exploded.",
      visualPlan: { coreScene: "Fifty bodies lie on the ground; a grenade explodes in the distance." },
    }));
    assert.match(
      out.imagePrompt,
      /When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore\./,
    );
    // The violent scene survives — not sanitized into a harmless one.
    assert.match(out.imagePrompt.toLowerCase(), /fifty bodies lie on the ground/);
  });

  it("a violent fact gets the allow line by default with no auto-sanitizer (softening modifiers retired)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David throws a grenade.",
      factText: "David threw a grenade and killed 50 people.",
      modifiers: ["projectile_impact_power"],
    }));
    // The permission line is asserted, and NO self-censoring sanitizer leaks in.
    assert.match(out.imagePrompt, /requires violence, death, weapons, or destruction/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /clean and non-graphic|no gore or blood|no bodies\b|but no bodies or gore are depicted/);
  });

  it("avoid_gross_literalization no longer suppresses the violence allow line (Choice B)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David throws a grenade.",
      factText: "David threw a grenade and killed 50 people.",
      modifiers: ["projectile_impact_power", "avoid_gross_literalization"],
    }));
    assert.match(out.imagePrompt, /requires violence, death, weapons, or destruction/);
  });

  it("soften / suppress modes emit their line only when explicitly selected", () => {
    const soften = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David throws a grenade.",
      factText: "David threw a grenade and killed 50 people.",
      renderPolicy: {
        supportingText: { mode: "allow" },
        violence: { mode: "soften", intensity: "mild" },
      },
    }));
    assert.match(soften.imagePrompt.toLowerCase(), /soften violent consequences/);

    const suppress = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David throws a grenade.",
      factText: "David threw a grenade and killed 50 people.",
      renderPolicy: {
        supportingText: { mode: "allow" },
        violence: { mode: "suppress", intensity: "nonviolent" },
      },
    }));
    assert.match(suppress.imagePrompt.toLowerCase(), /do not depict violence, injury, or death directly/);
    // Coherence: a suppress override never also emits the allow permission line.
    assert.doesNotMatch(suppress.imagePrompt, /requires violence, death, weapons, or destruction/);
  });
});

describe("nanoBanana2 — moderator visual-strategy override (Phase 2)", () => {
  type OverridePartial = Record<string, unknown>;
  function makeOverride(partial: OverridePartial = {}): OverridePartial {
    return {
      version: 1,
      enabled: true,
      requiredVisualDetails: [],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
      ...partial,
    };
  }

  it("disabled override does not add override sections", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David lifts a car.",
      override: makeOverride({ enabled: false, requiredVisualDetails: ["a glowing aura"] }),
    }));
    assert.doesNotMatch(out.imagePrompt, /REQUIRED VISUAL DETAILS/);
    assert.doesNotMatch(out.imagePrompt, /SUBJECT REALIZATION/);
  });

  it("enabled override emits REQUIRED VISUAL DETAILS", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David lifts a car.",
      override: makeOverride({ requiredVisualDetails: ["baby-sized hands on the steering wheel", "hospital pickup area outside"] }),
    }));
    assert.match(out.imagePrompt, /REQUIRED VISUAL DETAILS: baby-sized hands on the steering wheel; hospital pickup area outside\./);
  });

  it("forbidden details + negative additions become STRICT 'Do not' lines without double-prefixing", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David drives.",
      override: makeOverride({
        forbiddenVisualDetails: ["a separate adult version", "Do not put the baby in a car seat"],
        negativePromptAdditions: ["Avoid splattery horror gore"],
      }),
    }));
    assert.match(out.imagePrompt, /Do not a separate adult version\./);
    assert.match(out.imagePrompt, /Do not put the baby in a car seat\./);
    assert.match(out.imagePrompt, /Avoid splattery horror gore\./);
    assert.doesNotMatch(out.imagePrompt, /Do not Do not/i);
    assert.doesNotMatch(out.imagePrompt, /Do not Avoid/i);
  });

  it("does not double-prefix a forbidden line that already starts with a curly-apostrophe Don't", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A scene.",
      override: makeOverride({ forbiddenVisualDetails: ["Don’t render any other text besides what is asked for"] }),
    }));
    assert.match(out.imagePrompt, /Don’t render any other text besides what is asked for\./);
    assert.doesNotMatch(out.imagePrompt, /Do not Don’t/);
  });

  it("subject realization ADDS a SUBJECT REALIZATION block but keeps the SUBJECT BINDING identity guard", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David as a baby drives.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["infant_version"],
      override: makeOverride({
        subjectRealizationOverride: {
          mode: "adult_head_on_transformed_body",
          description: "tiny newborn baby body with David's recognizable adult head composited on",
        },
      }),
    }));
    assert.match(out.imagePrompt, /SUBJECT REALIZATION: tiny newborn baby body with David's recognizable adult head composited on\./);
    // Compiler-owned identity binding is NOT removed (R2).
    assert.match(out.imagePrompt, /SUBJECT BINDING: The reference person is David\./);
    assert.match(out.imagePrompt, /Render exactly one David/);
  });

  it("use_ai_plan realization emits no SUBJECT REALIZATION block but still applies other override fields", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands.",
      override: makeOverride({
        subjectRealizationOverride: { mode: "use_ai_plan", description: "" },
        requiredVisualDetails: ["a golden trophy"],
      }),
    }));
    assert.doesNotMatch(out.imagePrompt, /SUBJECT REALIZATION/);
    assert.match(out.imagePrompt, /REQUIRED VISUAL DETAILS: a golden trophy\./);
  });

  it("role bindings feed ROLE DETAILS (subject + secondary), bare-predicate subject bound with 'is'", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A car scene.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      override: makeOverride({
        roleBindings: [
          { entity: "subject", visualRole: "newborn baby-bodied driver gripping the wheel" },
          { entity: "mother", visualRole: "adult woman in the passenger seat, surprised and amused" },
        ],
      }),
    }));
    assert.match(out.imagePrompt, /ROLE DETAILS:/);
    // A bare-predicate subject role (no leading name) still gets the "is" binding.
    assert.match(out.imagePrompt, /David is newborn baby-bodied driver gripping the wheel/);
    assert.match(out.imagePrompt, /mother: adult woman in the passenger seat, surprised and amused/);
  });

  it("moderator roleBindings mark ROLE DETAILS required + non-compressible, surviving the char budget", () => {
    // Distinct-content-word filler so additive de-dupe can't collapse it — the
    // point here is budget pressure, not de-duplication.
    const filler = Array.from(
      { length: 120 },
      (_, i) => `vivid${i} tableau${i} of glimmer${i} artifacts arranged in baroque${i} symmetry${i}`,
    );
    const roleBindings = [
      { entity: "subject", visualRole: "newborn baby-bodied driver gripping the wheel" },
      { entity: "mother", visualRole: "adult woman in the passenger seat, surprised and amused" },
    ];
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A car scene.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: { subjectDetails: filler, environment: filler },
      override: makeOverride({ roleBindings }),
    }));
    assert.equal(out.imagePrompt.length <= 4000, true, `prompt length ${out.imagePrompt.length}`);
    assert.match(out.imagePrompt, /David is newborn baby-bodied driver gripping the wheel/);
    assert.match(out.imagePrompt, /mother: adult woman in the passenger seat, surprised and amused/);
    const roleDetails = out.promptBreakdown?.find((s) => s.id === "role_details");
    assert.equal(roleDetails?.priority, "required");
    assert.equal(roleDetails?.status, "included");
    assert.equal(roleDetails?.moderatorAuthored, true);
  });

  it("caps ROLE DETAILS' own contribution when many moderator roleBindings would otherwise overflow it, keeping STRICT CONSTRAINTS intact", () => {
    // Up to 20 roleBindings are allowed (schema cap); each visualRole can be up
    // to 300 chars (schema cap). Distinct content words per entry so additive
    // de-dupe can't collapse them — the point is the section's own char cap,
    // not de-duplication.
    const roleBindings = Array.from({ length: 18 }, (_, i) => ({
      entity: `character${i}`,
      visualRole: `a distinctive figure${i} wearing ornate${i} regalia${i} and gesturing dramatically${i} toward the impossible${i} scene while onlookers${i} gasp in astonishment${i} at the display${i}`,
    }));
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A crowded scene.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      override: makeOverride({ roleBindings }),
    }));
    assert.equal(out.imagePrompt.length <= 4000, true, `prompt length ${out.imagePrompt.length}`);
    const roleDetails = out.promptBreakdown?.find((s) => s.id === "role_details");
    assert.equal(roleDetails?.priority, "required");
    assert.equal(roleDetails?.status, "included");
    assert.ok((roleDetails?.text.length ?? 0) <= 1000, `role details length ${roleDetails?.text.length}`);
    assert.match(String(out.engineNotes ?? ""), /Capped role_details/);
    // The safety property this cap protects: STRICT CONSTRAINTS (violence /
    // text-policy / anti-split guardrails) still lands even though ROLE
    // DETAILS is also required + non-compressible.
    const strict = out.promptBreakdown?.find((s) => s.id === "strict_constraints");
    assert.equal(strict?.status, "included");
  });

  it("purely AI-authored role details stay high + compressible (no moderatorAuthored flag)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David ejects a referee from the field.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        subjectTreatment: { ...makeVisualPlan().subjectTreatment, roleInScene: "the authority figure pointing the referee off the field" },
        secondaryCharacters: [{ label: "the referee", visualRole: "a separate official walking away, protesting" }],
      },
    }));
    const roleDetails = out.promptBreakdown?.find((s) => s.id === "role_details");
    assert.equal(roleDetails?.priority, "high");
    assert.equal(roleDetails?.moderatorAuthored, undefined);
  });

  it("composition guidance feeds COMPOSITION", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A car scene.",
      override: makeOverride({ compositionGuidance: ["frame through the windshield so the adult face is unmistakable"] }),
    }));
    assert.match(out.imagePrompt, /COMPOSITION:[^]*frame through the windshield so the adult face is unmistakable/);
  });

  it("style-agnostic additions feed ADDITIONAL DETAILS", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A scene.",
      override: makeOverride({ styleAgnosticPromptAdditions: ["dramatic rim lighting on the subject"] }),
    }));
    assert.match(out.imagePrompt, /ADDITIONAL DETAILS: dramatic rim lighting on the subject\./);
  });

  it("a moderator violence override's guidance governs the violence directive", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David throws a grenade.",
      factText: "David threw a grenade and killed 50 people.",
      modifiers: ["projectile_impact_power"],
      // resolveRenderPolicy runs upstream in production; simulate its result here.
      renderPolicy: {
        supportingText: { mode: "allow" },
        violence: { mode: "allow", intensity: "strong", guidance: "Visible bodies and lethal aftermath are required; action-hero styled, non-gratuitous." },
      },
      override: makeOverride({
        violencePolicyOverride: { mode: "allow", intensity: "strong", guidance: "Visible bodies and lethal aftermath are required; action-hero styled, non-gratuitous." },
      }),
    }));
    assert.match(out.imagePrompt, /Visible bodies and lethal aftermath are required/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /clean and non-graphic|no gore or blood/);
  });

  it("renders {NAME} tokens in EVERY override-derived section and leaves no unresolved tokens", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A scene.",
      renderedSubject: { name: "David Franklin", pronouns: "he/him" },
      renderPolicy: {
        supportingText: { mode: "require", guidance: 'a TV title reading "{NAME} Week"' },
        violence: { mode: "allow", intensity: "strong", guidance: "{NAME} stands over the aftermath" },
      },
      override: makeOverride({
        subjectRealizationOverride: { mode: "custom", description: "{NAME} composited onto a tiny body" },
        requiredVisualDetails: ["{NAME}'s recognizable face"],
        forbiddenVisualDetails: ["a separate adult {NAME}"],
        roleBindings: [{ entity: "subject", visualRole: "{NAME} as the driver" }],
        compositionGuidance: ["keep {NAME}'s face centered"],
        styleAgnosticPromptAdditions: ["a poster of {NAME} on the wall"],
        supportingTextPolicyOverride: { mode: "require", guidance: 'a TV title reading "{NAME} Week"' },
        violencePolicyOverride: { mode: "allow", intensity: "strong", guidance: "{NAME} stands over the aftermath" },
      }),
    }));
    // Every section rendered the token to the subject; none leaked.
    assert.doesNotMatch(out.imagePrompt, /\{NAME\}/);
    assert.match(out.imagePrompt, /David Franklin composited onto a tiny body/);     // SUBJECT REALIZATION
    assert.match(out.imagePrompt, /David Franklin's recognizable face/);             // REQUIRED VISUAL DETAILS
    assert.match(out.imagePrompt, /Do not a separate adult David Franklin/);         // STRICT CONSTRAINTS
    assert.match(out.imagePrompt, /David Franklin as the driver/);                   // ROLE DETAILS (name-led role, as-is)
    // Regression: a subject roleBinding that already names the subject must NOT
    // double the name ("David Franklin is David Franklin as the driver").
    assert.doesNotMatch(out.imagePrompt, /David Franklin is David Franklin/);
    assert.match(out.imagePrompt, /keep David Franklin's face centered/);            // COMPOSITION
    assert.match(out.imagePrompt, /a poster of David Franklin on the wall/);         // ADDITIONAL DETAILS
    assert.match(out.imagePrompt, /a TV title reading "David Franklin Week"/);       // SUPPORTING TEXT
    assert.match(out.imagePrompt, /David Franklin stands over the aftermath/);       // VIOLENCE
  });

  it("renders {NAME_POSSESSIVE} in an override-derived section (always 's, no residual token)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A scene.",
      renderedSubject: { name: "Chris", pronouns: "he/him" },
      renderPolicy: {
        supportingText: { mode: "require", guidance: 'a TV title reading "{NAME_POSSESSIVE} Week"' },
        violence: { mode: "suppress", intensity: "nonviolent" },
      },
      override: makeOverride({
        requiredVisualDetails: ["{NAME_POSSESSIVE} recognizable face"],
      }),
    }));
    assert.doesNotMatch(out.imagePrompt, /\{NAME_POSSESSIVE\}/);
    // Possessive always appends 's, even for an s-ending name.
    assert.match(out.imagePrompt, /Chris's recognizable face/);
    assert.match(out.imagePrompt, /a TV title reading "Chris's Week"/);
  });
});

describe("nanoBanana2 — prompt component breakdown", () => {
  it("returns a per-section breakdown keyed by the contract sections, with no strategic-intent", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands in a thunderstorm.",
      visualPlan: {
        visualGoal: "Make the feat feel legendary",
        visualApproach: "Ground it in cinematic framing",
        keyVisualElements: ["a thunderstorm", "a glowing trophy"],
      },
    }));
    const bd = out.promptBreakdown;
    assert.ok(bd && bd.length > 0, "promptBreakdown present");
    const byId = Object.fromEntries(bd!.map((s) => [s.id, s]));

    // No abstract strategic-intent component anymore.
    assert.equal(byId["strategic_intent"], undefined);
    assert.equal(byId["visual_goal"], undefined);

    // CORE SCENE leads; the identity clause (mode-aware id) is required + present.
    assert.equal(byId["core_scene"]?.status, "included");
    assert.equal(byId["identity_reference"]?.priority, "required");
    assert.equal(byId["identity_reference"]?.status, "included");
    assert.equal(byId["strict_constraints"]?.priority, "required");

    // Concatenating the included/compressed section texts reproduces the prompt.
    const reassembled = bd!
      .filter((s) => s.status === "included" || s.status === "compressed")
      .map((s) => s.text)
      .join(" ");
    assert.equal(reassembled, out.imagePrompt);
  });

  it("strips identity-preservation, reference-image, token, and text-policy clauses from the scene prose", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      renderedSubject: { name: "David", pronouns: "he/him" },
      prompt:
        "Superman wears David pajamas in a city skyline. " +
        "Ensure Superman's recognizable face is preserved. " +
        "Use the uploaded image as the identity source. " +
        'Interpret these terms exactly: "{NAME}" means user\'s name. ' +
        "Keep all surfaces free of readable text, watermarks, and logos.",
    }));
    const removed = out.diagnostics?.removedPlannerProseSentences ?? [];
    const reasons = new Set(removed.map((r) => r.reason));
    assert.ok(reasons.has("identity-preservation-owned-by-compiler"), JSON.stringify(removed));
    assert.ok(reasons.has("reference-image-owned-by-compiler"), JSON.stringify(removed));
    assert.ok(reasons.has("token-interpretation-owned-by-compiler"), JSON.stringify(removed));
    assert.ok(reasons.has("text-policy-owned-by-compiler"), JSON.stringify(removed));

    // The concrete scene sentence survives.
    assert.match(out.imagePrompt, /Superman wears David pajamas in a city skyline\./);
    // The prose's competing face clause is gone; identity language now comes
    // ONLY from the compiler preamble.
    assert.doesNotMatch(out.imagePrompt, /Superman's recognizable face/);
    assert.doesNotMatch(out.imagePrompt, /\{NAME\}/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /uploaded image as the identity source/);
  });

  it("never sets negativePrompt and keeps required content under an over-long scene", () => {
    const hugeProse = `${"David flexes dramatically. ".repeat(400)}`;
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: hugeProse,
      stylePrompt: "in a painterly oil style",
      negativePrompt: "ignored",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["baby_child_version"],
    }));
    assert.equal(out.imagePrompt.length <= 4000, true, `prompt length ${out.imagePrompt.length}`);
    assert.equal(out.negativePrompt, undefined);
    // Required identity + binding survive even when the scene is enormous.
    assert.match(out.imagePrompt.toLowerCase(), /image-to-image edit using the reference image/);
    assert.match(out.imagePrompt, /The reference person is David\./);
    // Budget pressure should be recorded in engineNotes.
    assert.match(String(out.engineNotes ?? ""), /budget/i);
  });
});

// ── v4 role/action hardening — broad fixture matrix (baby fact is one proving
//    case among several; the others guard against overfitting/regressions). ──

describe("nanoBanana2 — ROLE DETAILS + role binding", () => {
  it("binds the subject's role and each secondary character as a separate role (baby-drives-mom proving case)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A baby grips the steering wheel of a moving car.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["baby_child_version"],
      visualPlan: {
        subjectTreatment: {
          ...makeVisualPlan().subjectTreatment,
          roleInScene: "the newborn baby gripping the steering wheel and driving",
          ageLifeStageTransform: { applies: true, targetState: "a newborn infant" },
        },
        secondaryCharacters: [
          { label: "his mother", visualRole: "a separate adult woman seated in the front passenger seat, looking surprised" },
        ],
      },
    }));
    assert.match(out.imagePrompt, /ROLE DETAILS:/);
    assert.match(out.imagePrompt, /David is the newborn baby gripping the steering wheel and driving\./);
    assert.match(out.imagePrompt.toLowerCase(), /his mother: a separate adult woman seated in the front passenger seat/);
    // Role-swap is blocked + the subject must be actively driving (active frame).
    assert.match(out.imagePrompt.toLowerCase(), /keep each named character in their stated visual role/);
    assert.match(out.imagePrompt.toLowerCase(), /only david performs the central action/);
    assert.match(out.imagePrompt.toLowerCase(), /show david actively performing the central action/);
    // The age-split binding still holds (the mother is NOT a second baby David).
    assert.match(out.imagePrompt, /The transformed newborn infant IS David/);
  });

  it("orders CORE SCENE first, then SUBJECT BINDING, then ROLE DETAILS", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A baby drives a car.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["baby_child_version"],
      visualPlan: {
        secondaryCharacters: [{ label: "his mother", visualRole: "an adult woman in the passenger seat" }],
      },
    }));
    const ids = (out.promptBreakdown ?? []).map((s) => s.id);
    const core = ids.indexOf("core_scene");
    const binding = ids.indexOf("subject_binding");
    const roleDetails = ids.indexOf("role_details");
    assert.ok(core < binding && binding < roleDetails, ids.join(","));
    // CORE SCENE is the very first section.
    assert.equal(ids[0], "core_scene", ids.join(","));
  });

  it("omits ROLE DETAILS for a solo subject on a non-active frame", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands on a quiet hill at dawn.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        archetypeApplication: { ...makeVisualPlan().archetypeApplication, selectedFrame: "implied_aftermath" },
        subjectTreatment: { ...makeVisualPlan().subjectTreatment, roleInScene: "protagonist" },
      },
    }));
    assert.doesNotMatch(out.imagePrompt, /ROLE DETAILS:/);
  });

  it("multi-character authority fact: binds the referee, keeps roles, no false age-split", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David ejects a referee from the field.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        subjectTreatment: { ...makeVisualPlan().subjectTreatment, roleInScene: "the authority figure pointing the referee off the field" },
        secondaryCharacters: [{ label: "the referee", visualRole: "a separate official walking away, protesting" }],
      },
    }));
    assert.match(out.imagePrompt.toLowerCase(), /the referee: a separate official walking away/);
    assert.match(out.imagePrompt.toLowerCase(), /keep each named character in their stated visual role/);
    // No age-split language for a non-transform fact.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /do not render the adult reference person separately/);
  });
});

describe("nanoBanana2 — active-action + soft packs (no overfitting)", () => {
  it("solo active-action fact: emphasizes performing, with no secondary role-lock", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David bench-presses the moon.",
      renderedSubject: { name: "David", pronouns: "he/him" },
    }));
    assert.match(out.imagePrompt.toLowerCase(), /show david actively performing the central action/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /keep each named character in their stated visual role/);
  });

  it("crowd-reaction fact: keeps the subject focal, never forbids the crowd reacting", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David enters a room.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["crowd_reaction"],
    }));
    assert.match(out.imagePrompt.toLowerCase(), /the crowd reacts to and supports david/);
    // It must NOT tell the model the crowd cannot react.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /crowd (?:must not|cannot|should not) react/);
  });

  it("subject-as-object/symbolic fact (non-active frame): no active-action, no role-lock, no duplicate ban", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A wall calendar shows a week labeled in David's honor.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        archetypeApplication: { ...makeVisualPlan().archetypeApplication, selectedFrame: "social_ceremony" },
        subjectTreatment: { ...makeVisualPlan().subjectTreatment, roleInScene: "honoree referenced on the calendar" },
      },
    }));
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /actively performing the central action/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /only david performs the central action/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /duplicate, clone, or mirror/);
  });
});

describe("nanoBanana2 — advisory density warnings + no per-fact hardcoding", () => {
  it("warns (advisory) on a thin core scene without failing compilation", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David runs.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: { coreScene: "David runs.", subjectDetails: [], environment: [] },
    }));
    const codes = (out.diagnostics?.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes("thin-core-scene"), codes.join(","));
    assert.ok(codes.includes("thin-subject-details"), codes.join(","));
    assert.ok(codes.includes("thin-environment"), codes.join(","));
    // Still produced a valid prompt (advisory, not a hard failure).
    assert.match(out.imagePrompt, /CORE SCENE:/);
  });

  it("warns on an abstract subject role for an active-action frame", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David hurls a boulder across a canyon with a grunt.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        subjectTreatment: { ...makeVisualPlan().subjectTreatment, roleInScene: "protagonist" },
      },
    }));
    const codes = (out.diagnostics?.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes("abstract-subject-role"), codes.join(","));
  });

  it("flags a secondary character missing a concrete role", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David and a companion stand together.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: { secondaryCharacters: [{ label: "friend", visualRole: "" }] },
    }));
    const codes = (out.diagnostics?.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes("incomplete-secondary-character"), codes.join(","));
  });

  it("does not hardcode any fact string in the compiler sources", () => {
    const compilerDir = fileURLToPath(new URL("../lib/imagePrompt/compilers/", import.meta.url));
    const sources = ["nanoBanana2.ts", "failureModeConstraints.ts"]
      .map((f) => readFileSync(`${compilerDir}${f}`, "utf8").toLowerCase())
      .join("\n");
    assert.doesNotMatch(sources, /drove his mom home|david franklin was born|car seat|steering wheel/);
  });
});

// ── Moderator-authored core scene ("Visual concept") — slice 1 ──────────────

describe("nanoBanana2 — moderator-authored core scene (visual concept)", () => {
  function makeOverride(partial: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      enabled: true,
      requiredVisualDetails: [],
      forbiddenVisualDetails: [],
      roleBindings: [],
      compositionGuidance: [],
      styleAgnosticPromptAdditions: [],
      negativePromptAdditions: [],
      ...partial,
    };
  }

  it("wins over the AI plan's coreScene and is marked required + moderator-authored", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "legacy fallback prose about golf.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: { coreScene: "David calmly putts a golf ball on a quiet green." },
      override: makeOverride({ coreSceneOverride: "David rides a giant rubber duck across a packed stadium." }),
    }));
    assert.match(out.imagePrompt, /CORE SCENE: David rides a giant rubber duck across a packed stadium\./);
    assert.doesNotMatch(out.imagePrompt, /quiet green/);
    const core = out.promptBreakdown?.find((s) => s.id === "core_scene");
    assert.equal(core?.priority, "required");
    assert.equal(core?.status, "included");
    assert.equal(core?.moderatorAuthored, true);
  });

  it("keeps the AI path unchanged when the override is disabled or the field is empty", () => {
    for (const override of [
      makeOverride({ enabled: false, coreSceneOverride: "David rides a rubber duck." }),
      makeOverride({ coreSceneOverride: "   " }),
      undefined,
    ]) {
      const out = compileNanoBanana2HumanI2I(makeArgs({
        subjectRenderMode: "human_identity_i2i",
        prompt: "fallback",
        visualPlan: { coreScene: "David calmly putts a golf ball on a quiet green." },
        ...(override ? { override } : {}),
      }));
      assert.match(out.imagePrompt, /CORE SCENE: David calmly putts a golf ball on a quiet green\./);
      const core = out.promptBreakdown?.find((s) => s.id === "core_scene");
      assert.equal(core?.priority, "high");
      assert.equal(core?.moderatorAuthored, undefined);
    }
  });

  it("token-renders {NAME} BEFORE sanitation so the sentence survives", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "fallback",
      renderedSubject: { name: "David", pronouns: "he/him" },
      override: makeOverride({ coreSceneOverride: "{NAME} rides a T-Rex through {NAME_POSSESSIVE} open-plan office." }),
    }));
    assert.match(out.imagePrompt, /CORE SCENE: David rides a T-Rex through David's open-plan office\./);
    assert.doesNotMatch(out.imagePrompt, /\{NAME\}/);
    const codes = (out.diagnostics?.warnings ?? []).map((w) => w.code);
    assert.ok(!codes.includes("moderator_core_scene_empty_after_sanitize"), codes.join(","));
  });

  it("emits the moderator scene VERBATIM — compiler-owned language kept, not stripped — and warns", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "fallback",
      renderedSubject: { name: "David", pronouns: "he/him" },
      override: makeOverride({
        coreSceneOverride:
          "David rides a T-Rex through the office. Ensure David's recognizable face is preserved.",
      }),
    }));
    assert.match(out.imagePrompt, /David rides a T-Rex through the office\./);
    // Verbatim: the owned-language sentence is NOT removed (human authored it on purpose).
    assert.match(out.imagePrompt, /recognizable face is preserved/);
    // …but it IS flagged (non-mutating) so the moderator can fix it at authoring time.
    const codes = (out.diagnostics?.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes("moderator_core_scene_owned_language"), codes.join(","));
    const core = out.promptBreakdown?.find((s) => s.id === "core_scene");
    assert.equal(core?.moderatorAuthored, true);
  });

  it("uses a non-empty moderator scene VERBATIM even when it is all compiler-owned language (never falls back to AI)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "fallback",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: { coreScene: "David calmly putts a golf ball on a quiet green." },
      override: makeOverride({
        coreSceneOverride:
          "Ensure David's recognizable face is preserved. Keep all surfaces free of readable text, watermarks, and logos.",
      }),
    }));
    // A non-empty human Concept is authoritative and verbatim — NOT replaced by
    // the AI scene, even when every sentence is compiler-owned language.
    assert.doesNotMatch(out.imagePrompt, /golf ball/);
    assert.match(out.imagePrompt, /recognizable face is preserved/);
    const codes = (out.diagnostics?.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes("moderator_core_scene_owned_language"), codes.join(","));
    const core = out.promptBreakdown?.find((s) => s.id === "core_scene");
    assert.equal(core?.moderatorAuthored, true);
    assert.equal(core?.priority, "required");
  });

  it("coexists with requiredVisualDetails — both land in the compiled prompt", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "fallback",
      renderedSubject: { name: "David", pronouns: "he/him" },
      override: makeOverride({
        coreSceneOverride: "David rides a giant rubber duck across a packed stadium.",
        requiredVisualDetails: ["a scoreboard reading 9999", "confetti mid-air"],
      }),
    }));
    assert.match(out.imagePrompt, /David rides a giant rubber duck across a packed stadium\./);
    assert.match(out.imagePrompt, /REQUIRED VISUAL DETAILS: a scoreboard reading 9999; confetti mid-air\./);
  });

  it("survives the char budget verbatim while later compressible sections give way", () => {
    const moderatorScene =
      "David rides a giant rubber duck across a packed stadium while fireworks trace a heart in the sky.";
    // Genuinely DISTINCT filler (unique content words per entry) so the additive
    // content-word de-dupe can't collapse it — the point here is budget pressure,
    // not de-duplication. (Near-identical numbered filler would correctly collapse.)
    const filler = Array.from(
      { length: 120 },
      (_, i) => `vivid${i} tableau${i} of glimmer${i} artifacts arranged in baroque${i} symmetry${i}`,
    );
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "fallback",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: { subjectDetails: filler, environment: filler },
      override: makeOverride({ coreSceneOverride: moderatorScene }),
    }));
    assert.equal(out.imagePrompt.length <= 4000, true, `prompt length ${out.imagePrompt.length}`);
    assert.ok(out.imagePrompt.includes(moderatorScene), "moderator scene present verbatim");
    const core = out.promptBreakdown?.find((s) => s.id === "core_scene");
    assert.equal(core?.status, "included");
    // Budget pressure landed on later sections, not the moderator scene.
    assert.match(String(out.engineNotes ?? ""), /budget/i);
  });

  it("still records the hard-truncation note when required content alone overflows", () => {
    const hugeRequired = Array.from({ length: 120 }, (_, i) => `a mandatory prop number ${i} rendered in full detail`);
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "fallback",
      renderedSubject: { name: "David", pronouns: "he/him" },
      override: makeOverride({
        coreSceneOverride: "David rides a giant rubber duck across a packed stadium.",
        requiredVisualDetails: hugeRequired,
      }),
    }));
    assert.equal(out.imagePrompt.length <= 4000, true, `prompt length ${out.imagePrompt.length}`);
    assert.match(String(out.engineNotes ?? ""), /Hard-truncated required content/);
  });
});

// ── PR1: Visual Concept leads; cut the crutches (compiler redesign) ──────────

describe("nanoBanana2 — CORE SCENE leads + mode-aware identity", () => {
  it("CORE SCENE is the first emitted section in all three render modes", () => {
    const human = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i", prompt: "David lifts a car.",
    }));
    const nonhuman = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i", prompt: "An orange cat lifts a car.",
    }));
    const t2i = compileNanoBanana2T2I(makeArgs({
      subjectRenderMode: "t2i_fallback", prompt: "A protagonist lifts a car.", fallbackSubjectGender: "male",
    }));
    for (const out of [human, nonhuman, t2i]) {
      assert.match(out.imagePrompt, /^CORE SCENE:/, out.imagePrompt.slice(0, 60));
      assert.equal(out.promptBreakdown?.[0]?.id, "core_scene");
    }
  });

  it("human i2i: a STRONG identity clause is the section right after CORE SCENE", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i", prompt: "David stands in a storm.",
    }));
    const coreAt = out.imagePrompt.indexOf("CORE SCENE:");
    const idAt = out.imagePrompt.indexOf("IDENTITY & REFERENCE:");
    assert.ok(coreAt === 0 && idAt > coreAt, out.imagePrompt.slice(0, 120));
    assert.match(out.imagePrompt.toLowerCase(), /preserve the reference person's recognizable identity and likeness/);
    // No section sits between CORE SCENE and the identity clause.
    const ids = (out.promptBreakdown ?? []).filter((s) => s.status === "included" || s.status === "compressed").map((s) => s.id);
    assert.equal(ids[0], "core_scene");
    assert.equal(ids[1], "identity_reference");
  });

  it("nonhuman i2i: identity clause after the scene keeps the non-humanize guard", () => {
    const out = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i", prompt: "An orange cat does a pushup.",
    }));
    assert.match(out.imagePrompt, /IDENTITY & REFERENCE:/);
    assert.match(out.imagePrompt.toLowerCase(), /do not replace the subject with a human/);
    const idAt = out.imagePrompt.indexOf("IDENTITY & REFERENCE:");
    assert.ok(idAt > 0 && idAt < out.imagePrompt.indexOf("STRICT CONSTRAINTS:"));
  });
});

describe("nanoBanana2 — no double-naming (X is X) from any role source", () => {
  it("an AI-plan roleInScene that already names the subject is emitted as-is, never doubled", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A dim neighborhood bar at night.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        subjectTreatment: {
          ...makeVisualPlan().subjectTreatment,
          roleInScene: "David leans against the counter and raises a middle finger",
        },
        secondaryCharacters: [{ label: "a loud patron", visualRole: "stumbling backward at the end of the bar" }],
      },
    }));
    assert.match(out.imagePrompt, /David leans against the counter and raises a middle finger/);
    assert.doesNotMatch(out.imagePrompt, /David is David/);
  });

  it("a {NAME}-token-led role (moderator roleBinding) never renders 'Name is Name'", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "A dim neighborhood bar.",
      renderedSubject: { name: "Alex Franklin", pronouns: "he/him" },
      override: {
        version: 1,
        enabled: true,
        requiredVisualDetails: [],
        forbiddenVisualDetails: [],
        roleBindings: [{ entity: "subject", visualRole: "{NAME} raises a middle finger at a loud patron" }],
        compositionGuidance: [],
        styleAgnosticPromptAdditions: [],
        negativePromptAdditions: [],
      },
    }));
    assert.match(out.imagePrompt, /Alex Franklin raises a middle finger at a loud patron/);
    assert.doesNotMatch(out.imagePrompt, /Alex Franklin is Alex Franklin/);
    assert.doesNotMatch(out.imagePrompt, /\{NAME\}/);
  });
});

describe("nanoBanana2 — additive de-dupe (contiguity, not scattered words)", () => {
  it("drops a tight restatement of the scene but keeps a distinct detail that reuses scene words", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands under red warning lights beside a tall trophy shelf.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        subjectDetails: ["a red trophy in his hand", "beside a tall trophy shelf"],
      },
    }));
    // Distinct detail survives (shares 'red' + 'trophy' with the scene, but is a new object).
    assert.match(out.imagePrompt.toLowerCase(), /a red trophy in his hand/);
    // The tight restatement of the scene's own phrase is dropped (appears once — in the scene).
    assert.equal(countOccurrences(out.imagePrompt.toLowerCase(), "beside a tall trophy shelf"), 1, out.imagePrompt);
  });

  it("de-dupes against EMITTED text only — a non-emitted visualApproach cannot suppress a concrete detail", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands in an empty room.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        visualApproach: "lean on a glowing chandelier motif for grandeur",
        subjectDetails: ["a glowing chandelier overhead"],
      },
    }));
    // The concrete detail survives even though the (internal, non-emitted) approach mentioned a chandelier.
    assert.match(out.imagePrompt.toLowerCase(), /a glowing chandelier overhead/);
    // The internal reasoning itself never leaks into the prompt.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /lean on a glowing chandelier motif/);
  });
});

describe("nanoBanana2 — key-element crutch filter + structured diagnostics", () => {
  it("drops negative/conditional/failure-mode 'crutch' candidates, keeps concrete ones, records why", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David gives the finger in a bar.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        keyVisualElements: [
          "a glowing jukebox in the corner",
          "Depict a rude middle-finger gesture if shown, not a severed finger",
          "no visible blood",
        ],
      },
    }));
    // Concrete element reaches the visible-elements list.
    assert.match(out.imagePrompt.toLowerCase(), /a glowing jukebox in the corner/);
    // Crutch lines never appear as visible elements.
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /severed finger/);
    assert.doesNotMatch(out.imagePrompt.toLowerCase(), /no visible blood/);
    // The drops are recorded, structured, with reasons.
    const drops = out.diagnostics?.droppedCandidates ?? [];
    assert.ok(drops.some((d) => d.source === "keyVisualElements" && d.reason === "failure-mode-commentary-not-visible-element"), JSON.stringify(drops));
    assert.ok(drops.some((d) => d.reason === "negative-constraint-not-visible-element"), JSON.stringify(drops));
  });

  it("STRICT CONSTRAINTS policy guardrails are preserved (overlay-text + incidental-text)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i", prompt: "David stands in a bar.",
    }));
    assert.match(out.imagePrompt, /STRICT CONSTRAINTS:/);
    assert.match(out.imagePrompt.toLowerCase(), /do not bake overlay or caption text into the image/);
    assert.match(out.imagePrompt.toLowerCase(), /keep incidental background text non-readable/);
  });
});
