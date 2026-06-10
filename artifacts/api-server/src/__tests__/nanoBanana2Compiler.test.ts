/**
 * Unit tests for the Nano Banana 2 prompt compilers.
 *
 * Pure — no DB, no LLM, no IO. The compiler ASSEMBLES the final engine prompt
 * from the structured visualPlan + runtime inputs as a fixed, labeled visual
 * contract: IMAGE-TO-IMAGE TASK · SUBJECT BINDING · CORE SCENE · SUBJECT DETAILS
 * · ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS.
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
    styleIntegration: "",
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
}) {
  const input = {
    subjectRenderMode: opts.subjectRenderMode,
    stylePrompt: opts.stylePrompt ?? "",
    referenceImageUrl: opts.referenceImageUrl ?? null,
    enrichment: { modifiers: opts.modifiers ?? [] },
    renderControls: {
      aspectRatio: "portrait",
      contentMode: "sfw",
      ...(opts.fallbackSubjectGender ? { fallbackSubjectGender: opts.fallbackSubjectGender } : {}),
    },
  } as unknown as ImagePromptGenerationInput;
  return {
    visualPlan: makeVisualPlan(opts.visualPlan),
    compiledPrompt: { prompt: opts.prompt, negativePrompt: opts.negativePrompt ?? "", engineNotes: "" },
    input,
    ...(opts.renderedSubject ? { renderedSubject: opts.renderedSubject } : {}),
  };
}

describe("nanoBanana2 — labeled visual contract", () => {
  it("leads with a labeled, transformation-aware IMAGE-TO-IMAGE TASK", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David deadlifts a bus.",
    }));
    assert.match(out.imagePrompt, /^IMAGE-TO-IMAGE TASK: Image-to-image edit using the reference image/);
    // Identity preservation is now transformation-aware (likeness, not a frozen face).
    assert.match(out.imagePrompt.toLowerCase(), /recognizable identity and likeness/);
    assert.match(out.imagePrompt.toLowerCase(), /allow apparent age, body proportions, hair, clothing, and life stage to transform/);
  });

  it("emits the contract section headers", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands in a thunderstorm holding a trophy.",
    }));
    assert.match(out.imagePrompt, /IMAGE-TO-IMAGE TASK:/);
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

  it("compiles age modifiers into a loud de-aging directive (never silently dropped)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "An infant drives a car.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      modifiers: ["baby_child_version"],
    }));
    assert.match(out.imagePrompt.toLowerCase(), /de-age the reference subject into the baby\/child/);
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
    // The age modifier still compiles into a loud directive (never dropped).
    assert.match(out.imagePrompt.toLowerCase(), /transform the reference subject's apparent age/);
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
    assert.match(out.imagePrompt.toLowerCase(), /no reference identity is being preserved/);
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

  it("folds lightingAndStyle and the style suffix into LIGHTING AND STYLE", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
      stylePrompt: "in a painterly oil style",
      visualPlan: { lightingAndStyle: "warm golden-hour rim light" },
    }));
    assert.match(out.imagePrompt, /LIGHTING AND STYLE:/);
    assert.match(out.imagePrompt.toLowerCase(), /warm golden-hour rim light/);
    assert.match(out.imagePrompt.toLowerCase(), /in a painterly oil style/);
  });

  it("renders allowed supporting text with content + placement and forbids other text", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David at a scoreboard.",
      visualPlan: {
        supportingTextPolicy: {
          allowSupportingText: true,
          supportingTextElements: [{ content: "999", purpose: "score", placement: "on the scoreboard" }],
          forbiddenTextTypes: [],
        },
      },
    }));
    assert.match(out.imagePrompt, /Render only this short in-image text: "999" \(on the scoreboard\)/);
    assert.match(out.imagePrompt.toLowerCase(), /keep all other surfaces free of text/);
  });

  it("emits the no-readable-text rule when supporting text is forbidden", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins.",
    }));
    assert.match(out.imagePrompt.toLowerCase(), /keep all surfaces free of readable text/);
  });

  it("injects semantic-entity referents", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands triumphant.",
      visualPlan: {
        semanticEntitiesUsed: [{ surfaceText: "Earth", visualReferentUsed: "the planet Earth seen from orbit", effectOnVisualPlan: "sets cosmic scale" }],
      },
    }));
    assert.match(out.imagePrompt, /"Earth" means the planet Earth seen from orbit/);
  });

  it("injects cultural-reference directives with a logo guard (Shark Week)", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David on a beach.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        culturalReferencesUsed: [{
          sourcePhrase: "Shark Week",
          canonicalReferenceUsed: "Discovery Channel's Shark Week",
          visualImplicationUsed: "sharks circling on a TV screen behind David",
          effectOnVisualPlan: "adds the gag",
        }],
      },
    }));
    assert.match(out.imagePrompt.toLowerCase(), /treat "shark week" as discovery channel's shark week/);
    assert.match(out.imagePrompt.toLowerCase(), /avoid real logos or brand marks/);
    // David is the single subject of the gag — not duplicated across the frame.
    assert.equal(countOccurrences(out.imagePrompt, "do not render the adult reference person separately"), 0, out.imagePrompt);
  });

  it("injects high-impact modifier directives", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands.",
      modifiers: ["crowd_reaction"],
    }));
    assert.match(out.imagePrompt.toLowerCase(), /crowd reacting/);
  });

  it("resolves residual identity tokens the LLM echoed (e.g. a {NAME} semantic entity) using renderedSubject", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands triumphant.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        semanticEntitiesUsed: [
          { surfaceText: "{NAME}", visualReferentUsed: "the user's name", effectOnVisualPlan: "names the hero" },
        ],
      },
    }));
    assert.doesNotMatch(out.imagePrompt, /\{NAME\}/);
    assert.match(out.imagePrompt, /"David" means the user's name/);
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

    // The task lead is required and present.
    assert.equal(byId["image_to_image_task"]?.priority, "required");
    assert.equal(byId["image_to_image_task"]?.status, "included");
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

describe("nanoBanana2 — REFERENCE INTERPRETATION + role binding", () => {
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
    assert.match(out.imagePrompt, /REFERENCE INTERPRETATION:/);
    assert.match(out.imagePrompt, /David is the newborn baby gripping the steering wheel and driving\./);
    assert.match(out.imagePrompt.toLowerCase(), /his mother is a separate adult woman seated in the front passenger seat/);
    // Role-swap is blocked + the subject must be actively driving (active frame).
    assert.match(out.imagePrompt.toLowerCase(), /keep each named character in their stated visual role/);
    assert.match(out.imagePrompt.toLowerCase(), /only david performs the central action/);
    assert.match(out.imagePrompt.toLowerCase(), /show david actively performing the central action/);
    // The age-split binding still holds (the mother is NOT a second baby David).
    assert.match(out.imagePrompt, /The transformed newborn infant IS David/);
  });

  it("orders REFERENCE INTERPRETATION between SUBJECT BINDING and CORE SCENE", () => {
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
    const binding = ids.indexOf("subject_binding");
    const refInterp = ids.indexOf("reference_interpretation");
    const core = ids.indexOf("core_scene");
    assert.ok(binding < refInterp && refInterp < core, ids.join(","));
  });

  it("omits REFERENCE INTERPRETATION for a solo subject on a non-active frame", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands on a quiet hill at dawn.",
      renderedSubject: { name: "David", pronouns: "he/him" },
      visualPlan: {
        archetypeApplication: { ...makeVisualPlan().archetypeApplication, selectedFrame: "implied_aftermath" },
        subjectTreatment: { ...makeVisualPlan().subjectTreatment, roleInScene: "protagonist" },
      },
    }));
    assert.doesNotMatch(out.imagePrompt, /REFERENCE INTERPRETATION:/);
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
    assert.match(out.imagePrompt.toLowerCase(), /the referee is a separate official walking away/);
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
