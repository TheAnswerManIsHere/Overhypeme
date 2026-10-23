/**
 * Code-first engine catalogue.
 *
 * Each engine lives in its own file in this directory. The shape is strictly
 * typed via `EngineDefinition` so the IDE catches param-schema mistakes at
 * edit time — exactly the class of bug that produced migration 0058 (Veo's
 * `generate_audio` rejection at fal).
 *
 * Boot-time reconciliation upserts each definition into the `engines` table
 * (see `reconcile.ts`). Admin-tunable fields (isActive, isDefault,
 * pricing overrides, etc.) are preserved across reconciliations once first
 * persisted. Code-owned fields (paramSchema, allowed sets,
 * label, description, kind) are overwritten on every boot — code is the
 * source of truth for "what does fal accept from this engine."
 *
 * Adding a new engine = drop a new file in this directory, add it to
 * `ALL_ENGINES` in `index.ts`. No SQL migration required.
 */

import type {
  ParamPrimitive,
  ParamPredicate,
  ParamSchema,
  ParamSchemaEntry,
} from "../engineInterpreter";

// Re-export so engine files only need to import from this barrel.
export type { ParamPrimitive, ParamPredicate, ParamSchema, ParamSchemaEntry };

export type EngineKind = "image" | "utility" | "llm";
export type TierRequirement = "unregistered" | "registered" | "legendary";

/**
 * The typed engine definition. The interpreter (engineInterpreter.ts) consumes
 * the `paramSchema` field at runtime; everything else is metadata or
 * admin-tunable defaults.
 */
export interface EngineDefinition {
  // ── Identity ────────────────────────────────────────────────────────────
  id: string;
  provider: string;
  endpointId: string;
  label: string;
  description: string;
  kind: EngineKind;

  // ── Tier + visibility (admin-editable in the panel) ─────────────────────
  tierRequirement: TierRequirement;
  /** True if this engine is the default for its kind on first boot. */
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Feature flag gate for visibility in the wizard. Null = always visible. */
  featureFlagRequired: string | null;
  /**
   * False blocks the engine from becoming the default for its kind via
   * POST /admin/engines/:id/set-default (per-purpose config-key routing
   * only). Omitted/true = eligible. Read from the in-process catalogue —
   * DB-only rows with no catalogue definition stay eligible (current
   * behavior preserved).
   */
  eligibleAsKindDefault?: boolean;

  // ── Allowed option sets ─────────────────────────────────────────────────
  /** Resolution strings as the engine itself speaks them. */
  allowedResolutions: string[] | null;
  defaultResolution: string | null;
  /** Aspect ratios in fal format (server-side). */
  allowedAspectRatios: string[] | null;
  defaultAspectRatio: string | null;

  // ── Pipeline behavior ───────────────────────────────────────────────────
  paramSchema: ParamSchema;

  // ── Runtime + cost hints (admin-editable defaults; runtime pricing
  //    overrides come from getCachedPrice / fal pricing cache) ────────────
  /** EMA seed for the progress bar's expected runtime. */
  expectedRunMs: number;
  /** Fallback flat cost when fal pricing is unavailable. Always defer to
   *  getCachedPrice() at runtime. */
  estimatedCostUsdPerCall: number | null;

  // ── LLM engines ("llm" kind / provider "openai") only; omit for media ───
  /** Default sampling temperature. */
  defaultTemperature?: number | null;
  /** Default max output tokens. */
  defaultMaxTokens?: number | null;
  /** Default reasoning effort for reasoning models (gpt-5 / o-series). */
  defaultReasoningEffort?: string | null;
}

/**
 * Sub-set of fields that admins can edit through the PATCH handler in
 * routes/adminEngines.ts. Reconciliation preserves these once first
 * persisted; everything outside this list is overwritten on every boot
 * from the code definition.
 *
 * `deletedAt` is excluded here — soft-delete + restore go through the
 * dedicated DELETE / POST .../restore endpoints rather than the PATCH
 * surface. The reconciler still respects an existing deletedAt
 * (preserved across boots) via a separate code path in reconcile.ts.
 */
export const ADMIN_EDITABLE_FIELDS = [
  "isActive",
  "isDefault",
  "sortOrder",
  "tierRequirement",
  "featureFlagRequired",
  "defaultResolution",
  "defaultAspectRatio",
  "expectedRunMs",
  "estimatedCostUsdPerCall",
  // LLM engines: the model (endpointId) and sampling defaults are admin-tunable.
  // For media (fal) engines, endpointId stays code-owned — reconcile.ts
  // re-asserts it on every boot (see codeOwnedFields), so only "openai"
  // providers actually have an editable endpoint.
  "endpointId",
  "defaultTemperature",
  "defaultMaxTokens",
  "defaultReasoningEffort",
] as const;

export type AdminEditableField = (typeof ADMIN_EDITABLE_FIELDS)[number];
