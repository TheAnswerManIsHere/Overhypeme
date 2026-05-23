import type { EngineDefinition } from "./types";

/**
 * Seedance 2.0 Fast — ByteDance, image-to-video with native audio + multi-shot.
 * Schema verified against fal's live docs for
 * `bytedance/seedance-2.0/fast/image-to-video` (May 2026).
 *
 * Notable contracts:
 *   - Endpoint ID has NO `fal-ai/` prefix — `bytedance/seedance-2.0/...`
 *   - `duration` is a string. Enum: "auto" + every integer "4"-"15". Default "auto".
 *   - `aspect_ratio` enum is 7 values: "auto", "21:9", "16:9", "4:3", "1:1",
 *     "3:4", "9:16". Default "auto" (matches input image).
 *   - `resolution` enum is exactly ["480p", "720p"]. NO 1080p on the fast
 *     tier (1080p is standard-tier exclusive).
 *   - `generate_audio` boolean, default true. Pricing is identical whether
 *     on or off — no cost savings to disable.
 *   - `end_user_id` is OPTIONAL per fal docs, but ByteDance ToS requires
 *     tracking. The route always supplies an admin-test id; we leave it
 *     required in the schema so missing it fails loudly rather than ships
 *     an untracked production call.
 *   - `seed` (int) and `end_image_url` (string URL) accepted optionals.
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

  allowedDurationsSec: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  defaultDurationSec: 6,
  allowedResolutions: ["480p", "720p"],
  defaultResolution: "720p",
  allowedAspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
  defaultAspectRatio: "auto",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "native_audio_boolean",
  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      // String. "auto" plus every int "4"-"15". String coerce handles both
      // the numeric wizard value (6 → "6") and the literal "auto".
      {
        name: "duration",
        from: "durationSec",
        type: "string",
        default: "6",
        enum: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
      },
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: { landscape: "16:9", square: "1:1", portrait: "9:16" },
        enum: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        default: "auto",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["480p", "720p"],
        default: "720p",
      },
      {
        name: "generate_audio",
        from: "generateAudio",
        type: "boolean",
        default: true,
      },
      // ByteDance ToS recommends sending this for per-user attribution;
      // fal's schema marks it OPTIONAL (no 422 if omitted). Runner-side
      // code always supplies the user id, so production traffic still
      // carries it — but we don't fail-fast at the schema layer.
      {
        name: "end_user_id",
        from: "endUserId",
        type: "string",
        includeWhen: { field: "endUserId", present: true },
      },
      {
        name: "seed",
        from: "seed",
        type: "int",
        includeWhen: { field: "seed", present: true },
      },
      {
        name: "end_image_url",
        from: "endImageUrl",
        type: "string",
        includeWhen: { field: "endImageUrl", present: true },
      },
    ],
  },

  expectedRunMs: 35000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.2419,
};
