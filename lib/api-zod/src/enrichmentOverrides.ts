/**
 * AI-derived vs. manual-override tracking for fact taxonomy enrichment.
 *
 * The data model has three layers (see also the migration + facts schema):
 *
 *   enrichment_ai_derived  — the immutable, pure AI baseline blob.
 *   enrichment_overrides   — a path-keyed map of manual field overrides.
 *   facts.enrichment       — the MATERIALIZED EFFECTIVE blob runtime reads.
 *
 * `resolveEnrichment` is the single function that assembles `effective` from the
 * baseline + overrides + the (preserved, not-refactored) visual-strategy
 * override. Every write site (PUT/DELETE/PATCH/re-enrich/projection-repair)
 * funnels through it (via `materializeEnrichment` in the api-server) so preserved
 * human-authored fields can never be silently lost and projections never drift.
 *
 * UX principle: "highlight the change, don't show everything twice." An override
 * exists only when a value diverges from the AI baseline; resetting a field
 * DELETES its override (we never store override == AI).
 */

import { z } from "zod";
import {
  factEnrichmentBase,
  factEnrichmentSchema,
  subtypesForArchetype,
  type FactEnrichment,
  type PrimaryArchetype,
} from "./taxonomy";

// ─── Override record shape ──────────────────────────────────────────────────

/**
 * One manual override entry. `value`/`overriddenFrom` are `unknown` here — the
 * authoritative per-path schema (see `OVERRIDABLE_PATHS`) is what validates the
 * value. `overriddenFrom` captures the AI value the override was created against
 * so we can detect a later baseline change; it is NEVER refreshed by re-enrich.
 */
export const manualOverrideSchema = z.object({
  value: z.unknown(),
  overriddenFrom: z.unknown(),
  /** Canonical hash of `overriddenFrom` (optional fast-path for baseline checks). */
  overriddenFromHash: z.string().optional(),
  /** The AI generation id this override was created against. */
  aiGenerationId: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().nullable().optional(),
  reason: z.string().optional(),
  /** True when this override was auto-created to keep a cross-field invariant
   * valid (e.g. a subtype override forced by a primaryArchetype override). */
  autoLinked: z.boolean().optional(),
});
export type ManualOverride = z.infer<typeof manualOverrideSchema>;

export const enrichmentOverridesSchema = z.record(z.string(), manualOverrideSchema);
export type EnrichmentOverrides = z.infer<typeof enrichmentOverridesSchema>;

// ─── Allowlist (the contract) ───────────────────────────────────────────────

type Decoration = "full" | "light";

interface OverridablePathDef {
  /** The field name on the enrichment blob (path is "/" + field). */
  field: keyof FactEnrichment;
  /** Per-path validator, reused from the canonical enrichment base schema. */
  schema: z.ZodTypeAny;
  /** Human label for summaries / history. */
  label: string;
  /** "full" = AI-vs-Active decoration; "light" = plain control + revert (notes). */
  decoration: Decoration;
}

const S = factEnrichmentBase.shape;

/**
 * The 11 overridable paths. Nine fully-decorated classification fields plus the
 * two AI-authored notes fields (editable + sticky, light-touch UI). Everything
 * else (suggestedHashtags, visualPromptStrategyOverride) is out of scope and
 * keeps its existing edit path.
 */
export const OVERRIDABLE_PATHS = {
  "/primaryArchetype": { field: "primaryArchetype", schema: S.primaryArchetype, label: "Primary Archetype", decoration: "full" },
  "/subtype": { field: "subtype", schema: S.subtype, label: "Subtype", decoration: "full" },
  "/visualLiteralness": { field: "visualLiteralness", schema: S.visualLiteralness, label: "Visual Literalness", decoration: "full" },
  "/visualComplexity": { field: "visualComplexity", schema: S.visualComplexity, label: "Visual Complexity", decoration: "full" },
  "/overhypeFit": { field: "overhypeFit", schema: S.overhypeFit, label: "Overhype Fit", decoration: "full" },
  "/adultSuitability": { field: "adultSuitability", schema: S.adultSuitability, label: "Adult Suitability", decoration: "full" },
  "/modifiers": { field: "modifiers", schema: S.modifiers, label: "Modifiers", decoration: "full" },
  // Labels mirror the on-screen field labels in the admin editor (the docs
  // registry is the UI source of truth; these stay aligned by a consistency
  // test in fieldDocs.test.ts). Used in server-side messages + override chips.
  "/culturalReferences": { field: "culturalReferences", schema: S.culturalReferences, label: "Cultural / Inside References", decoration: "full" },
  "/semanticEntities": { field: "semanticEntities", schema: S.semanticEntities, label: "Semantic Entities / Visual Referents", decoration: "full" },
  "/adminReviewNotes": { field: "adminReviewNotes", schema: S.adminReviewNotes, label: "Admin Review Notes", decoration: "light" },
  "/adultSuitabilityNotes": { field: "adultSuitabilityNotes", schema: S.adultSuitabilityNotes, label: "Adult Suitability Notes", decoration: "light" },
} as const satisfies Record<string, OverridablePathDef>;

export type OverridablePath = keyof typeof OVERRIDABLE_PATHS;
export const OVERRIDABLE_PATH_KEYS = Object.keys(OVERRIDABLE_PATHS) as OverridablePath[];

export function isOverridablePath(path: string): path is OverridablePath {
  return Object.prototype.hasOwnProperty.call(OVERRIDABLE_PATHS, path);
}

/** "/primaryArchetype" → "primaryArchetype". */
export function pathToField(path: OverridablePath): keyof FactEnrichment {
  return OVERRIDABLE_PATHS[path].field;
}

export function pathLabel(path: string): string {
  return isOverridablePath(path) ? OVERRIDABLE_PATHS[path].label : path;
}

/** Validate a candidate value for a path. Returns the normalized value or an error. */
export function validateOverrideValue(
  path: OverridablePath,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = OVERRIDABLE_PATHS[path].schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
}

// ─── Canonical comparison ───────────────────────────────────────────────────

/**
 * Deterministic JSON encoding used for ALL override comparisons (value == AI,
 * baseline changed, audit diffs). Object keys are sorted (JSONB reorders keys on
 * round-trip); `undefined` is dropped to `null`-free output; array order is
 * preserved (order is treated as meaningful for modifiers / lists in v1).
 * Do not let individual call sites invent their own comparison behavior.
 */
export function normalizeForOverrideCompare(value: unknown): string {
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function overrideValuesEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export interface OverrideSummary {
  hasOverrides: boolean;
  /** Paths with an active override (value differs from AI / was manually set). */
  overriddenPaths: OverridablePath[];
  /** Overridden paths whose AI baseline has since changed (needs review). */
  baselineChangedPaths: OverridablePath[];
  /** Overridden paths whose stored value failed per-path validation (drift/bug). */
  invalidPaths: OverridablePath[];
  /** True if the assembled effective failed full-schema validation (e.g. a
   * cross-field archetype/subtype mismatch slipped in). */
  crossFieldInvalid: boolean;
  /** True if the fact carries a moderator visual-strategy override (separate
   * additive layer, not part of the path-keyed map) — for a unified
   * "this fact has manual intervention" signal. */
  hasVisualStrategyOverride: boolean;
}

export interface ResolveEnrichmentInput {
  /** The immutable AI baseline blob. */
  aiDerived: FactEnrichment;
  /** The path-keyed override map (may be `{}`). */
  overrides: EnrichmentOverrides;
  /** The preserved moderator visual-strategy override (passed explicitly so it
   * can never be read from a stale effective blob). */
  visualPromptStrategyOverride?: FactEnrichment["visualPromptStrategyOverride"];
}

export interface ResolveEnrichmentResult {
  effective: FactEnrichment;
  summary: OverrideSummary;
}

/**
 * Assemble the materialized effective enrichment: AI baseline + manual overrides
 * + preserved visual override. Always returns a renderable `effective`: a stored
 * override whose value no longer validates is recorded in `invalidPaths` and the
 * AI value is kept for that field; an assembled blob that fails the full schema
 * (cross-field) is best-effort repaired (subtype → archetype default) and flagged.
 */
export function resolveEnrichment(input: ResolveEnrichmentInput): ResolveEnrichmentResult {
  const { aiDerived, overrides, visualPromptStrategyOverride } = input;

  // Start from the pure AI baseline (strip any stray visual override — the AI
  // blob must never carry it; the preserved one is re-attached explicitly).
  const base: Record<string, unknown> = { ...(aiDerived as Record<string, unknown>) };
  delete base["visualPromptStrategyOverride"];

  const overriddenPaths: OverridablePath[] = [];
  const invalidPaths: OverridablePath[] = [];
  const baselineChangedPaths: OverridablePath[] = [];

  for (const key of Object.keys(overrides)) {
    if (!isOverridablePath(key)) continue;
    const ov = overrides[key];
    const field = OVERRIDABLE_PATHS[key].field;
    const parsed = validateOverrideValue(key, ov.value);
    if (!parsed.ok) {
      invalidPaths.push(key);
      continue; // keep AI value so effective stays renderable
    }
    base[field] = parsed.value;
    overriddenPaths.push(key);
    // Baseline changed when the current AI value differs from what was overridden.
    const aiNow = (aiDerived as Record<string, unknown>)[field];
    if (!overrideValuesEqual(aiNow, ov.overriddenFrom)) {
      baselineChangedPaths.push(key);
    }
  }

  if (visualPromptStrategyOverride !== undefined) {
    base["visualPromptStrategyOverride"] = visualPromptStrategyOverride;
  }

  // Validate the assembled blob. On a cross-field failure, best-effort repair the
  // subtype to the archetype default and re-validate; otherwise fall back to AI.
  let crossFieldInvalid = false;
  let effective: FactEnrichment;
  const first = factEnrichmentSchema.safeParse(base);
  if (first.success) {
    effective = first.data;
  } else {
    crossFieldInvalid = true;
    const archetype = base["primaryArchetype"] as PrimaryArchetype;
    const defaults = subtypesForArchetype(archetype);
    if (defaults && defaults.length > 0) {
      base["subtype"] = defaults[0];
    }
    const second = factEnrichmentSchema.safeParse(base);
    effective = second.success ? second.data : aiDerived;
  }

  return {
    effective,
    summary: {
      hasOverrides: overriddenPaths.length > 0,
      overriddenPaths,
      baselineChangedPaths,
      invalidPaths,
      crossFieldInvalid,
      hasVisualStrategyOverride: Boolean(visualPromptStrategyOverride?.enabled),
    },
  };
}

/** Convenience: which overridden paths have a changed AI baseline. */
export function computeBaselineChangedPaths(
  aiDerived: FactEnrichment,
  overrides: EnrichmentOverrides,
): OverridablePath[] {
  const changed: OverridablePath[] = [];
  for (const key of Object.keys(overrides)) {
    if (!isOverridablePath(key)) continue;
    const field = OVERRIDABLE_PATHS[key].field;
    const aiNow = (aiDerived as Record<string, unknown>)[field];
    if (!overrideValuesEqual(aiNow, overrides[key].overriddenFrom)) changed.push(key);
  }
  return changed;
}

export function hasAnyOverrides(overrides: EnrichmentOverrides | null | undefined): boolean {
  return Boolean(overrides && Object.keys(overrides).length > 0);
}
