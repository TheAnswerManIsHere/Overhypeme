/**
 * Taxonomy health evaluator.
 *
 * `evaluateFactTaxonomyHealth(input)` takes a fact row (text + promoted
 * columns + the raw `enrichment` JSONB) plus the current version constants,
 * and returns a `FactTaxonomyHealth` describing what (if anything) needs
 * attention.
 *
 * Pure function — no DB, no LLM, no IO. The route handler reads the
 * relevant facts in batches and feeds them through here per request.
 * Dynamic computation per spec; if perf degrades at scale we can persist
 * snapshots later.
 *
 * Versions checked:
 *  - `enrichment.classificationPromptVersion` vs `CLASSIFICATION_PROMPT_VERSION`
 *  - `enrichment.visualPromptPreview.previewPromptVersion` vs
 *    `PREVIEW_PROMPT_VERSION`
 * `VISUAL_STRATEGY_VERSION` doesn't appear in stored data today; we record
 * it on the summary for visibility but don't gate stale-preview on it.
 *
 * Admin-edited signal (used by bulk re-enrich):
 *  - `enrichment.enrichedBy === "admin"` OR
 *  - `enrichment.adminReviewNotes` non-empty after trim
 */

import {
  validateEnrichment,
  buildCapitalizationSensitiveRegex,
  CLASSIFICATION_PROMPT_VERSION,
  PREVIEW_PROMPT_VERSION,
  VISUAL_STRATEGY_VERSION,
  type FactEnrichment,
  type FactTaxonomyHealth,
  type TaxonomyHealthIssue,
  type TaxonomyHealthStatus,
  type TaxonomyHealthSeverity,
  type TaxonomyHealthRecommendedAction,
  type TaxonomyHealthReviewFlags,
  type TaxonomyHealthSummary,
  type TaxonomyOverallStatus,
} from "@workspace/api-zod";
import { buildFactEnrichmentColumns } from "../factEnrichment";

export interface FactRowForHealth {
  factId: number;
  factText: string;
  enrichment: unknown;
  primaryArchetype: string | null;
  subtype: string | null;
  overhypeFit: string | null;
  adultSuitability: string | null;
}

export interface EvaluateFactTaxonomyHealthInput {
  fact: FactRowForHealth;
  /**
   * Optional override of the version constants. Tests pass values here so a
   * fixture can pin a known set. Live callers omit and we read the current
   * `@workspace/api-zod` constants.
   */
  currentVersions?: {
    classificationPromptVersion?: string;
    previewPromptVersion?: string;
    visualStrategyVersion?: string;
  };
}

const LOW_CONFIDENCE_THRESHOLD = 0.75;
const CAP_SENSITIVE_RE = buildCapitalizationSensitiveRegex();

export function evaluateFactTaxonomyHealth(
  input: EvaluateFactTaxonomyHealthInput,
): FactTaxonomyHealth {
  const versions = {
    classification:
      input.currentVersions?.classificationPromptVersion ?? CLASSIFICATION_PROMPT_VERSION,
    preview: input.currentVersions?.previewPromptVersion ?? PREVIEW_PROMPT_VERSION,
    strategy: input.currentVersions?.visualStrategyVersion ?? VISUAL_STRATEGY_VERSION,
  };
  const { fact } = input;

  const issues: TaxonomyHealthIssue[] = [];
  const statuses = new Set<TaxonomyHealthStatus>();
  const flags: TaxonomyHealthReviewFlags = {
    lowConfidence: false,
    questionableFit: false,
    rejectFit: false,
    adultRequiresReview: false,
    culturalReferenceNeedsResearch: false,
    semanticEntityNeedsReview: false,
    missingPreview: false,
    stalePreview: false,
    staleEnrichmentVersion: false,
    projectionMismatch: false,
    invalidEnrichment: false,
  };

  // 1. Missing enrichment
  if (fact.enrichment == null || isEmptyObject(fact.enrichment)) {
    addIssue(issues, statuses, {
      code: "missing_enrichment",
      severity: "error",
      message: "Fact has no enrichment blob.",
      recommendedAction: "rerun_enrichment",
    });
    return finalize(fact, issues, statuses, flags, buildSummary(fact, null, null));
  }

  // 2. Invalid enrichment
  const validation = validateEnrichment(fact.enrichment);
  if (!validation.ok) {
    flags.invalidEnrichment = true;
    addIssue(issues, statuses, {
      code: "invalid_enrichment",
      severity: "error",
      message: `Enrichment fails validation: ${validation.error}`,
      recommendedAction: validation.subtypeMismatch ? "open_fact_editor" : "rerun_enrichment",
    });
    // Even with invalid enrichment, surface the raw blob's archetype/subtype
    // in the summary so admins can spot the problem at a glance.
    const rawEnrichment = fact.enrichment as Partial<FactEnrichment>;
    return finalize(
      fact,
      issues,
      statuses,
      flags,
      buildSummary(fact, null, rawEnrichment),
    );
  }
  const e = validation.data;

  // 3. Low confidence
  if (e.taxonomyConfidence < LOW_CONFIDENCE_THRESHOLD) {
    flags.lowConfidence = true;
    addIssue(issues, statuses, {
      code: "low_confidence",
      severity: "warning",
      message: `taxonomyConfidence ${e.taxonomyConfidence.toFixed(2)} is below ${LOW_CONFIDENCE_THRESHOLD}`,
      recommendedAction: "open_fact_editor",
    });
    statuses.add("needs_admin_review");
  }

  // 4. Questionable / reject fit
  if (e.overhypeFit === "questionable") {
    flags.questionableFit = true;
    addIssue(issues, statuses, {
      code: "questionable_fit",
      severity: "warning",
      message: "overhypeFit is \"questionable\" — admin should weigh in.",
      recommendedAction: "open_fact_editor",
    });
    statuses.add("needs_admin_review");
  }
  if (e.overhypeFit === "reject") {
    flags.rejectFit = true;
    addIssue(issues, statuses, {
      code: "questionable_fit",
      severity: "error",
      message: "overhypeFit is \"reject\" — fact should likely be removed or rewritten.",
      recommendedAction: "open_fact_editor",
    });
    statuses.add("needs_admin_review");
  }

  // 5. Adult suitability review
  if (e.adultSuitability === "requires_review") {
    flags.adultRequiresReview = true;
    addIssue(issues, statuses, {
      code: "needs_admin_review",
      severity: "warning",
      message: "adultSuitability is \"requires_review\".",
      recommendedAction: "open_fact_editor",
    });
  }

  // 6. Cultural references needing research
  for (const ref of e.culturalReferences) {
    const hasReferenceIdentity =
      ref.sourcePhrase.trim().length > 0 ||
      ref.canonicalReference.trim().length > 0;
    const missingResearchValue =
      ref.explanation.trim().length === 0 ||
      ref.visualImplication.trim().length === 0;
    const lowResearchConfidence = ref.researchConfidence === "low";
    const hasAmbiguityWarnings =
      Array.isArray(ref.ambiguityWarnings) && ref.ambiguityWarnings.length > 0;
    const requiresAdminReview = ref.requiresAdminReview;
    if (
      hasReferenceIdentity &&
      (missingResearchValue || lowResearchConfidence || hasAmbiguityWarnings || requiresAdminReview)
    ) {
      flags.culturalReferenceNeedsResearch = true;
      addIssue(issues, statuses, {
        code: "incomplete_cultural_references",
        severity: missingResearchValue ? "warning" : "info",
        message: missingResearchValue
          ? `Cultural reference "${ref.sourcePhrase || ref.canonicalReference}" is missing ${ref.visualImplication.trim() === "" ? "visualImplication" : "explanation"}.`
          : `Cultural reference "${ref.sourcePhrase || ref.canonicalReference}" needs admin review.`,
        recommendedAction: "research_cultural_reference",
      });
      statuses.add("needs_admin_review");
      break; // one issue per fact for this code is enough
    }
  }

  // 7. Semantic entities needing review
  const semanticEntities = e.semanticEntities ?? [];
  const semanticReviewEntity = semanticEntities.find(
    (s) =>
      s.requiresAdminReview ||
      s.confidence < LOW_CONFIDENCE_THRESHOLD ||
      s.entityKind === "ambiguous" ||
      s.capitalizationSignal === "sentence_initial_ambiguous",
  );
  if (semanticReviewEntity) {
    flags.semanticEntityNeedsReview = true;
    addIssue(issues, statuses, {
      code: "semantic_entities_need_review",
      severity: "warning",
      message: `Semantic entity "${semanticReviewEntity.surfaceText}" flagged for review.`,
      recommendedAction: "review_semantic_entity",
    });
    statuses.add("needs_admin_review");
  }

  // 8. Capitalization-sensitive text without any semanticEntities at all
  if (semanticEntities.length === 0 && CAP_SENSITIVE_RE.test(fact.factText)) {
    addIssue(issues, statuses, {
      code: "semantic_entities_need_review",
      severity: "info",
      message:
        "Fact text contains a known capitalization-sensitive term but no semantic entities were emitted.",
      recommendedAction: "rerun_enrichment",
    });
    // info-level — don't mark flag true; it's a hint not a required fix.
  }

  // 9. Visual preview presence + 10. staleness
  const preview = e.visualPromptPreview;
  if (!preview) {
    flags.missingPreview = true;
    addIssue(issues, statuses, {
      code: "missing_visual_preview",
      severity: "warning",
      message: "No visual prompt preview generated for this fact.",
      recommendedAction: "regenerate_visual_preview",
    });
  } else if (
    preview.previewPromptVersion != null &&
    preview.previewPromptVersion !== versions.preview
  ) {
    flags.stalePreview = true;
    addIssue(issues, statuses, {
      code: "stale_visual_preview",
      severity: "warning",
      message: `Preview was generated under previewPromptVersion="${preview.previewPromptVersion}" (current is "${versions.preview}").`,
      recommendedAction: "regenerate_visual_preview",
    });
  }

  // 11. Stale enrichment prompt version
  if (
    e.classificationPromptVersion != null &&
    e.classificationPromptVersion !== versions.classification
  ) {
    flags.staleEnrichmentVersion = true;
    addIssue(issues, statuses, {
      code: "stale_enrichment_version",
      severity: "warning",
      message: `Enrichment classified under classificationPromptVersion="${e.classificationPromptVersion}" (current is "${versions.classification}").`,
      recommendedAction: "rerun_enrichment",
    });
  } else if (e.classificationPromptVersion == null) {
    // Missing version field on an otherwise valid enrichment — flag as stale,
    // not invalid.
    flags.staleEnrichmentVersion = true;
    addIssue(issues, statuses, {
      code: "stale_enrichment_version",
      severity: "info",
      message: `Enrichment has no classificationPromptVersion field — pre-versioned enrichment.`,
      recommendedAction: "rerun_enrichment",
    });
  }

  // 12. Projection-column mismatch
  const projected = buildFactEnrichmentColumns(e);
  const projectionDiffs: string[] = [];
  if (fact.primaryArchetype !== projected.primaryArchetype) {
    projectionDiffs.push(
      `primaryArchetype: stored="${fact.primaryArchetype ?? "(null)"}" derived="${projected.primaryArchetype}"`,
    );
  }
  if (fact.subtype !== projected.subtype) {
    projectionDiffs.push(
      `subtype: stored="${fact.subtype ?? "(null)"}" derived="${projected.subtype}"`,
    );
  }
  if (fact.overhypeFit !== projected.overhypeFit) {
    projectionDiffs.push(
      `overhypeFit: stored="${fact.overhypeFit ?? "(null)"}" derived="${projected.overhypeFit}"`,
    );
  }
  if (fact.adultSuitability !== projected.adultSuitability) {
    projectionDiffs.push(
      `adultSuitability: stored="${fact.adultSuitability ?? "(null)"}" derived="${projected.adultSuitability}"`,
    );
  }
  if (projectionDiffs.length > 0) {
    flags.projectionMismatch = true;
    addIssue(issues, statuses, {
      code: "projection_mismatch",
      severity: "warning",
      message: `Promoted columns don't match enrichment: ${projectionDiffs.join("; ")}`,
      recommendedAction: "repair_projection_columns",
    });
  }

  return finalize(fact, issues, statuses, flags, buildSummary(fact, preview, e));
}

// ─── Admin-edited signal ──────────────────────────────────────────────────

/**
 * Returns true when the enrichment blob carries an admin-edited signal —
 * either `enrichedBy === "admin"` or non-empty `adminReviewNotes`.
 * Used by bulk re-enrich to skip rows the admin curated.
 */
export function isEnrichmentAdminEdited(enrichment: FactEnrichment): boolean {
  if (enrichment.enrichedBy === "admin") return true;
  if (enrichment.adminReviewNotes.trim().length > 0) return true;
  return false;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function addIssue(
  issues: TaxonomyHealthIssue[],
  statuses: Set<TaxonomyHealthStatus>,
  issue: TaxonomyHealthIssue,
): void {
  issues.push(issue);
  statuses.add(issue.code);
}

function finalize(
  fact: FactRowForHealth,
  issues: TaxonomyHealthIssue[],
  statuses: Set<TaxonomyHealthStatus>,
  flags: TaxonomyHealthReviewFlags,
  summary: TaxonomyHealthSummary,
): FactTaxonomyHealth {
  if (statuses.size === 0) {
    statuses.add("complete");
  }
  return {
    factId: fact.factId,
    overallStatus: deriveOverallStatus(issues, statuses),
    statuses: Array.from(statuses),
    issues,
    reviewFlags: flags,
    summary,
  };
}

function deriveOverallStatus(
  issues: TaxonomyHealthIssue[],
  statuses: Set<TaxonomyHealthStatus>,
): TaxonomyOverallStatus {
  if (statuses.has("missing_enrichment")) return "missing";
  if (issues.some((i) => i.severity === "error")) return "broken";
  const staleOnly =
    statuses.has("stale_enrichment_version") || statuses.has("stale_visual_preview");
  const anyAttention = issues.some(
    (i) => i.severity === "warning" || i.severity === "error",
  );
  if (anyAttention) return "needs_attention";
  if (staleOnly) return "stale";
  return "healthy";
}

function buildSummary(
  fact: FactRowForHealth,
  preview: FactEnrichment["visualPromptPreview"] | null,
  enrichment: Partial<FactEnrichment> | null,
): TaxonomyHealthSummary {
  return {
    primaryArchetype: enrichment?.primaryArchetype ?? fact.primaryArchetype ?? null,
    subtype: enrichment?.subtype ?? fact.subtype ?? null,
    taxonomyConfidence: enrichment?.taxonomyConfidence ?? null,
    overhypeFit: enrichment?.overhypeFit ?? fact.overhypeFit ?? null,
    adultSuitability: enrichment?.adultSuitability ?? fact.adultSuitability ?? null,
    taxonomyVersion: enrichment?.taxonomyVersion ?? null,
    classificationPromptVersion: enrichment?.classificationPromptVersion ?? null,
    // VISUAL_STRATEGY_VERSION isn't stored per-fact today; surface the current
    // constant for visibility. When/if it lands on the preview blob, point
    // this at preview.visualStrategyVersion instead.
    visualStrategyVersion: VISUAL_STRATEGY_VERSION,
    visualPreviewVersion: preview?.previewPromptVersion ?? null,
    enrichedAt: enrichment?.enrichedAt ?? null,
    previewGeneratedAt: preview?.generatedAt ?? null,
    enrichedBy: enrichment?.enrichedBy ?? null,
  };
}

function isEmptyObject(v: unknown): boolean {
  return (
    v != null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length === 0
  );
}

export { repairFactEnrichmentProjection } from "./projectionRepair";
