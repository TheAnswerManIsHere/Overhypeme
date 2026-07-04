/**
 * Field-documentation registry types for the admin enrichment editor.
 *
 * PURITY INVARIANT: this directory is pure data + type helpers. Nothing here
 * may import React, Radix, CSS utilities, or component code — the registry is
 * imported by a Node-run markdown generator (`scripts/generate-admin-field-reference.ts`)
 * and by `FieldInfo.tsx`, never the reverse.
 *
 * The registry is the UI's source of truth for field labels (the naming pass
 * edits `label` here). `OVERRIDABLE_PATHS.label` in @workspace/api-zod remains
 * a mirrored copy for server-side messages, kept aligned by a consistency test.
 */

// ─── Effect classification (two honest axes) ────────────────────────────────
//
// `effect` says what kind of system consequence the field has; `staleBehavior`
// says whether editing it flips render-scenario tiles stale. They are separate
// axes because they genuinely diverge: e.g. Visual Literalness is advisory to
// the deterministic compiler (no directive keys off it) yet it IS in the
// render-input hash, so editing it marks renders stale.

export type FieldEffectClass =
  | "render-affecting" // feeds the prompt pipeline (strategy selection, directives, planner input)
  | "advisory-only" // planner context only; no deterministic compiler directive
  | "gating-only" // approval / taxonomy-health gate; never compiled into the prompt
  | "product-metadata" // ships with the live fact (e.g. discovery hashtags) but never affects the render
  | "human-only"; // never leaves the admin UI

export type StaleBehavior =
  | "marks-render-stale" // in renderAffectingEnrichment (factRenderScenarios.ts) — editing re-flags scenario tiles
  | "does-not-mark-render-stale"
  | "not-applicable"; // e.g. read-only fields

/** Whether the doc text is extracted from authoritative code/prompt sources or
 *  authored from scratch (no upstream prose existed) and needs David's review. */
export type AuthoredStatus = "code-derived" | "authored-needs-david-review";

// ─── Provenance (structured data — emitted into the generated reference doc) ─

export interface FieldDocSourceRef {
  /** Repo-relative path, e.g. "artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts". */
  path: string;
  /** Preferred: a stable exported symbol, e.g. "composeSubjectBinding", "FACT_ENRICHMENT_SYSTEM_DEFAULT". */
  symbol?: string;
  /** For docs-only or prompt-text anchors where no symbol exists. */
  anchor?: string;
  /** Human-readable note on what this source establishes. Required. */
  note: string;
}

// ─── Worked examples ─────────────────────────────────────────────────────────

export interface WorkedExample {
  /** The setup: the fact text and/or what the admin is doing. */
  scenario: string;
  /** The field value(s) set, e.g. `Modifier: "baby_child_version"`. */
  input: string;
  /** The downstream effect — quote the compiled-prompt fragment / render outcome where possible. */
  outcome: string;
}

// ─── Per-dropdown-value docs ─────────────────────────────────────────────────

export interface ValueDoc {
  /** What this value means ("use when…"). Non-empty (coverage-test enforced). */
  meaning: string;
  /** How selecting it changes the compiled prompt / pipeline behavior. Non-empty. */
  renderImpact: string;
  /** A one-line worked example. Non-empty. */
  example: string;
  sourceRefs?: FieldDocSourceRef[];
  authoredStatus?: AuthoredStatus;
}

// ─── Field docs ──────────────────────────────────────────────────────────────

export type FieldDocKey =
  // AI Visual Classification
  | "primaryArchetype"
  | "subtype"
  | "visualLiteralness"
  | "visualComplexity"
  | "overhypeFit"
  | "adultSuitability"
  | "adultSuitabilityNotes"
  | "modifiers"
  | "finalHashtags"
  | "aiSuggestedHashtags"
  | "suggestedHashtags"
  | "taxonomyConfidence"
  | "adminReviewNotes"
  // Visual Strategy Overrides
  | "vso.panel"
  | "vso.coreSceneOverride"
  | "vso.moderatorIntent"
  | "vso.subjectRealization"
  | "vso.subjectRealizationDescription"
  | "vso.requiredVisualDetails"
  | "vso.forbiddenVisualDetails"
  | "vso.roleBindings"
  | "vso.compositionGuidance"
  | "vso.styleAgnosticPromptAdditions"
  | "vso.negativePromptAdditions"
  | "vso.supportingTextPolicy"
  | "vso.violencePolicy"
  // References & Scene Entities
  | "culturalReferences"
  | "ref.sourcePhrase"
  | "ref.referenceType"
  | "ref.canonicalReference"
  | "ref.explanation"
  | "ref.visualImplication"
  | "ref.confidence"
  | "ref.requiresAdminReview"
  | "semanticEntities"
  | "ent.surfaceText"
  | "ent.normalizedText"
  | "ent.entityKind"
  | "ent.capitalizationSignal"
  | "ent.visualReferent"
  | "ent.notes"
  | "ent.materiallyAffects"
  | "ent.requiresReview"
  | "ent.confidence";

export interface FieldDoc {
  key: FieldDocKey;
  /** SINGLE UI SOURCE OF TRUTH for the on-screen label. Naming-pass edits happen here. */
  label: string;
  /** Muted suffix after the label, excluded from the "name" (e.g. "(admin-only, not rendered)", "(3–8)"). */
  labelSuffix?: string;
  /** One-line summary shown under the popover title. */
  hint: string;
  /** What the field is — one string per paragraph. */
  whatItIs: string[];
  /** What it's used for / how the AI derives it. */
  howDerived: string[];
  /** How the field ultimately affects the final render (traced compiler behavior). */
  renderImpact: string[];
  /** Per-dropdown-value docs, present iff the field is an enum select / known-value chip input.
   *  Built via `valuesFrom` so display order always matches the canonical api-zod order. */
  values?: readonly { value: string; doc: ValueDoc }[];
  /** Multiple worked examples (≥1 coverage-enforced; aim for 2–4). */
  workedExamples: WorkedExample[];
  effect: FieldEffectClass;
  staleBehavior: StaleBehavior;
  sourceRefs?: FieldDocSourceRef[];
  authoredStatus?: AuthoredStatus;
}

// ─── Usage categories (drives the deterministic usage test) ──────────────────
//
// Every FieldDocKey is classified so the "is every doc actually wired into the
// editor?" test is data-driven rather than DOM interpretation:
//   field-label    → rendered by <FieldLabel docKey=…> beside its own control
//   section-level  → one icon on a section header covering the whole collection
//   panel-level    → one icon on the Visual Strategy panel header
//   repeater-enum  → per-row icon on an enum dropdown inside a repeater row
//   reserved       → present in the registry/generated doc only (not editor-wired)

export type FieldDocUsage =
  | "field-label"
  | "section-level"
  | "panel-level"
  | "repeater-enum"
  | "reserved";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a FieldDoc `values` array from the canonical api-zod value order + a
 *  (typecheck-exhaustive) per-value doc record, so popover order always matches
 *  dropdown order and never depends on object-key order. */
export function valuesFrom<V extends string>(
  order: readonly V[],
  docs: Record<V, ValueDoc>,
): readonly { value: string; doc: ValueDoc }[] {
  return order.map((value) => ({ value, doc: docs[value] }));
}
