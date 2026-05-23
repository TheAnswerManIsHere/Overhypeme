import type { EngineDefinition } from "./types";

/**
 * Kling v3 Standard — Kuaishou, image-to-video.
 *
 * Audio: `generate_audio` boolean toggles native audio (default true on
 * fal's side). The model picks dialogue out of the prompt itself — quoted
 * speech in the motion prompt is what produces voiceover. There is NO
 * dedicated `voice_text` param on this endpoint (despite older docs); fal
 * silently accepts the key and Kling ignores it. We therefore route
 * dialogue via `prompt_cue` semantics, same as Grok.
 *
 * Pricing: $0.084/s (audio off) or $0.126/s (audio on).
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

  audioHandling: "prompt_cue",
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
      {
        name: "generate_audio",
        from: "generateAudio",
        type: "boolean",
        default: true,
      },
    ],
  },

  expectedRunMs: 28000,
  estimatedCostUsdPerCall: null,
  // Kling has three pricing tiers; default to mid-tier "audio on" rate.
  // Runtime override comes from getCachedPrice.
  estimatedCostUsdPerSecond: 0.126,
};
