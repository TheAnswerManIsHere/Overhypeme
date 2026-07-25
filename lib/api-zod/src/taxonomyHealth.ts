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
  "stale_for_reprocess",
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
  // Refresh-first: send a live fact back through moderation (send-back →
  // promote) so its enrichment is regenerated AND re-stamped. Distinct from
  // `rerun_enrichment` (direct write to facts.*, no signature stamp, no review).
  "send_back_to_review",
  "research_cultural_reference",
  "review_semantic_entity",
  "repair_projection_columns",
  "manual_review",
  "none",
] as const;
export type TaxonomyHealthRecommendedAction =
  (typeof TAXONOMY_HEALTH_RECOMMENDED_ACTION_VALUES)[number];

export type TaxonomyHealthSeverity = "info" | "warning" | "error";

// ─── Enrichment version staleness (shared with the per-fact UI) ─────────────
//
// The server evaluator (`evaluateFactTaxonomyHealth`) decides stale-or-not for
// the Taxonomy Health page. The same decision needs to render on the per-fact
// "Visual Taxonomy Enrichment" panel and as an explicit stored→current diff on
// the health page. This pure helper is the single source of that comparison so
// both surfaces agree with the evaluator (which flags classification-version
// mismatch/absence as stale). The retired enrichment-time visual preview no
// longer participates — the render-time pipeline is the single source of truth
// for the visual.

import { CLASSIFICATION_PROMPT_VERSION } from "./taxonomy";
import { VISUAL_STRATEGY_VERSION } from "./visualPromptStrategies";

export interface CurrentTaxonomyVersions {
  classificationPromptVersion: string;
  visualStrategyVersion: string;
}

/** The version constants the live pipeline currently produces. */
export function currentTaxonomyVersions(): CurrentTaxonomyVersions {
  return {
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    visualStrategyVersion: VISUAL_STRATEGY_VERSION,
  };
}

export type EnrichmentVersionField = "classification";

export interface EnrichmentVersionDiscrepancy {
  field: EnrichmentVersionField;
  /** Human label for the surface this version gates. */
  label: string;
  /** The version stamped on the stored data (null = never generated / pre-versioning). */
  stored: string | null;
  /** The version the live pipeline produces now. */
  current: string;
  /** True when stored is absent OR differs from current. */
  stale: boolean;
  /** True when stored is absent (pre-versioned blob or not generated yet). */
  missing: boolean;
}

export interface EnrichmentVersionStatus {
  /** The enrichment is stale. */
  isStale: boolean;
  /** Classification (taxonomy enrichment) is stale or unversioned. */
  enrichmentStale: boolean;
  fields: EnrichmentVersionDiscrepancy[];
}

/** Compare already-extracted stored versions against the current ones. */
export function enrichmentVersionStatusFromStored(
  stored: { classificationPromptVersion: string | null },
  current: CurrentTaxonomyVersions = currentTaxonomyVersions(),
): EnrichmentVersionStatus {
  const classification: EnrichmentVersionDiscrepancy = {
    field: "classification",
    label: "Taxonomy enrichment",
    stored: stored.classificationPromptVersion,
    current: current.classificationPromptVersion,
    missing: stored.classificationPromptVersion == null,
    stale:
      stored.classificationPromptVersion == null ||
      stored.classificationPromptVersion !== current.classificationPromptVersion,
  };
  return {
    enrichmentStale: classification.stale,
    isStale: classification.stale,
    fields: [classification],
  };
}

/** Compute version staleness directly from a (possibly partial) enrichment blob. */
export function computeEnrichmentVersionStatus(
  enrichment:
    | {
        classificationPromptVersion?: string | null;
      }
    | null
    | undefined,
  current: CurrentTaxonomyVersions = currentTaxonomyVersions(),
): EnrichmentVersionStatus {
  return enrichmentVersionStatusFromStored(
    {
      classificationPromptVersion: enrichment?.classificationPromptVersion ?? null,
    },
    current,
  );
}


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
  staleEnrichmentVersion: boolean;
  /** Enrichment generated under an older/absent ProcessingSignature — needs a
   *  refresh (send-back → promote) to come up to the current pipeline. */
  staleForReprocess: boolean;
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
  enrichedAt: string | null;
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
  staleEnrichmentVersion: number;
  staleForReprocess: number;
  projectionMismatch: number;
  incompleteCulturalReferences: number;
  semanticEntitiesNeedReview: number;
  lowConfidence: number;
}

// ─── Health filters — single source of truth for count + list ─────────────
//
// The summary card counts and the facts-list filter MUST use the same
// predicate, or a card can show "3" and then list 8 rows (the historical
// "Healthy returns everything" + "semantic entities counts 1, lists 8" bugs).
// `matchesHealthFilter` is that one predicate; both the summary tally and the
// list endpoint route every card through it so they can never diverge.
//
// Cards are *overlapping* filters, not exclusive buckets: a fact that is
// `overallStatus === "healthy"` may still carry an info-level hint and so
// appear under another card too. The UI explains this.

export const TAXONOMY_HEALTH_FILTER_VALUES = [
  "any",
  "healthy",
  "missing_enrichment",
  "invalid_enrichment",
  "needs_admin_review",
  "stale_enrichment_version",
  "stale_for_reprocess",
  "projection_mismatch",
  "incomplete_cultural_references",
  "semantic_entities_need_review",
  "low_confidence",
  "questionable_fit",
] as const;
export type TaxonomyHealthFilter = (typeof TAXONOMY_HEALTH_FILTER_VALUES)[number];

/**
 * The single predicate shared by the summary counts and the facts list.
 * `semantic_entities_need_review` deliberately uses `statuses` (the broad set,
 * which includes the info-level capitalization hints) so the count matches the
 * list — per product decision to surface the hints under this card.
 */
export function matchesHealthFilter(
  health: FactTaxonomyHealth,
  filter: TaxonomyHealthFilter,
): boolean {
  switch (filter) {
    case "any":
      return true;
    case "healthy":
      return health.overallStatus === "healthy";
    case "missing_enrichment":
      return health.statuses.includes("missing_enrichment");
    case "invalid_enrichment":
      return health.reviewFlags.invalidEnrichment;
    case "needs_admin_review":
      return health.statuses.includes("needs_admin_review");
    case "stale_enrichment_version":
      return health.reviewFlags.staleEnrichmentVersion;
    case "stale_for_reprocess":
      return health.reviewFlags.staleForReprocess;
    case "projection_mismatch":
      return health.reviewFlags.projectionMismatch;
    case "incomplete_cultural_references":
      return health.reviewFlags.culturalReferenceNeedsResearch;
    case "semantic_entities_need_review":
      return health.statuses.includes("semantic_entities_need_review");
    case "low_confidence":
      return health.reviewFlags.lowConfidence;
    case "questionable_fit":
      return health.statuses.includes("questionable_fit");
    default: {
      // Exhaustiveness guard — a new filter value must add a case above.
      const _never: never = filter;
      return _never;
    }
  }
}

/**
 * Maps each summary-count key (except `totalFacts`) to the filter whose
 * predicate produces it. The summary route loops over this so each count is
 * `matchesHealthFilter(...)` — identical to what the list returns.
 */
export const SUMMARY_COUNT_TO_FILTER: Record<
  Exclude<keyof TaxonomyHealthSummaryCounts, "totalFacts">,
  TaxonomyHealthFilter
> = {
  healthy: "healthy",
  missingEnrichment: "missing_enrichment",
  invalidEnrichment: "invalid_enrichment",
  needsAdminReview: "needs_admin_review",
  staleEnrichmentVersion: "stale_enrichment_version",
  staleForReprocess: "stale_for_reprocess",
  projectionMismatch: "projection_mismatch",
  incompleteCulturalReferences: "incomplete_cultural_references",
  semanticEntitiesNeedReview: "semantic_entities_need_review",
  lowConfidence: "low_confidence",
};

// ─── Action response contract (observable jobs + inline outcomes) ──────────
//
// Every Taxonomy Health action returns the same shape so the UI can render a
// spinner→done/✗ for queued work and immediate terminal state for inline work.
// Queued work returns concrete `async_jobs.id`s the frontend polls by id;
// inline/skip work returns `outcomes` resolved synchronously.

export const TAXONOMY_HEALTH_ACTION_VALUES = [
  "re_enrich",
  "repair_projections",
  "send_back_to_review",
] as const;
export type TaxonomyHealthAction = (typeof TAXONOMY_HEALTH_ACTION_VALUES)[number];

export const TAXONOMY_HEALTH_SKIP_REASON_VALUES = [
  "admin_edited",
  "not_applicable",
  "already_current",
  "missing_required_data",
  // Bulk send-back guard skips (mirror SendBackToReviewError codes 1:1).
  "already_in_review",
  "not_active",
] as const;
export type TaxonomyHealthSkipReason =
  (typeof TAXONOMY_HEALTH_SKIP_REASON_VALUES)[number];

export type AsyncJobStatusValue = "pending" | "processing" | "done" | "failed";

export interface QueuedJobDescriptor {
  factId: number;
  jobId: number;
  queue: string;
  dedupeKey: string | null;
  action: TaxonomyHealthAction;
  status: AsyncJobStatusValue;
  /** True when this enqueue attached to an existing non-terminal job. */
  deduped: boolean;
}

export type ActionOutcome =
  | { factId: number; action: TaxonomyHealthAction; status: "done"; message?: string }
  | { factId: number; action: TaxonomyHealthAction; status: "failed"; error: string }
  | {
      factId: number;
      action: TaxonomyHealthAction;
      status: "skipped";
      reason: TaxonomyHealthSkipReason;
      message: string;
    };

export interface TaxonomyHealthActionSummary {
  requested: number;
  queued: number;
  done: number;
  failed: number;
  skipped: number;
  skippedAdminEdited?: number;
  alreadyCurrent?: number;
  notApplicable?: number;
}

export interface TaxonomyHealthActionResponse {
  /** Descriptive only — the UI derives behavior from the arrays below. */
  mode: "queued" | "inline" | "mixed";
  jobs: QueuedJobDescriptor[];
  outcomes: ActionOutcome[];
  summary: TaxonomyHealthActionSummary;
  /** Bulk send-back only: corpus-wide stale count at request time. */
  totalStale?: number;
  /** Bulk send-back only: corpus-wide eligible-to-send stale facts not enqueued by this request. */
  eligibleRemaining?: number;
  /** Bulk send-back only: the server-enforced per-request enqueue cap. */
  batchLimit?: number;
}

// ─── Job-status polling (poll by concrete async_jobs.id) ───────────────────

export interface JobStatusEntry {
  jobId: number;
  queue: string;
  dedupeKey: string | null;
  status: AsyncJobStatusValue;
  attempts: number;
  maxAttempts: number;
  /** Concise diagnostic (no stack traces). */
  error: string | null;
  updatedAt: string | null;
  /**
   * Set only when a `done` job's stored result is a sanitized, enum-validated
   * `{ skipped: true, reason }` — lets the UI render a terminal handler-level
   * skip (e.g. a race-condition guard) as "Skipped", never a bare "Done".
   */
  skipped?: boolean;
  skipReason?: TaxonomyHealthSkipReason;
}

export interface JobStatusResponse {
  jobs: JobStatusEntry[];
}
