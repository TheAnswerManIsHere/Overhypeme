import type { EngineDefinition } from "./types";

/**
 * Veo 3.1 Lite — Google DeepMind, image-to-video with native lipsync audio.
 * Workhorse tier: 720p only, audio always on, $0.05/s.
 *
 * Param shape verified against fal's docs for fal-ai/veo3.1/lite/image-to-video.
 * Notably DOES NOT accept `generate_audio` — that's a Seedance param. Sending
 * it produces a 422 "no_media_generated" error at fal (see migration 0058).
 */
export const VEO_3_1_LITE: EngineDefinition = {
  id: "veo-3.1-lite",
  provider: "google",
  endpointId: "fal-ai/veo3.1/lite/image-to-video",
  label: "Veo 3.1 Lite",
  description:
    "Google DeepMind. 720p with native audio + lipsync. 4-8s clips. Workhorse for video memes.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: true,
  isActive: true,
  sortOrder: 10,
  featureFlagRequired: null,

  allowedDurationsSec: [4, 6, 8],
  defaultDurationSec: 6,
  allowedResolutions: ["720p"],
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
        enum: ["720p"],
        default: "720p",
      },
      // Optional negative prompt — only included when explicitly set.
      {
        name: "negative_prompt",
        from: "negativePrompt",
        type: "string",
        includeWhen: { field: "negativePrompt", present: true },
      },
    ],
  },

  expectedRunMs: 18000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.05,
};
