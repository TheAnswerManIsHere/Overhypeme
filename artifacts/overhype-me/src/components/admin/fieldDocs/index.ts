/**
 * Field-documentation registry — assembly + lookup helpers.
 *
 * PURE DATA (no React/UI imports): consumed by FieldInfo.tsx, the coverage
 * tests, and the Node-run markdown generator. The registry is the UI's source
 * of truth for field labels; `OVERRIDABLE_PATHS.label` in api-zod is a mirrored
 * copy for server messages, kept aligned by a consistency test.
 */

import { isKnownModifier, type KnownFactModifier, type OverridablePath } from "@workspace/api-zod";
import type { FieldDoc, FieldDocKey, FieldDocUsage, ValueDoc } from "./types";
import { CLASSIFICATION_FIELD_DOCS } from "./classification";
import { KNOWN_MODIFIER_DOCS, CUSTOM_MODIFIER_DOC } from "./modifiers";
import { VISUAL_STRATEGY_FIELD_DOCS } from "./visualStrategy";
import { REFERENCES_ENTITIES_FIELD_DOCS } from "./referencesEntities";

// ─── Assembly ────────────────────────────────────────────────────────────────

const ALL_FIELD_DOCS: FieldDoc[] = [
  ...CLASSIFICATION_FIELD_DOCS,
  ...VISUAL_STRATEGY_FIELD_DOCS,
  ...REFERENCES_ENTITIES_FIELD_DOCS,
];

/** Keyed registry. The `satisfies` clause fails typecheck if any FieldDocKey
 *  is missing a doc (or a doc uses an unknown key). */
export const FIELD_DOCS = Object.fromEntries(
  ALL_FIELD_DOCS.map((d) => [d.key, d]),
) as Record<FieldDocKey, FieldDoc>;

// Duplicate-key guard (cheap; runs everywhere — Object.fromEntries would
// otherwise silently keep the last duplicate). Missing keys are caught by the
// coverage test iterating the FieldDocKey list, and by FIELD_DOC_USAGE's
// `satisfies` below, which forces every FieldDocKey to be classified.
{
  const keys = ALL_FIELD_DOCS.map((d) => d.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length > 0) {
    throw new Error(`FIELD_DOCS: duplicate keys ${dupes.join(", ")}`);
  }
}

// ─── Usage categories (drives the deterministic usage test) ──────────────────

export const FIELD_DOC_USAGE = {
  primaryArchetype: "field-label",
  subtype: "field-label",
  visualLiteralness: "field-label",
  visualComplexity: "field-label",
  overhypeFit: "field-label",
  adultSuitability: "field-label",
  adultSuitabilityNotes: "field-label",
  modifiers: "field-label",
  finalHashtags: "field-label",
  aiSuggestedHashtags: "field-label",
  suggestedHashtags: "field-label",
  taxonomyConfidence: "field-label",
  adminReviewNotes: "field-label",
  "vso.panel": "panel-level",
  "vso.coreSceneOverride": "field-label",
  "vso.moderatorIntent": "field-label",
  "vso.subjectRealization": "field-label",
  "vso.subjectRealizationDescription": "field-label",
  "vso.requiredVisualDetails": "field-label",
  "vso.forbiddenVisualDetails": "field-label",
  "vso.roleBindings": "field-label",
  "vso.bubbles": "field-label",
  "vso.compositionGuidance": "field-label",
  "vso.styleAgnosticPromptAdditions": "field-label",
  "vso.negativePromptAdditions": "field-label",
  "vso.supportingTextPolicy": "field-label",
  "vso.violencePolicy": "field-label",
  culturalReferences: "section-level",
  "ref.sourcePhrase": "reserved",
  "ref.referenceType": "repeater-enum",
  "ref.canonicalReference": "reserved",
  "ref.explanation": "reserved",
  "ref.visualImplication": "reserved",
  "ref.confidence": "reserved",
  "ref.requiresAdminReview": "reserved",
  semanticEntities: "section-level",
  "ent.surfaceText": "reserved",
  "ent.normalizedText": "reserved",
  "ent.entityKind": "repeater-enum",
  "ent.capitalizationSignal": "repeater-enum",
  "ent.visualReferent": "reserved",
  "ent.notes": "reserved",
  "ent.materiallyAffects": "reserved",
  "ent.requiresReview": "reserved",
  "ent.confidence": "reserved",
} satisfies Record<FieldDocKey, FieldDocUsage>;

// ─── Overridable-path mapping ────────────────────────────────────────────────
//
// Overridable enrichment path → docs-registry key, so the "Overridden:" chips
// render labels from the registry (the UI's label source of truth) while
// OVERRIDABLE_PATHS.label stays a server-message mirror. The coverage test
// asserts the two label sources stay byte-identical.

export const PATH_TO_DOC_KEY: Record<OverridablePath, FieldDocKey> = {
  "/primaryArchetype": "primaryArchetype",
  "/subtype": "subtype",
  "/visualLiteralness": "visualLiteralness",
  "/visualComplexity": "visualComplexity",
  "/overhypeFit": "overhypeFit",
  "/adultSuitability": "adultSuitability",
  "/adultSuitabilityNotes": "adultSuitabilityNotes",
  "/modifiers": "modifiers",
  "/culturalReferences": "culturalReferences",
  "/semanticEntities": "semanticEntities",
  "/adminReviewNotes": "adminReviewNotes",
};

// ─── Lookup helpers ──────────────────────────────────────────────────────────

export function getFieldDoc(key: FieldDocKey): FieldDoc {
  return FIELD_DOCS[key];
}

/** The UI's source of truth for a field's on-screen label. */
export function fieldLabel(key: FieldDocKey): string {
  return FIELD_DOCS[key].label;
}

/** Doc for a modifier chip: the known doc, or the explicit custom fallback. */
export function modifierDoc(name: string): ValueDoc {
  return isKnownModifier(name)
    ? KNOWN_MODIFIER_DOCS[name as KnownFactModifier]
    : CUSTOM_MODIFIER_DOC;
}

export type { FieldDoc, FieldDocKey, FieldDocUsage, ValueDoc } from "./types";
