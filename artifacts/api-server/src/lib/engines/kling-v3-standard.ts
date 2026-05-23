import type { EngineDefinition } from "./types";

/**
 * Kling v3 Standard — Kuaishou, image-to-video.
 * Schema verified against fal's live docs for
 * `fal-ai/kling-video/v3/standard/image-to-video` (May 2026).
 *
 * Notable contracts:
 *   - The image input field is `start_image_url`, NOT `image_url`. O3-family
 *     endpoints use `image_url`; v3-family uses `start_image_url`. Easy footgun.
 *   - `duration` is stringified int; full enum is every integer 3-15 as
 *     strings. Default "5".
 *   - `aspect_ratio` is accepted but SILENTLY IGNORED when an image is
 *     provided (the image governs the aspect). We still send it because the
 *     wizard surfaces the choice; treat as decorative on this endpoint.
 *   - `cfg_scale` float 0-1, default 0.5.
 *   - `generate_audio` boolean, default true. Pricing tier: $0.084/s (off),
 *     $0.126/s (on), $0.154/s (on + voice_ids).
 *   - Dialogue is driven by the PROMPT itself: write spoken lines into the
 *     motion prompt. Optional `voice_ids` (max 2) with `<<<voice_1>>>` /
 *     `<<<voice_2>>>` tokens in the prompt assigns specific voice profiles.
 *     We use `prompt_cue` audioHandling so the engineAudio helper appends
 *     `Voiceover should say, "..."` to the motion prompt — same path as Grok.
 */
export const KLING_V3_STANDARD: EngineDefinition = {
  id: "kling-v3-standard",
  provider: "kuaishou",
  endpointId: "fal-ai/kling-video/v3/standard/image-to-video",
  label: "Kling v3 Standard",
  description:
    "Kuaishou. Native audio in English/Chinese. Dialogue driven by the motion prompt.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 30,
  featureFlagRequired: "engine_experiments",

  allowedDurationsSec: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
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
      // v3-family expects start_image_url, not image_url.
      { name: "start_image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      // stringInt: 5 → "5". Full integer 3-15 range, no gaps.
      {
        name: "duration",
        from: "durationSec",
        type: "stringInt",
        default: "5",
        enum: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
      },
      // Accepted but silently ignored when image present. Kept to satisfy
      // the wizard's aspect selector; the model uses the image's aspect.
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
  // With-audio tier ($0.126/s). Voice-control tier ($0.154/s) only kicks in
  // when voice_ids is supplied; runtime override comes from getCachedPrice.
  estimatedCostUsdPerSecond: 0.126,
};
