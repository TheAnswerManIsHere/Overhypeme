/**
 * Unit tests for the Nano Banana 2 prompt compilers.
 *
 * Pure — no DB, no LLM, no IO. The compiler ASSEMBLES the final engine prompt
 * from the structured visualPlan + runtime inputs (the LLM prose is just one
 * high-priority input). These tests exercise: mode preambles + identity-guard
 * de-duplication, structured directive injection (key elements, composition,
 * supporting text, semantic + cultural references, fact modifiers), the
 * priority-aware char budget, and the empty-negativePrompt invariant.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
    },
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

describe("nanoBanana2 — preamble + identity guards", () => {
  const LLM_NONHUMAN_PROMPT =
    "Create an image of an orange tabby cat performing a pushup on cracked ground. " +
    "The ground visibly compresses downward, with dust ripples and nearby objects tilting slightly from the force. " +
    "The cat should appear powerful and in control, with its recognizable visual identity preserved. " +
    "Do not replace the subject with a human.";

  it("does not duplicate 'Do not replace the subject with a human.'", () => {
    const out = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i",
      prompt: LLM_NONHUMAN_PROMPT,
    }));
    assert.equal(countOccurrences(out.imagePrompt, "do not replace the subject with a human"), 1, out.imagePrompt);
  });

  it("still prepends the i2i operational lead the LLM omitted", () => {
    const out = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i",
      prompt: LLM_NONHUMAN_PROMPT,
    }));
    assert.match(out.imagePrompt.toLowerCase(), /image-to-image edit using the reference image/);
  });

  it("appends the human-guard once when the LLM omitted it entirely", () => {
    const out = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i",
      prompt: "Create an image of a sturdy oak tree flexing its branches like biceps.",
    }));
    assert.equal(countOccurrences(out.imagePrompt, "do not replace"), 1, out.imagePrompt);
  });

  it("human i2i: includes face-preservation, without duplicating it", () => {
    const withFace = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David deadlifts a bus. Preserve the reference person's recognizable face.",
    }));
    assert.equal(countOccurrences(withFace.imagePrompt, "preserve the reference person's recognizable face"), 1, withFace.imagePrompt);

    const withoutFace = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David deadlifts a bus.",
    }));
    assert.match(withoutFace.imagePrompt.toLowerCase(), /preserve the reference person's recognizable face/);
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
  it("injects key visual elements the prose omitted, and does not duplicate present ones", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands in a thunderstorm preserving the reference person's recognizable face.",
      visualPlan: { keyVisualElements: ["a thunderstorm", "a glowing trophy", "a roaring crowd"] },
    }));
    // "a thunderstorm" is already in the prose → not re-listed; the other two are.
    assert.match(out.imagePrompt, /Ensure these elements are clearly visible:/);
    assert.match(out.imagePrompt.toLowerCase(), /glowing trophy/);
    assert.match(out.imagePrompt.toLowerCase(), /roaring crowd/);
    assert.equal(countOccurrences(out.imagePrompt, "a thunderstorm"), 1, out.imagePrompt);
  });

  it("injects composition framing/camera + caption negative space", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David wins. Preserve the reference person's recognizable face.",
      visualPlan: {
        composition: { subjectFraming: "low-angle hero shot", negativeSpace: "bottom", cameraStyle: "anamorphic 35mm", sceneReadability: "clear" },
      },
    }));
    assert.match(out.imagePrompt.toLowerCase(), /low-angle hero shot/);
    assert.match(out.imagePrompt.toLowerCase(), /anamorphic 35mm/);
    assert.match(out.imagePrompt.toLowerCase(), /negative space at the bottom/);
  });

  it("renders allowed supporting text with content + placement and forbids other text", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David at a scoreboard. Preserve the reference person's recognizable face.",
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
      prompt: "David wins. Preserve the reference person's recognizable face.",
    }));
    assert.match(out.imagePrompt.toLowerCase(), /keep all surfaces free of readable text/);
  });

  it("injects semantic-entity referents", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands triumphant. Preserve the reference person's recognizable face.",
      visualPlan: {
        semanticEntitiesUsed: [{ surfaceText: "Earth", visualReferentUsed: "the planet Earth seen from orbit", effectOnVisualPlan: "sets cosmic scale" }],
      },
    }));
    assert.match(out.imagePrompt, /"Earth" means the planet Earth seen from orbit/);
  });

  it("injects cultural-reference directives with a logo guard", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David on a beach. Preserve the reference person's recognizable face.",
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
  });

  it("injects high-impact modifier directives", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands. Preserve the reference person's recognizable face.",
      modifiers: ["crowd_reaction", "avoid_duplicate_subject"],
    }));
    assert.match(out.imagePrompt.toLowerCase(), /crowd reacting/);
    assert.match(out.imagePrompt.toLowerCase(), /exactly one instance of the subject/);
  });

  it("resolves residual identity tokens the LLM echoed (e.g. a {NAME} semantic entity) using renderedSubject", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands triumphant. Preserve the reference person's recognizable face.",
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
  it("returns a per-section breakdown with goal/approach split out and statuses", () => {
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David stands in a thunderstorm. Preserve the reference person's recognizable face.",
      visualPlan: {
        visualGoal: "Make the feat feel legendary",
        visualApproach: "Grounded cinematic framing",
        keyVisualElements: ["a thunderstorm", "a glowing trophy"],
      },
    }));
    const bd = out.promptBreakdown;
    assert.ok(bd && bd.length > 0, "promptBreakdown present");
    const byId = Object.fromEntries(bd!.map((s) => [s.id, s]));

    // Goal + approach are surfaced as distinct components.
    assert.equal(byId["visual_goal"]?.status, "included");
    assert.match(byId["visual_goal"]!.text, /Make the feat feel legendary/);
    assert.equal(byId["visual_approach"]?.status, "included");
    assert.match(byId["visual_approach"]!.text, /Grounded cinematic framing/);

    // The preamble + face guard are required and present.
    assert.equal(byId["mode_preamble"]?.priority, "required");
    assert.equal(byId["mode_preamble"]?.status, "included");

    // Key elements already in the prose ("a thunderstorm") are deduped out of
    // the gap-fill directive; novel ones ("a glowing trophy") are kept.
    assert.match(byId["key_visual_elements"]!.text, /glowing trophy/);
    assert.doesNotMatch(byId["key_visual_elements"]!.text, /a thunderstorm/);

    // Empty components are recorded as empty (style not configured here).
    assert.equal(byId["style"]?.status, "empty");

    // Concatenating the included/compressed section texts reproduces the prompt.
    const reassembled = bd!
      .filter((s) => s.status === "included" || s.status === "compressed")
      .map((s) => s.text)
      .join(" ");
    assert.equal(reassembled, out.imagePrompt);
  });

  it("never sets negativePrompt and keeps required content under an over-long prose", () => {
    const hugeProse = `${"David flexes dramatically. ".repeat(400)}Preserve the reference person's recognizable face.`;
    const out = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: hugeProse,
      stylePrompt: "in a painterly oil style",
      negativePrompt: "ignored",
      visualPlan: { visualGoal: "make the lift feel legendary", visualApproach: "epic cinematic framing" },
    }));
    assert.equal(out.imagePrompt.length <= 4000, true, `prompt length ${out.imagePrompt.length}`);
    assert.equal(out.negativePrompt, undefined);
    // Required identity language survives even when prose is enormous.
    assert.match(out.imagePrompt.toLowerCase(), /image-to-image edit using the reference image/);
    // Budget pressure should be recorded in engineNotes.
    assert.match(String(out.engineNotes ?? ""), /budget/i);
  });
});
