import type { EngineDefinition } from "./types";

/**
 * fal-ai/workflow-utilities/auto-subtitle — burns brand-styled captions into
 * a generated MP4. Stage 3 of the video pipeline. Caption styling fields are
 * declared here so they can be tuned per-deployment without code changes.
 *
 * Note: fal's auto-subtitle accepts NAMED colors only (white/black/orange…),
 * not hex strings. The wizard spec speaks hex (#ffffff, #ff6b35); we keep
 * the named-color values here to match what fal accepts.
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
      { name: "font", from: "captionFont", type: "string", default: "Anton" },
      {
        name: "font_size",
        from: "captionFontSize",
        type: "int",
        default: 70,
        range: { min: 16, max: 200, policy: "clamp" },
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
        range: { min: 1, max: 6, policy: "clamp" },
      },
      { name: "animation", from: "animation", type: "boolean", default: true },
    ],
  },

  expectedRunMs: 8000,
  estimatedCostUsdPerCall: 0.02,
  estimatedCostUsdPerSecond: null,
};
