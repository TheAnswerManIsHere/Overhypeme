/**
 * The Visual Idea input hash reads only what the gag writer reads: the fact,
 * its gags, the prompt and the engine. The taxonomy is not an input since the
 * stage cutover (Issue #1018, increment 1.2c-ii), so a taxonomy run finishing
 * after the ideas, or a classification edit, leaves them current.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";
import { buildVisualConceptInputHash, type VisualConceptHashInputs } from "../lib/visualConcepts/inputHash.js";

const base = (): VisualConceptHashInputs => ({
  reviewId: 1,
  source: "staging_fact",
  factText: "When Alex was born, they drove their mom home from the hospital.",
  systemPromptHash: "h",
  engineId: "e",
  model: "m",
  reasoningEffort: "high",
  gags: [],
});

describe("buildVisualConceptInputHash", () => {
  it("ignores a classification passed beside its inputs (the writer no longer reads one)", () => {
    const a = buildVisualConceptInputHash(base());
    const withClassification = { ...base(), enrichment: { ...buildPlaceholderFactEnrichment(), modifiers: ["baby_child_version"] } };
    assert.equal(buildVisualConceptInputHash(withClassification as VisualConceptHashInputs), a);
  });

  it("changes when the fact's gags change", () => {
    const a = buildVisualConceptInputHash(base());
    const b = { ...base(), gags: [{ scene: "Alex carries the hospital out on one shoulder.", bubbles: [] }] };
    assert.notEqual(buildVisualConceptInputHash(b), a);
  });

  it("changes when the fact text or the engine changes", () => {
    const a = buildVisualConceptInputHash(base());
    assert.notEqual(buildVisualConceptInputHash({ ...base(), factText: "Alex drove the ambulance." }), a);
    assert.notEqual(buildVisualConceptInputHash({ ...base(), model: "m2" }), a);
  });
});
