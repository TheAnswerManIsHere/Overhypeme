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

  // ── Image routing and costing (launch Phase 8; code-owned, reconciled) ──
  /**
   * Image engines only: "t2i" draws from a prompt alone, "i2i" edits a
   * reference photo. The router (`imageEngineRouting.ts`) refuses an engine
   * whose mode is not the render's.
   */
  imageMode?: "t2i" | "i2i";
  /** Pairs a family's text-to-image and edit definitions, e.g. "nano-banana-2". */
  family?: string;
  /** The endpoint's size vocabulary, from which the request builder picks a setting. */
  sizeVocabulary?: SizeVocabulary;
  /**
   * A complete per-call price bound at the frozen comparison settings (about
   * one megapixel, one output image, one reference on the edit side), each
   * component with its documented ceiling and source. An engine without one
   * is never dispatched to by a budgeted run.
   */
  priceModel?: PriceModel;

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

// ── Size vocabulary (request builder) ─────────────────────────────────────

/** The wizard aspect names every engine maps from. */
export type WizardAspect = "landscape" | "square" | "portrait";

/**
 * One size setting the endpoint accepts. `params` are pipeline-level keys
 * (a param's `from`) merged into the call, e.g. `{ resolution: "1K" }`.
 * `megapixels` is the approximate output size. An option with `aspect`
 * applies only to that aspect (engines that take pixel dimensions); one
 * without applies to every aspect (the aspect is sent separately).
 */
export interface SizeOption {
  params: Record<string, string | number | boolean>;
  megapixels: number;
  aspect?: WizardAspect;
}

export interface SizeVocabulary {
  options: SizeOption[];
}

// ── Price model ───────────────────────────────────────────────────────────

/** Where a price or ceiling was read, so a bound can be re-checked. */
export interface PriceSource {
  /** The page or document the figure was read from. */
  source: string;
  /** ISO date the figure was read. */
  readOn: string;
}

/**
 * One billable component of a token-priced call, at its ceiling for the
 * comparison settings. `measured: true` marks a figure that rests on a
 * measurement rather than a documented maximum (the plan's D2 disclosure).
 */
export interface TokenPriceComponent {
  name: string;
  usdPerMillionTokens: number;
  maxTokens: number;
  ceilingBasis: string;
  measured?: boolean;
}

export type PriceModel =
  | ({ kind: "flat"; usdPerImage: number; usdPerExtraInput?: number } & PriceSource)
  | ({ kind: "tokens"; components: TokenPriceComponent[]; usdPerCallFloor?: number } & PriceSource);

/**
 * The worst-case cost of one call at the comparison settings, from the price
 * model alone. Flat: the image plus any priced extra inputs beyond the first.
 * Tokens: every component at its ceiling.
 */
export function perCallBoundUsd(model: PriceModel, extraInputs = 0): number {
  if (model.kind === "flat") {
    return model.usdPerImage + (model.usdPerExtraInput ?? 0) * Math.max(0, extraInputs);
  }
  const total = model.components.reduce(
    (sum, c) => sum + (c.usdPerMillionTokens * c.maxTokens) / 1_000_000,
    0,
  );
  return Math.max(total, model.usdPerCallFloor ?? 0);
}
