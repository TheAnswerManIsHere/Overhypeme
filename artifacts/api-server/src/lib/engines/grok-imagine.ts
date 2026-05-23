import type { EngineDefinition } from "./types";

/**
 * Grok Imagine — xAI, image-to-video.
 * Schema verified against fal's live docs for
 * `xai/grok-imagine-video/image-to-video` (May 2026).
 *
 * Notable contracts:
 *   - Endpoint ID has the `xai/` namespace, no `fal-ai/` prefix.
 *   - The "engine mode" field is named `video_preset` (NOT `mode`).
 *     Image-to-video supports the FULL enum: normal, fun, custom, spicy.
 *     A prior fix mistakenly narrowed it to [normal, fun]; spicy and
 *     custom ARE valid on this endpoint per fal's docs.
 *   - `aspect_ratio` enum is "auto", "16:9", "4:3", "3:2", "1:1", "2:3",
 *     "3:4", "9:16". Default "auto" (inherits from input image).
 *   - `duration` is an integer 1-10 (NOT a strict [4,6,8,10] enum).
 *     Default 6.
 *   - `resolution` enum is exactly ["480p", "720p"]. 24 FPS native.
 *   - Native synchronized audio is generated automatically — there is no
 *     audio toggle or voice slot. Dialogue is prompt-driven; the
 *     engineAudio `prompt_cue` handler appends `Voiceover should say, "..."`
 *     to the motion prompt.
 *   - `negative_prompt` is not exposed by this endpoint.
 *
 * Pricing: $0.05/s @ 480p, $0.07/s @ 720p (with native audio always on).
 */
export const GROK_IMAGINE: EngineDefinition = {
  id: "grok-imagine",
  provider: "xai",
  endpointId: "xai/grok-imagine-video/image-to-video",
  label: "Grok Imagine",
  description:
    "xAI. Normal / Fun presets at 480p or 720p. Native audio + lipsync.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 50,
  featureFlagRequired: "engine_experiments",

  // Wizard exposes a sensible subset of duration choices; the engine API
  // itself accepts every integer 1-10 (enforced via paramSchema range).
  allowedDurationsSec: [4, 6, 8, 10],
  defaultDurationSec: 6,
  allowedResolutions: ["480p", "720p"],
  defaultResolution: "480p",
  allowedAspectRatios: ["auto", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"],
  defaultAspectRatio: "auto",
  supportedModes: ["normal", "fun", "custom", "spicy"],
  defaultMode: "normal",

  audioHandling: "prompt_cue",
  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      // Integer 1-10. Clamp out-of-range silently rather than rejecting.
      {
        name: "duration",
        from: "durationSec",
        type: "int",
        default: 6,
        range: { min: 1, max: 10, policy: "clamp" },
      },
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: { landscape: "16:9", square: "1:1", portrait: "9:16" },
        enum: ["auto", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"],
        default: "auto",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["480p", "720p"],
        default: "480p",
      },
      // xAI-side field is `video_preset`. We read from the wizard's
      // generic `mode` pipeline param. Full enum on image-to-video.
      {
        name: "video_preset",
        from: "mode",
        type: "string",
        enum: ["normal", "fun", "custom", "spicy"],
        default: "normal",
      },
      {
        name: "seed",
        from: "seed",
        type: "int",
        includeWhen: { field: "seed", present: true },
      },
    ],
  },

  expectedRunMs: 18000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.05,
};
