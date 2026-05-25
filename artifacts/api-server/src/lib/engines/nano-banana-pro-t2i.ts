import type { EngineDefinition } from "./types";

/**
 * Nano Banana Pro (Google Gemini 3 Pro Image) — text-to-image.
 * Schema verified against fal's docs for `fal-ai/nano-banana-pro` (the
 * NON-edit endpoint). The catalogue's existing `nano-banana-pro` engine is the
 * `/edit` (image-to-image) variant; this is its text-to-image sibling.
 *
 * Quality-first (deeper reasoning, slower, $0.15/image) — the LEGEND-tier hero
 * option for elaborate fact compositions where prompt fidelity matters most.
 *
 * Distinguishing trait: NO source image param → text-to-image bench.
 * Differences from Nano Banana 2: no extreme aspect ratios, no 0.5K
 * resolution, no thinking_level, limit_generations defaults false.
 */
export const NANO_BANANA_PRO_T2I: EngineDefinition = {
  id: "nano-banana-pro-t2i",
  provider: "google",
  endpointId: "fal-ai/nano-banana-pro",
  label: "Nano Banana Pro (text-to-image)",
  description:
    "Google Gemini 3 Pro Image. Quality-first text-to-image for LEGEND-tier hero compositions.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 82,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K",
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  paramSchema: {
    params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: {
          landscape: "16:9",
          square: "1:1",
          portrait: "9:16",
        },
        enum: [
          "auto", "21:9", "16:9", "3:2", "4:3", "5:4",
          "1:1", "4:5", "3:4", "2:3", "9:16",
        ],
        default: "9:16",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["1K", "2K", "4K"],
        default: "1K",
      },
      {
        name: "num_images",
        from: "numImages",
        type: "int",
        default: 1,
        range: { min: 1, max: 4, policy: "clamp" },
      },
      {
        name: "output_format",
        from: "outputFormat",
        type: "string",
        enum: ["jpeg", "png", "webp"],
        default: "png",
      },
      {
        name: "safety_tolerance",
        from: "safetyTolerance",
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6"],
        default: "5",
      },
      {
        name: "limit_generations",
        from: "limitGenerations",
        type: "boolean",
        default: false,
      },
      {
        name: "enable_web_search",
        from: "enableWebSearch",
        type: "boolean",
        default: false,
      },
      { name: "seed", from: "seed", type: "int" },
    ],
  },

  expectedRunMs: 14000,
  // $0.15/image at 1K/2K, $0.30 at 4K. +$0.015/call with web search.
  estimatedCostUsdPerCall: 0.15,
  estimatedCostUsdPerSecond: null,
};
