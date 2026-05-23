import type { EngineDefinition } from "./types";

/**
 * Nano Banana Pro (Google Gemini 3 Pro Image) — face-preserving image
 * editing. Schema verified against fal's live docs for
 * `fal-ai/nano-banana-pro/edit` (May 2026).
 *
 * Replaces PuLID as the default Stage-1 styler in the engine catalogue.
 * Google's headline strength for this model is likeness preservation
 * across outfit / scene / style swaps — exactly the meme use case.
 *
 * IMPORTANT runtime caveat: the video pipeline's Stage 1
 * (`videoPipelineRunner.ts` `runStage1`) still calls
 * `generateAiMemeBackgroundFromReference` from `aiMemePipeline.ts`,
 * which hardcodes PuLID. Marking Nano Banana Pro as `isDefault: true`
 * here makes it the catalogue default (admin workbench picks it up
 * via the engine test endpoint), but the production video pipeline
 * still runs PuLID until a follow-up refactor wires Stage 1 through
 * `loadDefaultEngine("image")` + `buildEngineInput`.
 *
 * Notable contracts (from the fal docs):
 *   - `image_urls` is an ARRAY (up to 14). Our pipelineParams sends a
 *     single `referenceImageUrl` string; the new `stringArray` primitive
 *     wraps it as [url] at emit time.
 *   - `aspect_ratio` accepts 11 values incl. `auto` (default). We map
 *     the wizard's `landscape`/`square`/`portrait` to `16:9`/`1:1`/`9:16`.
 *   - `resolution` is `1K` | `2K` | `4K` (NOT `720p`/`1080p` like the
 *     video engines). Default `1K`.
 *   - `safety_tolerance` is the only safety knob — there is no
 *     `enable_safety_checker` boolean. String "1" (strict) – "6" (loose).
 *     Default "4". For meme content with real likenesses, raising to
 *     "5" or "6" reduces `IMAGE_SAFETY` rejections.
 *   - NO `seed`, `negative_prompt`, `guidance_scale` exposed.
 *   - Output: `images[].url` (no `has_nsfw_concepts`, no seed echo —
 *     safety violations fail the call rather than returning a flagged
 *     image).
 *
 * Pricing (per output image):
 *   - 1K: $0.139
 *   - 2K: $0.139
 *   - 4K: $0.279
 *   - +$0.015 per call if `enable_web_search` is true.
 */
export const NANO_BANANA_PRO: EngineDefinition = {
  id: "nano-banana-pro",
  provider: "google",
  endpointId: "fal-ai/nano-banana-pro/edit",
  label: "Nano Banana Pro (edit)",
  description:
    "Google Gemini 3 Pro Image. Best-in-class face preservation for selfie-to-meme stylization.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: true,
  isActive: true,
  sortOrder: 90,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  // Nano Banana Pro speaks 1K/2K/4K, not the video pixel-height labels.
  allowedResolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K",
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  paramSchema: {
    params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      // stringArray wraps the single referenceImageUrl into [url]. If the
      // caller eventually sends multiple references (the API accepts up
      // to 14), an array passes through unchanged.
      {
        name: "image_urls",
        from: "referenceImageUrl",
        type: "stringArray",
        required: true,
      },
      {
        name: "aspect_ratio",
        from: "aspectRatio",
        type: "string",
        map: {
          landscape: "16:9",
          square: "1:1",
          portrait: "9:16",
        },
        enum: [
          "auto",
          "21:9",
          "16:9",
          "4:3",
          "3:2",
          "5:4",
          "1:1",
          "4:5",
          "3:4",
          "2:3",
          "9:16",
        ],
        default: "9:16",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["1K", "2K", "4K"],
        default: "1K",
      },
      {
        name: "num_images",
        from: "numImages",
        type: "int",
        default: 1,
        range: { min: 1, max: 4, policy: "clamp" },
      },
      {
        name: "output_format",
        from: "outputFormat",
        type: "string",
        enum: ["png", "jpeg"],
        default: "png",
      },
      // String "1" (strictest) - "6" (most permissive). Meme prompts on
      // real selfies tend to trip the filter at default "4"; raise to
      // "5" if IMAGE_SAFETY rejections become common.
      {
        name: "safety_tolerance",
        from: "safetyTolerance",
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6"],
        default: "5",
      },
      {
        name: "enable_web_search",
        from: "enableWebSearch",
        type: "boolean",
        default: false,
      },
    ],
  },

  expectedRunMs: 14000,
  // $0.139 at 1K and 2K, $0.279 at 4K — flat per-image, not per-second.
  estimatedCostUsdPerCall: 0.139,
  estimatedCostUsdPerSecond: null,
};
