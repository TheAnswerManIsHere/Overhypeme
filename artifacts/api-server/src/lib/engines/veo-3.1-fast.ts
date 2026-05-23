import type { EngineDefinition } from "./types";

/**
 * Veo 3.1 Fast — Google DeepMind, image-to-video premium tier.
 * Schema verified against fal's live docs for
 * `fal-ai/veo3.1/fast/image-to-video` (May 2026).
 *
 * Notable contracts:
 *   - `duration` is a STRING with "s" suffix ("4s" | "6s" | "8s"), default "8s".
 *   - `aspect_ratio` enum is exactly ["auto", "16:9", "9:16"]. NO 1:1.
 *     Default is "auto".
 *   - `resolution` enum is ["720p", "1080p", "4k"] (lowercase k). Default "720p".
 *   - `generate_audio` IS accepted on the Fast endpoint (unlike Lite),
 *     default true. Drives the with-audio vs without-audio billing tier.
 *   - `auto_fix` (bool, default true) — fal auto-rewrites prompts that fail
 *     content-policy / validation rather than failing the request.
 *   - `safety_tolerance` is a STRING "1"-"6" (default "4"). 1=strictest,
 *     6=most permissive.
 *   - `negative_prompt`, `seed` are accepted optionals.
 *
 * Pricing (with audio):
 *   720p/1080p $0.15/s   ·   4k $0.35/s
 * Without audio:
 *   720p/1080p $0.10/s   ·   4k $0.30/s
 */
export const VEO_3_1_FAST: EngineDefinition = {
  id: "veo-3.1-fast",
  provider: "google",
  endpointId: "fal-ai/veo3.1/fast/image-to-video",
  label: "Veo 3.1 Fast",
  description:
    "Google DeepMind. 720p / 1080p / 4k with native audio + lipsync. Premium output at higher cost.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 20,
  featureFlagRequired: "engine_experiments",

  allowedDurationsSec: [4, 6, 8],
  defaultDurationSec: 6,
  allowedResolutions: ["720p", "1080p", "4k"],
  defaultResolution: "720p",
  allowedAspectRatios: ["auto", "16:9", "9:16", "1:1"],
  defaultAspectRatio: "auto",
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
        type: "string",
        map: { "4": "4s", "6": "6s", "8": "8s" },
        enum: ["4s", "6s", "8s"],
        default: "6s",
      },
      // `1:1` IS in fal's schema enum for Fast — delivered via crop, not
      // native — but accepted at the API layer. Lite doesn't include it.
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: { landscape: "16:9", square: "1:1", portrait: "9:16" },
        enum: ["auto", "16:9", "9:16", "1:1"],
        default: "auto",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["720p", "1080p", "4k"],
        default: "720p",
      },
      {
        name: "generate_audio",
        from: "generateAudio",
        type: "boolean",
        default: true,
      },
      {
        name: "auto_fix",
        from: "autoFix",
        type: "boolean",
        default: true,
      },
      // fal returns the safety_tolerance value as a STRING "1"-"6".
      {
        name: "safety_tolerance",
        from: "safetyTolerance",
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6"],
        default: "4",
      },
      {
        name: "enhance_prompt",
        from: "enhancePrompt",
        type: "boolean",
        default: true,
      },
      {
        name: "negative_prompt",
        from: "negativePrompt",
        type: "string",
        includeWhen: { field: "negativePrompt", present: true },
      },
      {
        name: "seed",
        from: "seed",
        type: "int",
        includeWhen: { field: "seed", present: true },
      },
    ],
  },

  expectedRunMs: 22000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.15,
};
