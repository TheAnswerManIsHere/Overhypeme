import type { EngineDefinition } from "./types";

/**
 * fal-ai/workflow-utilities/auto-subtitle — burns brand-styled captions into
 * a generated MP4. Stage 3 of the video pipeline.
 *
 * Schema verified against fal's live docs (May 2026):
 *   - Font field is `font_name` (NOT `font`).
 *   - Animation toggle is `enable_animation` (NOT `animation`).
 *   - Color fields accept BOTH named CSS colors and #RRGGBB hex strings
 *     (previous comment claiming "named only" was wrong).
 *   - `font_size` range is [20, 150]. `words_per_subtitle` range is [1, 12].
 *   - Optional: `language` (ISO-639-1, "" or omit = auto-detect),
 *     `font_weight` (Google Fonts weight name), `background_color`.
 *
 * Pricing: $0.03 per minute of input video.
 */
export const FAL_AUTO_SUBTITLE: EngineDefinition = {
  id: "fal-auto-subtitle",
  provider: "fal",
  endpointId: "fal-ai/workflow-utilities/auto-subtitle",
  label: "Auto-subtitle (utility)",
  description:
    "Burns brand-styled captions into a generated MP4. Internal utility, runs after every video.",
  kind: "utility",
  tierRequirement: "legendary",
  isDefault: true,
  isActive: true,
  sortOrder: 200,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  paramSchema: {
    params: [
      { name: "video_url", from: "videoUrl", type: "string", required: true },
      // Language: empty/omitted → auto-detect.
      {
        name: "language",
        from: "language",
        type: "string",
        includeWhen: { field: "language", present: true },
      },
      { name: "font_name", from: "captionFont", type: "string", default: "Anton" },
      {
        name: "font_size",
        from: "captionFontSize",
        type: "int",
        default: 70,
        range: { min: 20, max: 150, policy: "clamp" },
      },
      {
        name: "font_weight",
        from: "fontWeight",
        type: "string",
        default: "bold",
      },
      { name: "font_color", from: "captionColor", type: "string", default: "white" },
      {
        name: "highlight_color",
        from: "highlightColor",
        type: "string",
        default: "orange",
      },
      {
        name: "stroke_width",
        from: "strokeWidth",
        type: "int",
        default: 3,
        range: { min: 0, max: 12, policy: "clamp" },
      },
      { name: "stroke_color", from: "strokeColor", type: "string", default: "black" },
      {
        name: "background_color",
        from: "backgroundColor",
        type: "string",
        default: "none",
      },
      {
        name: "position",
        from: "position",
        type: "string",
        default: "bottom",
        enum: ["bottom", "top", "center"],
      },
      {
        name: "y_offset",
        from: "yOffset",
        type: "int",
        default: 75,
      },
      {
        name: "words_per_subtitle",
        from: "wordsPerSubtitle",
        type: "int",
        default: 1,
        range: { min: 1, max: 12, policy: "clamp" },
      },
      { name: "enable_animation", from: "animation", type: "boolean", default: true },
    ],
  },

  expectedRunMs: 8000,
  estimatedCostUsdPerCall: 0.02,
  estimatedCostUsdPerSecond: null,
};
