import type { EngineDefinition } from "./types";

/**
 * Seedance 2.0 Fast — ByteDance, image-to-video with native audio + multi-shot
 * support. $0.2419/s at 720p. Long-form option (4-15s in a single generation).
 *
 * Quirk: bytedance/seedance-2.0/fast requires `end_user_id` per ToS — fal
 * rejects requests without it. The video pipeline runner supplies job.userId.
 */
export const SEEDANCE_2_0_FAST: EngineDefinition = {
  id: "seedance-2.0-fast",
  provider: "bytedance",
  endpointId: "bytedance/seedance-2.0/fast/image-to-video",
  label: "Seedance 2.0 Fast",
  description:
    "ByteDance. 4-15s durations, multi-shot capability, strong physics. Audio included.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 40,
  featureFlagRequired: "engine_experiments",

  allowedDurationsSec: [4, 6, 8, 10, 12, 15],
  defaultDurationSec: 6,
  allowedResolutions: ["720p"],
  defaultResolution: "720p",
  allowedAspectRatios: ["16:9", "1:1", "9:16", "4:3", "3:4"],
  defaultAspectRatio: "16:9",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "native_audio_boolean",
  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      {
        name: "duration",
        from: "durationSec",
        type: "int",
        default: 6,
        enum: [4, 6, 8, 10, 12, 15],
      },
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: { landscape: "16:9", square: "1:1", portrait: "9:16" },
        enum: ["16:9", "1:1", "9:16", "4:3", "3:4"],
        default: "16:9",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["720p"],
        default: "720p",
      },
      {
        name: "generate_audio",
        from: "generateAudio",
        type: "boolean",
        default: true,
      },
      // ByteDance ToS requirement — fail loudly if the runner forgot.
      {
        name: "end_user_id",
        from: "endUserId",
        type: "string",
        required: true,
      },
    ],
  },

  expectedRunMs: 35000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.2419,
};
