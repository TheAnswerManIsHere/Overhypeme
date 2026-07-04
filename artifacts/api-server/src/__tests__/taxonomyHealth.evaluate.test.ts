/**
 * Taxonomy health evaluator unit tests.
 *
 * Pure function tests — no DB, no LLM. Fact rows are synthesized as plain
 * objects with an `enrichment` JSONB blob (matching what the live `facts`
 * row carries) + the promoted column values. The evaluator returns
 * `FactTaxonomyHealth` which we assert on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFICATION_PROMPT_VERSION,
  currentProcessingSignature,
  validateEnrichment,
} from "@workspace/api-zod";
import { evaluateFactTaxonomyHealth, isEnrichmentAdminEdited } from "../lib/taxonomyHealth";

function VALID_ENRICHMENT(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["strength", "legendary", "pushups"],
    taxonomyConfidence: 0.95,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    enrichedBy: "openai",
    ...overrides,
  };
}

function row(
  enrichment: Record<string, unknown> | null,
  cols: { primaryArchetype?: string | null; subtype?: string | null; overhypeFit?: string | null; adultSuitability?: string | null } = {},
) {
  return {
    factId: 1,
    factText: "David does pushups so hard the planet shifts.",
    enrichment,
    primaryArchetype: cols.primaryArchetype ?? "superhuman_physical_feat",
    subtype: cols.subtype ?? "force_scaled_action",
    overhypeFit: cols.overhypeFit ?? "strong",
    adultSuitability: cols.adultSuitability ?? "safe",
  };
}

describe("evaluateFactTaxonomyHealth", () => {
  it("returns healthy for a fully-enriched, well-projected fact", () => {
    const h = evaluateFactTaxonomyHealth({ fact: row(VALID_ENRICHMENT()) });
    assert.equal(h.overallStatus, "healthy");
    assert.deepEqual(h.statuses, ["complete"]);
    assert.equal(h.issues.length, 0);
  });

  it("flags missing_enrichment when enrichment is null", () => {
    const h = evaluateFactTaxonomyHealth({ fact: row(null) });
    assert.equal(h.overallStatus, "missing");
    assert.ok(h.statuses.includes("missing_enrichment"));
    assert.equal(h.issues[0]?.recommendedAction, "rerun_enrichment");
  });

  it("flags invalid_enrichment when the blob fails validation", () => {
    const broken = VALID_ENRICHMENT({ subtype: "not_a_real_subtype" });
    const h = evaluateFactTaxonomyHealth({ fact: row(broken) });
    assert.equal(h.reviewFlags.invalidEnrichment, true);
    assert.ok(h.statuses.includes("invalid_enrichment"));
    assert.equal(h.overallStatus, "broken");
  });

  it("flags low_confidence + needs_admin_review when confidence < 0.75", () => {
    const h = evaluateFactTaxonomyHealth({ fact: row(VALID_ENRICHMENT({ taxonomyConfidence: 0.5 })) });
    assert.equal(h.reviewFlags.lowConfidence, true);
    assert.ok(h.statuses.includes("low_confidence"));
    assert.ok(h.statuses.includes("needs_admin_review"));
  });

  it("flags questionable_fit when overhypeFit is questionable", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: row(VALID_ENRICHMENT({ overhypeFit: "questionable" }), { overhypeFit: "questionable" }),
    });
    assert.equal(h.reviewFlags.questionableFit, true);
    assert.ok(h.statuses.includes("questionable_fit"));
  });

  it("flags reject fit at error severity", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: row(VALID_ENRICHMENT({ overhypeFit: "reject" }), { overhypeFit: "reject" }),
    });
    assert.equal(h.reviewFlags.rejectFit, true);
    assert.equal(h.overallStatus, "broken");
    assert.ok(h.issues.some((i) => i.code === "questionable_fit" && i.severity === "error"));
  });

  it("flags adult requires_review", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: row(VALID_ENRICHMENT({ adultSuitability: "requires_review" }), { adultSuitability: "requires_review" }),
    });
    assert.equal(h.reviewFlags.adultRequiresReview, true);
  });

  it("flags cultural reference missing visualImplication", () => {
    const e = VALID_ENRICHMENT({
      culturalReferences: [
        {
          sourcePhrase: "Victoria's secret",
          referenceType: "brand_reference",
          canonicalReference: "Victoria's Secret",
          explanation: "fashion brand",
          visualImplication: "", // missing
          confidence: 0.9,
          requiresAdminReview: false,
        },
      ],
    });
    const h = evaluateFactTaxonomyHealth({ fact: row(e) });
    assert.equal(h.reviewFlags.culturalReferenceNeedsResearch, true);
    assert.ok(h.statuses.includes("incomplete_cultural_references"));
  });

  it("flags semantic entity with requiresAdminReview=true", () => {
    const e = VALID_ENRICHMENT({
      semanticEntities: [
        {
          surfaceText: "Earth",
          normalizedText: "earth",
          entityKind: "celestial_body",
          visualReferent: "the planet Earth",
          capitalizationSignal: "sentence_initial_ambiguous",
          materiallyAffectsVisualPrompt: true,
          requiresAdminReview: true,
          confidence: 0.7,
          notes: "sentence-initial",
        },
      ],
    });
    const h = evaluateFactTaxonomyHealth({ fact: row(e) });
    assert.equal(h.reviewFlags.semanticEntityNeedsReview, true);
    assert.ok(h.statuses.includes("semantic_entities_need_review"));
  });

  it("flags info-level hint when fact text contains a capitalization-sensitive term but no semantic entities", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: {
        ...row(VALID_ENRICHMENT()),
        factText: "David pushes the Earth down with one hand.",
      },
    });
    const hint = h.issues.find((i) => i.code === "semantic_entities_need_review" && i.severity === "info");
    assert.ok(hint, "expected info-level semantic_entities_need_review hint");
    // info-level shouldn't trip the boolean flag (which gates bulk actions).
    assert.equal(h.reviewFlags.semanticEntityNeedsReview, false);
  });

  it("does NOT compute any visual-preview staleness (preview subsystem retired)", () => {
    const e = VALID_ENRICHMENT();
    const h = evaluateFactTaxonomyHealth({ fact: row(e) });
    assert.ok(!h.statuses.includes("stale_enrichment_version"));
    // The retired stale_visual_preview status must never appear.
    assert.ok(!(h.statuses as string[]).includes("stale_visual_preview"));
    assert.ok(!("stalePreview" in h.reviewFlags));
  });

  it("flags stale_enrichment_version when classificationPromptVersion is behind", () => {
    const e = VALID_ENRICHMENT({ classificationPromptVersion: "v1" });
    const h = evaluateFactTaxonomyHealth({ fact: row(e) });
    assert.equal(h.reviewFlags.staleEnrichmentVersion, true);
    assert.ok(h.statuses.includes("stale_enrichment_version"));
  });

  it("flags stale_enrichment_version at info-level when the field is missing entirely", () => {
    const e = VALID_ENRICHMENT();
    delete (e as Record<string, unknown>)["classificationPromptVersion"];
    const h = evaluateFactTaxonomyHealth({ fact: row(e) });
    assert.equal(h.reviewFlags.staleEnrichmentVersion, true);
    const issue = h.issues.find((i) => i.code === "stale_enrichment_version");
    assert.equal(issue?.severity, "info");
  });

  it("flags projection_mismatch when promoted columns don't match enrichment", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: row(VALID_ENRICHMENT(), { primaryArchetype: "intellectual_omniscience" }),
    });
    assert.equal(h.reviewFlags.projectionMismatch, true);
    assert.ok(h.statuses.includes("projection_mismatch"));
    assert.match(h.issues.find((i) => i.code === "projection_mismatch")!.message, /primaryArchetype/);
  });

  it("issues recommendedAction repair_projection_columns on mismatch", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: row(VALID_ENRICHMENT(), { subtype: "wrong_subtype" }),
    });
    const issue = h.issues.find((i) => i.code === "projection_mismatch");
    assert.equal(issue?.recommendedAction, "repair_projection_columns");
  });

  // ─── stale_for_reprocess (processing-signature staleness) ─────────────────

  const CURRENT_SIG = currentProcessingSignature(3);

  it("does NOT flag stale_for_reprocess when no currentSignature is supplied", () => {
    // Backward-compatible: the lens is opt-in per call.
    const h = evaluateFactTaxonomyHealth({
      fact: { ...row(VALID_ENRICHMENT()), lastProcessedSignature: null },
    });
    assert.equal(h.reviewFlags.staleForReprocess, false);
    assert.ok(!h.statuses.includes("stale_for_reprocess"));
  });

  it("flags stale_for_reprocess (never_processed) for a null signature", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: { ...row(VALID_ENRICHMENT()), lastProcessedSignature: null },
      currentSignature: CURRENT_SIG,
    });
    assert.equal(h.reviewFlags.staleForReprocess, true);
    assert.ok(h.statuses.includes("stale_for_reprocess"));
    const issue = h.issues.find((i) => i.code === "stale_for_reprocess");
    assert.equal(issue?.severity, "info");
    assert.equal(issue?.recommendedAction, "send_back_to_review");
    assert.notEqual(issue?.recommendedAction, "rerun_enrichment");
    assert.match(issue!.message, /never been processed/);
  });

  it("does NOT flag stale_for_reprocess when the signature matches current", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: { ...row(VALID_ENRICHMENT()), lastProcessedSignature: { ...CURRENT_SIG } },
      currentSignature: CURRENT_SIG,
    });
    assert.equal(h.reviewFlags.staleForReprocess, false);
    assert.ok(!h.statuses.includes("stale_for_reprocess"));
  });

  it("flags stale_for_reprocess (engine_revision) when the engine revision is behind", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: {
        ...row(VALID_ENRICHMENT()),
        lastProcessedSignature: { ...CURRENT_SIG, engineRevision: CURRENT_SIG.engineRevision - 1 },
      },
      currentSignature: CURRENT_SIG,
    });
    assert.equal(h.reviewFlags.staleForReprocess, true);
    const issue = h.issues.find((i) => i.code === "stale_for_reprocess");
    assert.equal(issue?.recommendedAction, "send_back_to_review");
    assert.match(issue!.message, /older engine revision/);
  });

  it("flags stale_for_reprocess (code_version) when a code-version field is behind", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: {
        ...row(VALID_ENRICHMENT()),
        lastProcessedSignature: { ...CURRENT_SIG, taxonomyVersion: "v0" },
      },
      currentSignature: CURRENT_SIG,
    });
    assert.equal(h.reviewFlags.staleForReprocess, true);
    const issue = h.issues.find((i) => i.code === "stale_for_reprocess");
    assert.match(issue!.message, /code versions/);
  });

  it("keeps a stale-for-reprocess-only fact overall healthy (info severity)", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: { ...row(VALID_ENRICHMENT()), lastProcessedSignature: null },
      currentSignature: CURRENT_SIG,
    });
    assert.equal(h.reviewFlags.staleForReprocess, true);
    assert.equal(h.overallStatus, "healthy");
  });

  it("does NOT flag stale_for_reprocess on a missing_enrichment fact (valid-only scope)", () => {
    const h = evaluateFactTaxonomyHealth({
      fact: { ...row(null), lastProcessedSignature: null },
      currentSignature: CURRENT_SIG,
    });
    assert.ok(h.statuses.includes("missing_enrichment"));
    assert.equal(h.reviewFlags.staleForReprocess, false);
    assert.ok(!h.statuses.includes("stale_for_reprocess"));
  });

  it("does NOT flag stale_for_reprocess on an invalid_enrichment fact (valid-only scope)", () => {
    const broken = VALID_ENRICHMENT({ subtype: "not_a_real_subtype" });
    const h = evaluateFactTaxonomyHealth({
      fact: { ...row(broken), lastProcessedSignature: null },
      currentSignature: CURRENT_SIG,
    });
    assert.equal(h.reviewFlags.invalidEnrichment, true);
    assert.equal(h.reviewFlags.staleForReprocess, false);
    assert.ok(!h.statuses.includes("stale_for_reprocess"));
  });
});

describe("isEnrichmentAdminEdited", () => {
  it("returns true when enrichedBy === 'admin'", () => {
    const e = VALID_ENRICHMENT({ enrichedBy: "admin" });
    // The function takes a validated FactEnrichment — re-validate via the wire shape.
    const validated = validateEnrichment(e);
    assert.equal(validated.ok, true);
    if (validated.ok) assert.equal(isEnrichmentAdminEdited(validated.data), true);
  });

  it("returns true when adminReviewNotes is non-empty", () => {
    const e = VALID_ENRICHMENT({ adminReviewNotes: "swapped subtype" });
    const validated = validateEnrichment(e);
    assert.equal(validated.ok, true);
    if (validated.ok) assert.equal(isEnrichmentAdminEdited(validated.data), true);
  });

  it("returns false for vanilla openai enrichment", () => {
    const validated = validateEnrichment(VALID_ENRICHMENT());
    assert.equal(validated.ok, true);
    if (validated.ok) assert.equal(isEnrichmentAdminEdited(validated.data), false);
  });
});
