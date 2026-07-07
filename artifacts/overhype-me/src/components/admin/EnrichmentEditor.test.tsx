/**
 * isFixableRoleEntityTokenIssue — the narrow Save-disable gate exception.
 *
 * Adding the schema-level backstop that rejects a personalization token in
 * `roleBindings[i].entity` would make `validateEnrichment(e).ok` false and
 * hard-disable the Save button — breaking the "click Save → tokenize →
 * red-border the row" flow `tokenizeAndSaveVisualOverride` is supposed to
 * drive. This filter must exclude ONLY that exact, path-specific issue from
 * the Save-disable predicate; every other validity error must still disable
 * Save. These tests exercise the filter against the real
 * `validateEnrichment` error-string format (not a hand-written stand-in),
 * so a change to that format's shape (dot vs bracket path notation, message
 * wording) fails here rather than silently breaking the gate at runtime.
 */

import { describe, it, expect } from "vitest";
import { validateEnrichment, type FactEnrichment } from "@workspace/api-zod";
import { isFixableRoleEntityTokenIssue } from "./EnrichmentEditor";

function makeEnrichment(over: Partial<FactEnrichment> = {}): FactEnrichment {
  return {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["strength", "legendary", "coffee"],
    taxonomyConfidence: 0.9,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    ...over,
  } as FactEnrichment;
}

const VSO = {
  version: 1 as const,
  enabled: true,
  requiredVisualDetails: [],
  forbiddenVisualDetails: [],
  roleBindings: [{ entity: "mother", visualRole: "role" }],
  compositionGuidance: [],
  styleAgnosticPromptAdditions: [],
  negativePromptAdditions: [],
};

function nonFixableErrors(enrichment: FactEnrichment): string[] {
  const validity = validateEnrichment(enrichment);
  if (validity.ok) return [];
  return validity.error.split("; ").filter((err) => !isFixableRoleEntityTokenIssue(err));
}

describe("isFixableRoleEntityTokenIssue", () => {
  it("POSITIVE: a valid {NAME} token in roleBindings[0].entity does not hard-disable Save", () => {
    const enrichment = makeEnrichment({
      visualPromptStrategyOverride: {
        ...VSO,
        roleBindings: [{ entity: "{NAME}", visualRole: "role" }],
      },
    });
    const validity = validateEnrichment(enrichment);
    expect(validity.ok).toBe(false); // the schema DOES reject it...
    expect(nonFixableErrors(enrichment)).toEqual([]); // ...but it's filtered out of the Save gate
  });

  it("NEGATIVE 1: an unknown/malformed token in a prose field still disables Save", () => {
    const enrichment = makeEnrichment({
      visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "a scene starring {BOGUS}" },
    });
    const validity = validateEnrichment(enrichment);
    expect(validity.ok).toBe(false);
    expect(nonFixableErrors(enrichment).length).toBeGreaterThan(0);
  });

  it("NEGATIVE 2: a non-VSO invalid enrichment field still disables Save", () => {
    // suggestedHashtags requires 3-8 entries — 1 tag is invalid, unrelated to VSO.
    const enrichment = makeEnrichment({ suggestedHashtags: ["onlyone"] });
    const validity = validateEnrichment(enrichment);
    expect(validity.ok).toBe(false);
    expect(nonFixableErrors(enrichment).length).toBeGreaterThan(0);
  });

  it("NEGATIVE 3: a VSO cap/length error (not the role-entity token issue) still disables Save", () => {
    const enrichment = makeEnrichment({
      visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "x".repeat(1501) },
    });
    const validity = validateEnrichment(enrichment);
    expect(validity.ok).toBe(false);
    expect(nonFixableErrors(enrichment).length).toBeGreaterThan(0);
  });

  it("does not match a broad visualPromptStrategyOverride: prefix, only the exact role-entity issue", () => {
    expect(isFixableRoleEntityTokenIssue("visualPromptStrategyOverride: some other error")).toBe(false);
    expect(isFixableRoleEntityTokenIssue("visualPromptStrategyOverride.coreSceneOverride: unknown token")).toBe(false);
    expect(
      isFixableRoleEntityTokenIssue(
        "visualPromptStrategyOverride.roleBindings.2.entity: personalization tokens are not allowed here — use \"subject\" or a plain role label instead",
      ),
    ).toBe(true);
  });

  it("a valid (non-token) role entity produces no VSO errors at all", () => {
    const enrichment = makeEnrichment({ visualPromptStrategyOverride: VSO });
    expect(validateEnrichment(enrichment).ok).toBe(true);
  });
});
