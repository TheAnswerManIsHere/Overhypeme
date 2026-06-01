/**
 * Unit tests for the Nano Banana 2 prompt compilers.
 *
 * Pure — no DB, no LLM, no IO. Exercises compileForSubjectRenderMode() and the
 * sentence-level preamble de-duplication that prevents duplicate required
 * clauses (e.g. the non-human "Do not replace the subject with a human." guard
 * the generator already emits to satisfy the validator).
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

// Minimal args; the compilers only read compiledPrompt.prompt/negativePrompt,
// input.subjectRenderMode, input.stylePrompt, input.renderControls, and
// input.referenceImageUrl. visualPlan is unused by the compilers.
function makeArgs(opts: {
  subjectRenderMode: ImagePromptGenerationInput["subjectRenderMode"];
  prompt: string;
  stylePrompt?: string;
  fallbackSubjectGender?: "male" | "female" | "neutral";
}) {
  const input = {
    subjectRenderMode: opts.subjectRenderMode,
    stylePrompt: opts.stylePrompt ?? "",
    referenceImageUrl: null,
    renderControls: {
      aspectRatio: "portrait",
      contentMode: "sfw",
      ...(opts.fallbackSubjectGender ? { fallbackSubjectGender: opts.fallbackSubjectGender } : {}),
    },
  } as unknown as ImagePromptGenerationInput;
  return {
    visualPlan: {} as VisualPlan,
    compiledPrompt: { prompt: opts.prompt, negativePrompt: "", engineNotes: "" },
    input,
  };
}

describe("nanoBanana2 — preamble de-duplication", () => {
  // David's reported case: generator output already ends with the required
  // "Do not replace the subject with a human." sentence and paraphrases the
  // identity-preservation clause. The preamble must not duplicate that sentence.
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
    assert.equal(
      countOccurrences(out.imagePrompt, "do not replace the subject with a human"),
      1,
      `expected the clause exactly once, got:\n${out.imagePrompt}`,
    );
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

  it("does not re-add the preamble when the LLM already included every sentence verbatim", () => {
    const full =
      "Image-to-image edit using the reference image as the visual identity source for the uploaded subject. " +
      "The uploaded subject visually represents the named subject in the fact. " +
      "Preserve the uploaded subject's recognizable visual identity. " +
      "Do not replace the subject with a human. " +
      "A heroic golden retriever bench-presses a car.";
    const out = compileNanoBanana2NonhumanI2I(makeArgs({
      subjectRenderMode: "nonhuman_subject_i2i",
      prompt: full,
    }));
    assert.equal(countOccurrences(out.imagePrompt, "do not replace the subject with a human"), 1, out.imagePrompt);
    assert.equal(countOccurrences(out.imagePrompt, "image-to-image edit using the reference image"), 1, out.imagePrompt);
  });

  it("human i2i: prepends face-preservation when missing, without duplicating it", () => {
    const withFace = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David deadlifts a bus. Preserve the reference person's recognizable face.",
    }));
    assert.equal(
      countOccurrences(withFace.imagePrompt, "preserve the reference person's recognizable face"),
      1,
      withFace.imagePrompt,
    );

    const withoutFace = compileNanoBanana2HumanI2I(makeArgs({
      subjectRenderMode: "human_identity_i2i",
      prompt: "David deadlifts a bus.",
    }));
    assert.match(withoutFace.imagePrompt.toLowerCase(), /preserve the reference person's recognizable face/);
  });

  it("t2i: bakes in fallback gender exactly once and adds no i2i identity language", () => {
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
