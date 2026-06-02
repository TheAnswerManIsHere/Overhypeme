/**
 * Unit tests for buildImagePromptUserMessage — the render-time generator's user
 * message. Pure (no LLM): asserts that compact research context, the rendered
 * fact text, the empty-negativePrompt instruction, and the cultural-reference
 * echo requirement are present, and that the taxonomy is presented as fixed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildImagePromptUserMessage } from "../lib/imagePrompt/generator.js";
import type { ImagePromptGenerationInput } from "@workspace/api-zod";

function makeInput(overrides: { culturalReferences?: unknown[]; factText?: string } = {}): ImagePromptGenerationInput {
  const enrichment = {
    primaryArchetype: "object_logic_impossibility",
    subtype: "medium_contradiction",
    modifiers: ["face_prominent"],
    visualLiteralness: "literal",
    visualComplexity: "moderate",
    overhypeFit: "high",
    adultSuitability: "sfw",
    taxonomyConfidence: 0.9,
    culturalReferences: overrides.culturalReferences ?? [],
    semanticEntities: [],
  };
  return {
    factText: overrides.factText ?? "David focuses moonlight through a magnifying glass to set an ant on fire. At night.",
    enrichment,
    sourceImageAnalysis: {
      subjectKind: "human_face",
      confidence: "high",
      hasUsableHumanFace: true,
      hasUsableSubject: true,
      subjectCount: 1,
      warnings: [],
      suggestedRenderMode: "human_identity_i2i",
      classificationMethod: "fal_detector",
      analyzerVersion: "v1",
    },
    subjectRenderMode: "human_identity_i2i",
    userSelectedSubjectRenderMode: null,
    identityPolicy: {
      subjectRenderMode: "human_identity_i2i",
      preserveHumanFace: true,
      preserveNonhumanSubjectIdentity: false,
      preservePhysique: false,
      allowBodyExaggeration: true,
      allowCostumeTransformation: true,
      allowAnthropomorphicTransformation: false,
      ageAndLifeStagePolicy: "follow_fact",
    },
    renderControls: { aspectRatio: "portrait", contentMode: "sfw" },
    stylePrompt: "cinematic",
    referenceImageUrl: null,
    targetEngine: "nano_banana_2",
  } as unknown as ImagePromptGenerationInput;
}

describe("buildImagePromptUserMessage", () => {
  it("includes the rendered fact text verbatim with no template tokens", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /factTextExact: David focuses moonlight/);
    assert.doesNotMatch(msg, /\{NAME\}|\{SUBJ\}|\{POSS\}/);
  });

  it("instructs that negativePrompt must be empty (no negative param)", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /negativePrompt.*empty string/i);
    assert.match(msg.toLowerCase(), /positive scene language/);
  });

  it("presents the taxonomy as fixed (do not reclassify)", () => {
    const msg = buildImagePromptUserMessage(makeInput());
    assert.match(msg, /TAXONOMY \(FIXED — DO NOT reclassify\)/);
  });

  it("omits research context for plain (un-researched) references", () => {
    const msg = buildImagePromptUserMessage(makeInput({
      culturalReferences: [
        { sourcePhrase: "the void", referenceType: "concept", canonicalReference: "", explanation: "", visualImplication: "darkness", confidence: 0.5, requiresAdminReview: false },
      ],
    }));
    assert.doesNotMatch(msg, /researchConfidence=/);
    assert.doesNotMatch(msg, /ambiguityWarnings=/);
  });

  it("includes compact research context (confidence, truncated notes, ≤3 warnings) when present", () => {
    const longNotes = "x".repeat(900);
    const msg = buildImagePromptUserMessage(makeInput({
      culturalReferences: [
        {
          sourcePhrase: "Shark Week",
          referenceType: "tv",
          canonicalReference: "Discovery's Shark Week",
          explanation: "annual shark programming",
          visualImplication: "sharks on a TV screen",
          confidence: 0.95,
          requiresAdminReview: false,
          researchConfidence: "high",
          researchNotes: longNotes,
          ambiguityWarnings: ["w1", "w2", "w3", "w4", "w5"],
        },
      ],
    }));
    assert.match(msg, /researchConfidence=high/);
    // Notes truncated well under the raw 900 chars.
    const notesMatch = msg.match(/researchNotes="([^"]*)"/);
    assert.ok(notesMatch, "expected researchNotes in message");
    assert.ok(notesMatch![1]!.length < 500, `notes not truncated: ${notesMatch![1]!.length}`);
    // At most 3 warnings surfaced.
    assert.match(msg, /ambiguityWarnings=\["w1", "w2", "w3"\]/);
    assert.doesNotMatch(msg, /w4/);
    // Material reference → required in culturalReferencesUsed echo.
    assert.match(msg, /culturalReferencesUsed: MUST include an entry/);
    assert.match(msg, /"Shark Week"/);
  });
});
