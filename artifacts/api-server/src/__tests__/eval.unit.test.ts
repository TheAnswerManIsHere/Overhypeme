/**
 * Eval harness (Slice 2B) — pure unit tests (no DB / no LLM):
 *   - deriveAttemptSignature: t2i vs i2i differ on the ACTUAL image engine (not
 *     the coarse targetEngine); missing inputs bucket as "unknown"; the signature
 *     key groups like rows and separates unlike ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  attemptSignatureKey,
} from "@workspace/api-zod";
import type { ImagePromptAttempt } from "@workspace/db";
import { deriveAttemptSignature } from "../lib/eval/signature.js";

function attempt(overrides: Partial<ImagePromptAttempt> = {}): ImagePromptAttempt {
  return {
    id: 1,
    factId: 10,
    generationMode: "t2i",
    subjectRenderMode: "t2i_fallback",
    reviewRenderScenarioKey: null,
    reviewReferenceIdentityType: null,
    reviewReferenceAssetVersion: null,
    evalScenarioKey: null,
    compiledPrompt: null,
    renderControls: {},
    ...overrides,
  } as unknown as ImagePromptAttempt;
}

describe("deriveAttemptSignature", () => {
  it("t2i and i2i differ on the actual image engine", () => {
    const t2i = deriveAttemptSignature(attempt({ generationMode: "t2i", subjectRenderMode: "t2i_fallback" }));
    const i2i = deriveAttemptSignature(attempt({ generationMode: "i2i", subjectRenderMode: "human_identity_i2i" }));
    assert.notEqual(t2i.actualImageEngineId, i2i.actualImageEngineId);
    assert.notEqual(t2i.generationMode, i2i.generationMode);
  });

  it("buckets missing planner provenance / scenario as \"unknown\"", () => {
    const sig = deriveAttemptSignature(attempt({ compiledPrompt: null, evalScenarioKey: null, reviewRenderScenarioKey: null }));
    assert.equal(sig.plannerModel, "unknown");
    assert.equal(sig.plannerReasoningEffort, "unknown");
    assert.equal(sig.scenarioKey, "unknown");
  });

  it("reads planner model/effort from the compiled prompt diagnostics", () => {
    const sig = deriveAttemptSignature(attempt({
      compiledPrompt: { diagnostics: { plannerProvenance: { model: "gpt-5.5", reasoningEffort: "high" } } } as unknown,
    }));
    assert.equal(sig.plannerModel, "gpt-5.5");
    assert.equal(sig.plannerReasoningEffort, "high");
  });

  it("the signature key groups identical rows and separates different scenarios", () => {
    const a = deriveAttemptSignature(attempt({ evalScenarioKey: "generic_t2i", generationMode: "t2i" }));
    const b = deriveAttemptSignature(attempt({ evalScenarioKey: "generic_t2i", generationMode: "t2i" }));
    const c = deriveAttemptSignature(attempt({ evalScenarioKey: "i2i_male_default", generationMode: "i2i", subjectRenderMode: "human_identity_i2i" }));
    assert.equal(attemptSignatureKey(a), attemptSignatureKey(b));
    assert.notEqual(attemptSignatureKey(a), attemptSignatureKey(c));
  });
});
