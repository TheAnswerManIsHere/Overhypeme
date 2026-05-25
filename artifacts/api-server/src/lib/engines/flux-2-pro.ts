import type { EngineDefinition } from "./types";

/**
 * FLUX.2 Pro — text-to-image. Newer generation than FLUX Pro v1.1; registered
 * alongside it so the workbench can A/B the two before we pick a production
 * default.
 *
 * Param shape verified against fal's docs for `fal-ai/flux-2-pro`
 * (text-to-image). IMPORTANT: this endpoint uses `image_size` (the named-size
 * enum, same vocabulary as flux-pro/v1.1) — NOT an `aspect_ratio` string. It
 * has no `num_images`, and `safety_tolerance` only goes to "5" (not "6").
 * A separate `fal-ai/flux-2-pro/edit` endpoint takes `image_urls` for
 * image-to-image; if we want that, it's its own catalogue entry.
 *
 * Distinguishing trait: NO reference/source image param → text-to-image bench.
 */
export const FLUX_2_PRO: EngineDefinition = {
  id: "flux-2-pro",
  provider: "fal",
  endpointId: "fal-ai/flux-2-pro",
  label: "FLUX.2 Pro (text-to-image)",
  description:
    "Text-to-image. Newer FLUX.2 generation — candidate upgrade for prompt-only scene generation.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 71,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "square",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  paramSchema: {
    params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      {
        name: "image_size",
        from: "aspectRatio",
        type: "string",
        map: {
          landscape: "landscape_16_9",
          square: "square_hd",
          portrait: "portrait_16_9",
        },
        enum: [
          "square_hd",
          "square",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9",
        ],
        default: "square_hd",
      },
      {
        name: "safety_tolerance",
        from: "safetyTolerance",
        type: "string",
        enum: ["1", "2", "3", "4", "5"],
        default: "2",
      },
      {
        name: "enable_safety_checker",
        from: "enableSafetyChecker",
        type: "boolean",
        default: true,
      },
      {
        name: "output_format",
        from: "outputFormat",
        type: "string",
        enum: ["jpeg", "png"],
        default: "jpeg",
      },
      // Omitted when blank — fal generates a random seed.
      { name: "seed", from: "seed", type: "int" },
    ],
  },

  expectedRunMs: 15000,
  estimatedCostUsdPerCall: 0.06,
  estimatedCostUsdPerSecond: null,
};
