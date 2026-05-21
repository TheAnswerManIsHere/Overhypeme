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
 * persisted. Code-owned fields (paramSchema, audioHandling, allowed sets,
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

/**
 * How an engine handles spoken dialogue. The video pipeline runner routes
 * `renderedFactText` to the right place per engine.
 *
 *   - "native_lipsync"        — Veo. Dialogue embedded in the prompt; the
 *                                model produces audio + lipsync natively.
 *   - "prompt_cue"            — Grok. Voiceover injected as a prompt cue
 *                                ("Voiceover should say, 'X'").
 *   - "voice_control"         — Kling v3. Engine exposes an explicit
 *                                voice-text input slot (param dialogueText).
 *   - "native_audio_boolean"  — Seedance. Boolean flag enabling improvised
 *                                audio; dialogue still flows via prompt cue.
 *   - "none"                  — Utility engines (PuLID, auto-subtitle).
 */
export type AudioHandling =
  | "native_lipsync"
  | "prompt_cue"
  | "voice_control"
  | "native_audio_boolean"
  | "none";

export type EngineKind = "image" | "video" | "utility";
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

  // ── Allowed option sets (drive the wizard's advanced sheet radios) ──────
  /** In seconds. Null for engines without a duration knob (utilities). */
  allowedDurationsSec: number[] | null;
  defaultDurationSec: number | null;
  /** Resolution strings as the engine itself speaks them. */
  allowedResolutions: string[] | null;
  defaultResolution: string | null;
  /** Aspect ratios in fal format (server-side). */
  allowedAspectRatios: string[] | null;
  defaultAspectRatio: string | null;
  /** Engine modes (e.g. Grok: ["normal","fun","custom"]). */
  supportedModes: string[];
  defaultMode: string | null;

  // ── Pipeline behavior ───────────────────────────────────────────────────
  audioHandling: AudioHandling;
  paramSchema: ParamSchema;

  // ── Runtime + cost hints (admin-editable defaults; runtime pricing
  //    overrides come from getCachedPrice / fal pricing cache) ────────────
  /** EMA seed for the progress bar's expected runtime. */
  expectedRunMs: number;
  /** Fallback flat cost when fal pricing is unavailable. Always defer to
   *  getCachedPrice() at runtime. */
  estimatedCostUsdPerCall: number | null;
  /** Fallback per-second cost when fal pricing is unavailable. */
  estimatedCostUsdPerSecond: number | null;
}

/**
 * Sub-set of fields that admins can edit through the admin engines panel.
 * Reconciliation preserves these once first persisted; everything outside
 * this list is overwritten on every boot from the code definition.
 *
 * Keep this in sync with `routes/adminEngines.ts` ALLOWED_PATCH_FIELDS.
 */
export const ADMIN_EDITABLE_FIELDS = [
  "isActive",
  "isDefault",
  "sortOrder",
  "tierRequirement",
  "featureFlagRequired",
  "defaultDurationSec",
  "defaultResolution",
  "defaultAspectRatio",
  "defaultMode",
  "expectedRunMs",
  "estimatedCostUsdPerCall",
  "estimatedCostUsdPerSecond",
  "deletedAt",
] as const;

export type AdminEditableField = (typeof ADMIN_EDITABLE_FIELDS)[number];
