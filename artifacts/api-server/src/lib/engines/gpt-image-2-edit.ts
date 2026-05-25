import type { EngineDefinition } from "./types";

/**
 * GPT Image 2 Edit (OpenAI, alpha) — image-to-image, served via fal at
 * `openai/gpt-image-2/edit`. Schema verified against fal's API reference.
 *
 * Edit variant: takes reference images (`image_urls`) and an optional
 * `mask_url` for precise inpainting/outpainting. A bench option to compare
 * against Nano Banana 2 edit / PuLID for selfie stylization — though its
 * identity preservation is less benchmarked, so worth eyeballing.
 *
 * Distinguishing trait: declares `image_urls` (from referenceImageUrl) → the
 * workbench renders the image-to-image bench. BYOK `openai_api_key` is
 * intentionally not declared (fal handles billing).
 */
export const GPT_IMAGE_2_EDIT: EngineDefinition = {
  id: "gpt-image-2-edit",
  provider: "openai",
  endpointId: "openai/gpt-image-2/edit",
  label: "GPT Image 2 (edit / image-to-image)",
  description:
    "OpenAI GPT Image 2 edit (alpha). Reference-image editing with optional mask-based inpainting.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 73,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
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
      // stringArray wraps the single referenceImageUrl into [url]; an array
      // passes through unchanged.
      {
        name: "image_urls",
        from: "referenceImageUrl",
        type: "stringArray",
        required: true,
      },
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
        // Edit defaults to "auto" (infer from the input image).
        default: "auto",
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
      // Optional inpainting mask; omitted when blank.
      { name: "mask_url", from: "maskUrl", type: "string" },
    ],
  },

  expectedRunMs: 20000,
  estimatedCostUsdPerCall: 0.17,
  estimatedCostUsdPerSecond: null,
};
