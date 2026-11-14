/**
 * Code-first engine catalogue.
 *
 * Each engine lives in its own file in this directory. The shape is strictly
 * typed via `EngineDefinition` so the IDE catches param-schema mistakes at
 * edit time — exactly the class of bug that produced migration 0058 (Veo's
 * `generate_audio` rejection at fal).
 *
 * Boot-time reconciliation upserts each definition into the `engines` table
 * (see `reconcile.ts`). The fields in `RECONCILE_PRESERVED_FIELDS` keep their
 * stored values once a row exists; the rest are refreshed on every boot.
 * Every field that decides how a call is made is read from this catalogue at
 * run time, never from the row (`effectiveEngine` in engineInterpreter.ts;
 * decisions.md 2026-11-14), whatever reconciliation leaves stored.
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
 * the `paramSchema` field at runtime, and every call-shaping field here is
 * read from code (`CODE_OWNED_CALL_FIELDS`).
 */
export interface EngineDefinition {
  // ── Identity ────────────────────────────────────────────────────────────
  id: string;
  provider: string;
  endpointId: string;
  label: string;
  description: string;
  kind: EngineKind;

  // ── Tier + visibility (stored on the row; no admin screen edits them) ────
  tierRequirement: TierRequirement;
  /** Stored for history; it selects nothing (decisions.md 2026-11-14). */
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Feature flag gate for visibility in the wizard. Null = always visible. */
  featureFlagRequired: string | null;

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
 * Fields reconciliation leaves as stored once a row exists; everything else is
 * refreshed from the code definition on every boot. Until 2026-11-14 this was
 * also the admin PATCH allowlist; that route is removed, and the set is kept
 * unchanged so that boot never overwrites a stored value and a code revert
 * restores the old behaviour exactly (plan PLAN_AI_SETTINGS_IN_CODE.md).
 * The call-shaping fields among them are stored but never read at run time.
 *
 * `deletedAt` is not listed: the reconciler preserves it on a separate path.
 */
export const RECONCILE_PRESERVED_FIELDS = [
  "isActive",
  "isDefault",
  "sortOrder",
  "tierRequirement",
  "featureFlagRequired",
  "defaultResolution",
  "defaultAspectRatio",
  "expectedRunMs",
  "estimatedCostUsdPerCall",
  // An OpenAI engine's endpointId (reconcile.ts re-asserts a fal engine's).
  "endpointId",
  "defaultTemperature",
  "defaultMaxTokens",
  "defaultReasoningEffort",
] as const;



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
  | ({
    kind: "tokens";
    components: TokenPriceComponent[];
    usdPerCallFloor?: number;
    /**
     * What one image typically costs at the comparison settings, for showing
     * David an approximate price (within about 10%: his bar, 2026-11-10).
     * Never used as a bound.
     */
    typicalUsdPerImage?: number;
    /** Where the typical figure comes from. */
    typicalBasis?: string;
  } & PriceSource);

/**
 * What one image costs, for display: exact for a flat price, the typical
 * figure for a token price (approximate), and null when a token price has no
 * typical figure (its worst case is no estimate of what it costs).
 */
export function perImagePrice(model: PriceModel): { usd: number; exact: boolean } | null {
  if (model.kind === "flat") return { usd: model.usdPerImage, exact: true };
  return model.typicalUsdPerImage != null ? { usd: model.typicalUsdPerImage, exact: false } : null;
}

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
