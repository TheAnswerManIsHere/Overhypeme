import type { EngineDefinition } from "./types";

/**
 * FLUX.2 Pro — text-to-image. Newer generation than FLUX Pro v1.1; registered
 * alongside it so the workbench can A/B the two before we pick a production
 * default. The legacy pipeline already has a branch for `fal-ai/flux-2-pro`
 * (aiMemePipeline.generateAndStoreImage), which sends aspect_ratio +
 * output_format rather than the FLUX-1 image_size knobs — mirrored here.
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
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: {
          landscape: "16:9",
          square: "1:1",
          portrait: "9:16",
        },
        enum: ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"],
        default: "1:1",
      },
      {
        name: "output_format",
        from: "outputFormat",
        type: "string",
        enum: ["jpeg", "png"],
        default: "jpeg",
      },
      {
        name: "num_images",
        from: "numImages",
        type: "int",
        default: 1,
        range: { min: 1, max: 4, policy: "clamp" },
      },
    ],
  },

  expectedRunMs: 15000,
  estimatedCostUsdPerCall: 0.06,
  estimatedCostUsdPerSecond: null,
};
