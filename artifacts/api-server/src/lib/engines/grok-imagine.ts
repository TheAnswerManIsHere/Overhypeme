import type { EngineDefinition } from "./types";

/**
 * Grok Imagine — xAI, image-to-video.
 * Schema verified against fal's live docs for
 * `xai/grok-imagine-video/image-to-video` (May 2026).
 *
 * Notable contracts:
 *   - Endpoint ID has the `xai/` namespace, no `fal-ai/` prefix.
 *   - The "engine mode" field is named `video_preset` (NOT `mode`). On the
 *     image-to-video route only `normal` and `fun` are supported. (`custom`
 *     and `spicy` exist on text-to-video / other routes.)
 *   - `aspect_ratio` enum is "auto", "16:9", "4:3", "3:2", "1:1", "2:3",
 *     "3:4", "9:16". Default "auto" (inherits from input image).
 *   - `resolution` enum is exactly ["480p", "720p"]. 24 FPS native.
 *   - Native synchronized audio is generated automatically — there is no
 *     audio toggle or voice slot. Dialogue is prompt-driven; the
 *     engineAudio `prompt_cue` handler appends `Voiceover should say, "..."`
 *     to the motion prompt.
 *   - Negative prompts are silently ignored by the model — describe what
 *     you want, not what you don't.
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

  allowedDurationsSec: [4, 6, 8, 10],
  defaultDurationSec: 6,
  allowedResolutions: ["480p", "720p"],
  defaultResolution: "480p",
  allowedAspectRatios: ["auto", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"],
  defaultAspectRatio: "auto",
  // Only normal and fun are valid on image-to-video.
  supportedModes: ["normal", "fun"],
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
      // The xAI-side field name is `video_preset`. We read from the wizard's
      // generic `mode` pipeline param so the admin UI surface stays consistent.
      {
        name: "video_preset",
        from: "mode",
        type: "string",
        enum: ["normal", "fun"],
        default: "normal",
      },
    ],
  },

  expectedRunMs: 18000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.05,
};
