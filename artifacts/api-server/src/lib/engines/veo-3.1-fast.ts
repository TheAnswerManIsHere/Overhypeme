import type { EngineDefinition } from "./types";

/**
 * Veo 3.1 Fast — premium tier with 720p/1080p, audio + lipsync at $0.15/s.
 */
export const VEO_3_1_FAST: EngineDefinition = {
  id: "veo-3.1-fast",
  provider: "google",
  endpointId: "fal-ai/veo3.1/fast/image-to-video",
  label: "Veo 3.1 Fast",
  description:
    "Google DeepMind. 720p or 1080p with native audio + lipsync. Premium output at higher cost.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 20,
  featureFlagRequired: "engine_experiments",

  allowedDurationsSec: [4, 6, 8],
  defaultDurationSec: 6,
  allowedResolutions: ["720p", "1080p"],
  defaultResolution: "720p",
  allowedAspectRatios: ["16:9", "1:1", "9:16"],
  defaultAspectRatio: "16:9",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "native_lipsync",
  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      {
        name: "duration",
        from: "durationSec",
        type: "int",
        default: 6,
        enum: [4, 6, 8],
      },
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: { landscape: "16:9", square: "1:1", portrait: "9:16" },
        enum: ["16:9", "1:1", "9:16"],
        default: "16:9",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["720p", "1080p"],
        default: "720p",
      },
      {
        name: "negative_prompt",
        from: "negativePrompt",
        type: "string",
        includeWhen: { field: "negativePrompt", present: true },
      },
    ],
  },

  expectedRunMs: 22000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.15,
};
