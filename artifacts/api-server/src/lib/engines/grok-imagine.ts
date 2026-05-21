import type { EngineDefinition } from "./types";

/**
 * Grok Imagine — xAI. Three engine modes (Normal/Fun/Custom). Voiceover via
 * prompt cue ("Voiceover should say, 'X'") because the model doesn't have a
 * dedicated dialogue slot. $0.05/s at 480p.
 */
export const GROK_IMAGINE: EngineDefinition = {
  id: "grok-imagine",
  provider: "xai",
  endpointId: "xai/grok-imagine-video/image-to-video",
  label: "Grok Imagine",
  description:
    "xAI. Normal / Fun / Custom modes. Voiceover injected via prompt cue.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 50,
  featureFlagRequired: "engine_experiments",

  allowedDurationsSec: [4, 6, 8, 10],
  defaultDurationSec: 6,
  allowedResolutions: ["480p", "720p"],
  defaultResolution: "480p",
  allowedAspectRatios: ["16:9", "1:1", "9:16"],
  defaultAspectRatio: "16:9",
  supportedModes: ["normal", "fun", "custom"],
  defaultMode: "normal",

  audioHandling: "prompt_cue",
  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      {
        name: "duration",
        from: "durationSec",
        type: "int",
        default: 6,
        enum: [4, 6, 8, 10],
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
        enum: ["480p", "720p"],
        default: "480p",
      },
      {
        name: "mode",
        from: "mode",
        type: "string",
        enum: ["normal", "fun", "custom"],
        default: "normal",
      },
    ],
  },

  expectedRunMs: 18000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.05,
};
