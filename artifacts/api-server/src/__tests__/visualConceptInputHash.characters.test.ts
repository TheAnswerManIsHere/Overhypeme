/**
 * The Visual Idea input hash ignores the fact character list: only the render
 * planner reads it (PLAN_BUBBLE_SPEAKERS.md, F), so filling or correcting the
 * list must not mark Visual Ideas out of date.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";
import { buildVisualConceptInputHash } from "../lib/visualConcepts/inputHash.js";

const base = () => ({
  reviewId: 1,
  candidateVersionId: null,
  source: "moderation",
  factText: "When Alex was born, they drove their mom home from the hospital.",
  enrichment: buildPlaceholderFactEnrichment(),
  systemPromptHash: "h",
  engineId: "e",
  model: "m",
  reasoningEffort: "high",
  gags: [],
}) as unknown as Parameters<typeof buildVisualConceptInputHash>[0];

describe("buildVisualConceptInputHash — fact characters", () => {
  it("does not change when the character list changes", () => {
    const a = buildVisualConceptInputHash(base());
    const withList = base();
    (withList as { enrichment: { characters: unknown[] } }).enrichment = {
      ...buildPlaceholderFactEnrichment(),
      characters: [{ label: "mom", kind: "person", ofSubject: true }],
    };
    assert.equal(buildVisualConceptInputHash(withList), a);
  });

  it("still changes when a field the Visual Idea writer reads changes", () => {
    const a = buildVisualConceptInputHash(base());
    const b = base();
    (b as { enrichment: { modifiers: string[] } }).enrichment = { ...buildPlaceholderFactEnrichment(), modifiers: ["baby_child_version"] };
    assert.notEqual(buildVisualConceptInputHash(b), a);
  });
});
