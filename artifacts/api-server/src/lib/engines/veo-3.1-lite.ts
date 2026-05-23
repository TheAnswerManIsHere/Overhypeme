import type { EngineDefinition } from "./types";

/**
 * Veo 3.1 Lite — Google DeepMind, image-to-video. Param shape verified
 * against fal's live docs for `fal-ai/veo3.1/lite/image-to-video` (May 2026).
 *
 * Notable contracts:
 *   - `duration` is a STRING with "s" suffix ("4s" | "6s" | "8s"), default "8s".
 *     fal returns 422 if a bare integer is sent.
 *   - `aspect_ratio` enum is exactly ["auto", "16:9", "9:16"]. NO 1:1.
 *     Default is "auto" (model infers from input image).
 *   - `resolution` supports BOTH 720p and 1080p — but 1080p is gated to
 *     duration="8s" (cross-field constraint enforced by fal; surfaced as 422
 *     if the caller violates it).
 *   - `generate_audio` (bool, default true) IS accepted per current fal docs.
 *     Migration 0058 documented a 422 from this field months ago; fal may
 *     have added support since. The engineInterpreter regression test now
 *     asserts Lite SHOULD emit `generate_audio` — if a workbench run 422s,
 *     the test gives a clean rollback signal. Toggling false drops the
 *     per-second rate from $0.05 (with audio) to $0.03 (without).
 *   - `auto_fix` (bool, default FALSE per docs) auto-rewrites prompts that
 *     trip content policy. `safety_tolerance` is a STRING "1"-"6" (default
 *     "4"; 1 = strictest, 6 = most permissive). Same shape as Fast.
 *   - `negative_prompt`, `seed`, `enhance_prompt` are accepted optionals.
 */
export const VEO_3_1_LITE: EngineDefinition = {
  id: "veo-3.1-lite",
  provider: "google",
  endpointId: "fal-ai/veo3.1/lite/image-to-video",
  label: "Veo 3.1 Lite",
  description:
    "Google DeepMind. 720p/1080p with native audio + lipsync. 4-8s clips. Workhorse for video memes.",
  kind: "video",
  tierRequirement: "legendary",
  isDefault: true,
  isActive: true,
  sortOrder: 10,
  featureFlagRequired: null,

  allowedDurationsSec: [4, 6, 8],
  defaultDurationSec: 6,
  allowedResolutions: ["720p", "1080p"],
  defaultResolution: "720p",
  allowedAspectRatios: ["auto", "16:9", "9:16"],
  defaultAspectRatio: "auto",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "native_lipsync",
  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      { name: "prompt", from: "motionPrompt", type: "string", required: true },
      // STRING with "s" suffix. Map wizard-side integer seconds into fal's
      // string format.
      {
        name: "duration",
        from: "durationSec",
        type: "string",
        map: { "4": "4s", "6": "6s", "8": "8s" },
        enum: ["4s", "6s", "8s"],
        default: "6s",
      },
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: { landscape: "16:9", portrait: "9:16" },
        enum: ["auto", "16:9", "9:16"],
        default: "auto",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["720p", "1080p"],
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
        default: false,
      },
      // String "1"-"6". 1=strictest, 6=most permissive. Same shape as Fast.
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

  expectedRunMs: 18000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: 0.05,
};
