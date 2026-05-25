import type { EngineDefinition } from "./types";

/**
 * GPT Image 2 (OpenAI, alpha) — text-to-image, served via fal's queue at
 * `openai/gpt-image-2`. Schema verified against fal's API reference.
 *
 * Strongest in-image text rendering of the candidate models; a bench option
 * to compare against the Gemini/FLUX families. Served through fal like every
 * other engine (no special integration). The BYOK `openai_api_key` param is
 * intentionally NOT declared — it's a secret and we let fal handle billing;
 * wire it only if we ever want to route through our own OpenAI account.
 *
 * Distinguishing trait: NO source image param → text-to-image bench. The edit
 * sibling (`gpt-image-2-edit`) adds `image_urls` + `mask_url`.
 *
 * Note: this endpoint has no `resolution` knob — size is driven by
 * `image_size` (named enum) and detail by `quality` (low/medium/high).
 */
export const GPT_IMAGE_2: EngineDefinition = {
  id: "gpt-image-2",
  provider: "openai",
  endpointId: "openai/gpt-image-2",
  label: "GPT Image 2 (text-to-image)",
  description:
    "OpenAI GPT Image 2 (alpha). Reasoning-based text-to-image with best-in-class in-image text rendering.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 72,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  // No `resolution` param on this endpoint — size comes from image_size.
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  paramSchema: {
    params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      {
        name: "image_size",
        from: "aspectRatio",
        type: "string",
        map: {
          landscape: "landscape_16_9",
          square: "square_hd",
          portrait: "portrait_16_9",
        },
        enum: [
          "square_hd",
          "square",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9",
          "auto",
        ],
        default: "square_hd",
      },
      {
        name: "quality",
        from: "quality",
        type: "string",
        enum: ["auto", "low", "medium", "high"],
        default: "high",
      },
      {
        name: "output_format",
        from: "outputFormat",
        type: "string",
        enum: ["jpeg", "png", "webp"],
        default: "png",
      },
      { name: "num_images", from: "numImages", type: "int", default: 1 },
    ],
  },

  expectedRunMs: 20000,
  // Tiered: ~$0.01 (low) to ~$0.40 (4K high). Mid estimate for high quality.
  estimatedCostUsdPerCall: 0.17,
  estimatedCostUsdPerSecond: null,
};
