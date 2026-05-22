import type { EngineDefinition } from "./types";

/**
 * Kling v3 Standard — Kuaishou, image-to-video with optional voice control
 * for deterministic dialogue. $0.084-0.154/s depending on audio mode.
 */
export const KLING_V3_STANDARD: EngineDefinition = {
  id: "kling-v3-standard",
  provider: "kuaishou",
  endpointId: "fal-ai/kling-video/v3/standard/image-to-video",
  label: "Kling v3 Standard",
  description:
    "Kuaishou. Native audio in English/Chinese, with explicit voice-control toggle for deterministic dialogue.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 30,
  featureFlagRequired: "engine_experiments",

  allowedDurationsSec: [3, 5, 8, 10, 15],
  defaultDurationSec: 5,
  allowedResolutions: ["720p", "1080p"],
  defaultResolution: "720p",
  allowedAspectRatios: ["16:9", "1:1", "9:16"],
  defaultAspectRatio: "16:9",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "voice_control",
  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      // Kling expects duration as a string-encoded integer.
      {
        name: "duration",
        from: "durationSec",
        type: "stringInt",
        default: "5",
        enum: ["3", "5", "8", "10", "15"],
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
        name: "negative_prompt",
        from: "negativePrompt",
        type: "string",
        default: "blur, distort, low quality",
      },
      // cfg_scale — typical Kling range is 0..1; we cap at the documented
      // endpoints to keep responses tame.
      {
        name: "cfg_scale",
        from: "cfgScale",
        type: "float",
        default: 0.5,
        range: { min: 0, max: 1, policy: "clamp" },
      },
      // voice_text — only emitted when the pipeline supplies dialogueText
      // (the video runner's applyAudioHandling routes renderedFactText here
      // for voice_control engines).
      {
        name: "voice_text",
        from: "dialogueText",
        type: "string",
        includeWhen: { field: "dialogueText", present: true },
      },
    ],
  },

  expectedRunMs: 28000,
  estimatedCostUsdPerCall: null,
  // Kling has three pricing tiers; default to mid-tier "audio on" rate.
  // Runtime override comes from getCachedPrice.
  estimatedCostUsdPerSecond: 0.126,
};
