/**
 * Taxonomy Health card metadata — display labels + the explanatory copy that
 * appears when a card is selected. Kept beside the page so the copy lives next
 * to the UI but doesn't clutter the component.
 *
 * Each card describes (a) what the health issue means, (b) what the admin
 * should do, and (c) what each action button does and whether it's safe to run
 * repeatedly / costs model calls / risks overwriting. Cards are OVERLAPPING
 * filters (a healthy fact can still carry an info-level hint), which the panel
 * states explicitly.
 */

import type { TaxonomyHealthSummaryCounts, TaxonomyHealthFilter } from "@workspace/api-zod";

export type FilterStatus = TaxonomyHealthFilter;

export type CardTone = "green" | "red" | "amber" | "blue" | "neutral";

export type ActionSafety = "safe" | "costs_model_calls" | "overwrite_risk";

export interface CardActionHelp {
  label: string;
  help: string;
  safety: ActionSafety;
}

export interface CardMeta {
  key: keyof TaxonomyHealthSummaryCounts;
  label: string;
  filter: FilterStatus;
  tone: CardTone;
  /** What this health issue means. */
  description: string;
  /** What the admin is expected to do about it. */
  whatToDo: string;
  /** The action buttons relevant to this card, with safety notes. */
  actions: CardActionHelp[];
}

const REENRICH_ACTION: CardActionHelp = {
  label: "Re-enrich",
  help: "Re-runs the classification model and rewrites the enrichment + promoted columns. Safe to run repeatedly, but each run costs a model call and takes time. Admin-edited facts are protected and skipped automatically — edit those in the fact editor instead.",
  safety: "costs_model_calls",
};

const VISUAL_PLAN_ACTION: CardActionHelp = {
  label: "Regenerate Visual Plan",
  help: "Rebuilds the stored visual plan (the image-prompt pipeline's visual strategy) from the current enrichment. Safe to run repeatedly; it does NOT reclassify the fact, but each run costs a model call.",
  safety: "costs_model_calls",
};

const REPAIR_ACTION: CardActionHelp = {
  label: "Repair",
  help: "Rewrites the derived/promoted columns from the stored enrichment JSON. Safe to run repeatedly, instant, and makes no model calls.",
  safety: "safe",
};

export const CARD_META: CardMeta[] = [
  {
    key: "healthy",
    label: "Healthy",
    filter: "healthy",
    tone: "green",
    description:
      "Facts with no blocking taxonomy health problem — enrichment is valid, current, and has a visual plan. Some rows may still carry an informational hint and so also appear under another card.",
    whatToDo: "Nothing required. Open a fact via its ID to inspect its enrichment or visual plan.",
    actions: [],
  },
  {
    key: "missingEnrichment",
    label: "Missing enrichment",
    filter: "missing_enrichment",
    tone: "red",
    description:
      "These facts have no enrichment blob at all. Without it, archetype/subtype, the visual plan, and the promoted columns can't be derived.",
    whatToDo: "Re-enrich to generate enrichment from the fact text.",
    actions: [REENRICH_ACTION],
  },
  {
    key: "invalidEnrichment",
    label: "Invalid enrichment",
    filter: "invalid_enrichment",
    tone: "red",
    description:
      "Enrichment exists but fails validation (bad shape or a subtype that doesn't belong to its archetype). Downstream features can't trust it.",
    whatToDo: "Open the fact to fix it by hand, or Re-enrich to regenerate from scratch.",
    actions: [REENRICH_ACTION],
  },
  {
    key: "needsAdminReview",
    label: "Needs admin review",
    filter: "needs_admin_review",
    tone: "amber",
    description:
      "A human judgement call is flagged — low confidence, questionable/reject fit, an adult-suitability review, a cultural reference, or a semantic entity needing review.",
    whatToDo: "Open the fact (its ID link) to review and edit the flagged fields.",
    actions: [],
  },
  {
    key: "staleVisualPreview",
    label: "Stale visual plan",
    filter: "stale_visual_preview",
    tone: "amber",
    description:
      "The visual plan is missing or outdated. This includes facts with no plan yet, plans generated under an older prompt version, and plans whose underlying enrichment has since changed. All three need regeneration — the visual plan is always tied to the enrichment that produced it.",
    whatToDo:
      "Regenerate the visual plan from the current enrichment. If the enrichment itself is also stale, re-enrich first — regenerating a visual plan from stale enrichment just locks in the outdated data.",
    actions: [VISUAL_PLAN_ACTION],
  },
  {
    key: "staleEnrichmentVersion",
    label: "Stale enrichment",
    filter: "stale_enrichment_version",
    tone: "amber",
    description:
      "Enrichment was classified under an older classification-prompt version (or has no version field at all).",
    whatToDo: "Re-enrich to re-classify under the current prompt version.",
    actions: [REENRICH_ACTION],
  },
  {
    key: "projectionMismatch",
    label: "Projection mismatch",
    filter: "projection_mismatch",
    tone: "blue",
    description:
      "The promoted columns (archetype, subtype, fit, suitability) no longer match what the stored enrichment JSON derives.",
    whatToDo: "Repair to rewrite the promoted columns from the enrichment.",
    actions: [REPAIR_ACTION],
  },
  {
    key: "incompleteCulturalReferences",
    label: "Cultural refs need research",
    filter: "incomplete_cultural_references",
    tone: "amber",
    description:
      "A cultural reference is missing its explanation or visual implication, has low research confidence, or is flagged for review.",
    whatToDo: "Open the fact to research and complete the cultural reference.",
    actions: [],
  },
  {
    key: "semanticEntitiesNeedReview",
    label: "Semantic entities need review",
    filter: "semantic_entities_need_review",
    tone: "amber",
    description:
      "A named entity may need a human look — flagged for review, low confidence, or ambiguous — OR (informational) the fact text contains a capitalization-sensitive term but no entities were extracted. Both are included here.",
    whatToDo: "Open the fact to review the semantic entities; re-enriching may help for the capitalization hints.",
    actions: [],
  },
  {
    key: "lowConfidence",
    label: "Low confidence",
    filter: "low_confidence",
    tone: "amber",
    description: "The classifier's taxonomyConfidence is below the 0.75 threshold for these facts.",
    whatToDo: "Open the fact to confirm or correct the classification.",
    actions: [],
  },
];
