/**
 * Field-documentation registry — assembly + lookup helpers.
 *
 * PURE DATA (no React/UI imports): consumed by FieldInfo.tsx, the coverage
 * tests, and the Node-run markdown generator. The registry is the UI's source
 * of truth for field labels.
 */

import type { FieldDoc, FieldDocKey, FieldDocUsage } from "./types";
import { HASHTAG_FIELD_DOCS } from "./hashtags";
import { VISUAL_STRATEGY_FIELD_DOCS } from "./visualStrategy";

// ─── Assembly ────────────────────────────────────────────────────────────────

const ALL_FIELD_DOCS: FieldDoc[] = [
  ...HASHTAG_FIELD_DOCS,
  ...VISUAL_STRATEGY_FIELD_DOCS,
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
  finalHashtags: "field-label",
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
} satisfies Record<FieldDocKey, FieldDocUsage>;

// ─── Lookup helpers ──────────────────────────────────────────────────────────

export function getFieldDoc(key: FieldDocKey): FieldDoc {
  return FIELD_DOCS[key];
}

/** The UI's source of truth for a field's on-screen label. */
export function fieldLabel(key: FieldDocKey): string {
  return FIELD_DOCS[key].label;
}

export type { FieldDoc, FieldDocKey, FieldDocUsage, ValueDoc } from "./types";
