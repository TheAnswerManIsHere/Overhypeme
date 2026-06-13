/**
 * Render-policy enum primitives (leaf module — no imports).
 *
 * These literal sets are shared by two layers that must NOT import each other:
 *   - `imagePromptGeneration.ts` (Phase 1 `RenderPolicy` / `DEFAULT_RENDER_POLICY`)
 *   - `visualStrategyOverride.ts` (Phase 2 moderator override, nested in the
 *     `FactEnrichment` blob via `taxonomy.ts`)
 *
 * Keeping them here as a dependency-free leaf avoids a `taxonomy → override →
 * imagePromptGeneration → taxonomy` import cycle.
 */

export const SUPPORTING_TEXT_MODE_VALUES = ["allow", "forbid", "require"] as const;
export type SupportingTextMode = (typeof SUPPORTING_TEXT_MODE_VALUES)[number];

export const VIOLENCE_MODE_VALUES = ["allow", "soften", "suppress"] as const;
export type ViolenceMode = (typeof VIOLENCE_MODE_VALUES)[number];

// "graphic" is FUTURE-COMPATIBLE only (a future adult/NSFW mode may use it). It is
// never selected or encouraged by default — the platform default is "strong"
// (visible death, bodies, explosions, weapons, action aftermath, without
// gratuitous gore).
export const VIOLENCE_INTENSITY_VALUES = [
  "nonviolent",
  "mild",
  "moderate",
  "strong",
  "graphic",
] as const;
export type ViolenceIntensity = (typeof VIOLENCE_INTENSITY_VALUES)[number];
