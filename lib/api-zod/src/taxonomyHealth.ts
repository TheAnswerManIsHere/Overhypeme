/**
 * Taxonomy health — shared types for the admin Taxonomy Health workbench.
 *
 * Lives in @workspace/api-zod so the API server (evaluator + routes) and the
 * admin UI (summary cards, filters, badges) consume the same vocabulary.
 *
 * The evaluator (`evaluateFactTaxonomyHealth`) lives server-side because it
 * needs `buildFactEnrichmentColumns` from the api-server lib + the current
 * version constants from this package.
 */

export const TAXONOMY_HEALTH_STATUS_VALUES = [
  "complete",
  "missing_enrichment",
  "invalid_enrichment",
  "needs_admin_review",
  "stale_enrichment_version",
  "missing_visual_preview",
  "stale_visual_preview",
  "projection_mismatch",
  "incomplete_cultural_references",
  "semantic_entities_need_review",
  "low_confidence",
  "questionable_fit",
] as const;
export type TaxonomyHealthStatus = (typeof TAXONOMY_HEALTH_STATUS_VALUES)[number];

export const TAXONOMY_OVERALL_STATUS_VALUES = [
  "healthy",
  "needs_attention",
  "broken",
  "stale",
  "missing",
] as const;
export type TaxonomyOverallStatus = (typeof TAXONOMY_OVERALL_STATUS_VALUES)[number];

export const TAXONOMY_HEALTH_RECOMMENDED_ACTION_VALUES = [
  "open_fact_editor",
  "rerun_enrichment",
  "regenerate_visual_preview",
  "research_cultural_reference",
  "review_semantic_entity",
  "repair_projection_columns",
  "manual_review",
  "none",
] as const;
export type TaxonomyHealthRecommendedAction =
  (typeof TAXONOMY_HEALTH_RECOMMENDED_ACTION_VALUES)[number];

export type TaxonomyHealthSeverity = "info" | "warning" | "error";

export interface TaxonomyHealthIssue {
  code: TaxonomyHealthStatus;
  severity: TaxonomyHealthSeverity;
  message: string;
  recommendedAction: TaxonomyHealthRecommendedAction;
}

export interface TaxonomyHealthReviewFlags {
  lowConfidence: boolean;
  questionableFit: boolean;
  rejectFit: boolean;
  adultRequiresReview: boolean;
  culturalReferenceNeedsResearch: boolean;
  semanticEntityNeedsReview: boolean;
  missingPreview: boolean;
  stalePreview: boolean;
  staleEnrichmentVersion: boolean;
  projectionMismatch: boolean;
  invalidEnrichment: boolean;
}

export interface TaxonomyHealthSummary {
  primaryArchetype: string | null;
  subtype: string | null;
  taxonomyConfidence: number | null;
  overhypeFit: string | null;
  adultSuitability: string | null;
  taxonomyVersion: string | null;
  classificationPromptVersion: string | null;
  visualStrategyVersion: string | null;
  visualPreviewVersion: string | null;
  enrichedAt: string | null;
  previewGeneratedAt: string | null;
  /** "openai" | "admin" | other tag stamped during enrichment. */
  enrichedBy: string | null;
}

export interface FactTaxonomyHealth {
  factId: number;
  overallStatus: TaxonomyOverallStatus;
  statuses: TaxonomyHealthStatus[];
  issues: TaxonomyHealthIssue[];
  reviewFlags: TaxonomyHealthReviewFlags;
  summary: TaxonomyHealthSummary;
}

// ─── Capitalization-sensitive term heuristic ──────────────────────────────
//
// Surfaces facts that mention a known capitalization-sensitive term BUT have
// no `semanticEntities` entry. Doc-flagged as "info" severity — not every
// fact with these terms needs entities, but the absence is worth a hint.

export const CAPITALIZATION_SENSITIVE_TERMS = [
  "earth",
  "sun",
  "moon",
  "world",
  "universe",
  "time",
  "law",
  "death",
  "dark",
  "light",
  "heaven",
  "hell",
  "god",
  "apple",
  "windows",
  "amazon",
] as const;

/** Lowercased word-boundary regex; case-insensitive. */
export function buildCapitalizationSensitiveRegex(): RegExp {
  return new RegExp(`\\b(${CAPITALIZATION_SENSITIVE_TERMS.join("|")})\\b`, "i");
}

// ─── Bulk action vocabulary ───────────────────────────────────────────────

export const TAXONOMY_HEALTH_BULK_ACTION_MODE_VALUES = [
  "missing_only",
  "stale_only",
  "missing_or_stale",
  "selected_fact_ids",
] as const;
export type TaxonomyHealthBulkActionMode =
  (typeof TAXONOMY_HEALTH_BULK_ACTION_MODE_VALUES)[number];

export const PROJECTION_REPAIR_MODE_VALUES = [
  "mismatches_only",
  "selected_fact_ids",
] as const;
export type ProjectionRepairMode = (typeof PROJECTION_REPAIR_MODE_VALUES)[number];

export interface TaxonomyHealthSummaryCounts {
  totalFacts: number;
  healthy: number;
  missingEnrichment: number;
  invalidEnrichment: number;
  needsAdminReview: number;
  missingVisualPreview: number;
  staleVisualPreview: number;
  staleEnrichmentVersion: number;
  projectionMismatch: number;
  incompleteCulturalReferences: number;
  semanticEntitiesNeedReview: number;
  lowConfidence: number;
}
