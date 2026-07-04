/**
 * Eval harness (Slice 2B) — pure unit tests (no DB / no LLM):
 *   - resolveEvalColumns clear-semantics (omitted vs null vs value; empty notes
 *     → null; rating/failureTag independent).
 *   - deriveAttemptSignature: t2i vs i2i differ on the ACTUAL image engine (not
 *     the coarse targetEngine); missing inputs bucket as "unknown"; the signature
 *     key groups like rows and separates unlike ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveEvalColumns,
  evalColumnUpdateIsEmpty,
  attemptSignatureKey,
} from "@workspace/api-zod";
import type { ImagePromptAttempt } from "@workspace/db";
import { deriveAttemptSignature } from "../lib/eval/signature.js";

describe("resolveEvalColumns", () => {
  it("omitted keys are left out (leave unchanged); present keys are included", () => {
    assert.deepEqual(resolveEvalColumns({}), {});
    assert.deepEqual(resolveEvalColumns({ rating: 4 }), { moderatorRating: 4 });
    assert.deepEqual(resolveEvalColumns({ failureTag: "compiler" }), { failureTag: "compiler" });
  });

  it("explicit null clears; rating and failureTag are independent", () => {
    assert.deepEqual(resolveEvalColumns({ rating: null }), { moderatorRating: null });
    assert.deepEqual(resolveEvalColumns({ failureTag: null }), { failureTag: null });
    // A failure-tag with no rating is valid quick-triage.
    assert.deepEqual(resolveEvalColumns({ failureTag: "concept" }), { failureTag: "concept" });
  });

  it("empty / whitespace notes normalize to null; real notes trim", () => {
    assert.deepEqual(resolveEvalColumns({ notes: "   " }), { evalNotes: null });
    assert.deepEqual(resolveEvalColumns({ notes: "  looks great  " }), { evalNotes: "looks great" });
    assert.deepEqual(resolveEvalColumns({ notes: null }), { evalNotes: null });
  });

  it("evalColumnUpdateIsEmpty detects a no-op write", () => {
    assert.equal(evalColumnUpdateIsEmpty(resolveEvalColumns({})), true);
    assert.equal(evalColumnUpdateIsEmpty(resolveEvalColumns({ rating: 3 })), false);
  });
});

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
