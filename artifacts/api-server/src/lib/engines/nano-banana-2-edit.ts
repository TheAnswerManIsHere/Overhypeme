import type { EngineDefinition } from "./types";

/**
 * Nano Banana 2 Edit (Google Gemini 3.1 Flash Image) — image-to-image.
 * Schema verified against fal's docs for `fal-ai/nano-banana-2/edit`.
 *
 * The recommended upgrade path from PuLID for selfie-to-meme stylization:
 * native multimodal identity means a normal prompt can describe the person's
 * appearance/pose/scene without the latent conflict that forced us to strip
 * descriptors for PuLID. Accepts up to 14 reference images.
 *
 * Distinguishing trait: declares `image_urls` (from referenceImageUrl) → the
 * workbench renders the image-to-image bench (source + transform prompt).
 */
export const NANO_BANANA_2_EDIT: EngineDefinition = {
  id: "nano-banana-2-edit",
  provider: "google",
  endpointId: "fal-ai/nano-banana-2/edit",
  label: "Nano Banana 2 (edit / image-to-image)",
  description:
    "Google Gemini 3.1 Flash Image edit. Native-identity selfie stylization — recommended PuLID replacement.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 81,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: ["0.5K", "1K", "2K", "4K"],
  defaultResolution: "1K",
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  paramSchema: {
    params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      // stringArray wraps the single referenceImageUrl into [url]; an array
      // passes through unchanged (the endpoint accepts up to 14 references).
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
          "auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1",
          "4:5", "3:4", "2:3", "9:16", "4:1", "1:4", "8:1", "1:8",
        ],
        default: "9:16",
      },
      {
        name: "resolution",
        from: "resolution",
        type: "string",
        enum: ["0.5K", "1K", "2K", "4K"],
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
        enum: ["jpeg", "png", "webp"],
        default: "png",
      },
      {
        name: "safety_tolerance",
        from: "safetyTolerance",
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6"],
        default: "5",
      },
      {
        name: "limit_generations",
        from: "limitGenerations",
        type: "boolean",
        default: true,
      },
      {
        name: "enable_web_search",
        from: "enableWebSearch",
        type: "boolean",
        default: false,
      },
      {
        name: "thinking_level",
        from: "thinkingLevel",
        type: "string",
        enum: ["minimal", "high"],
      },
      { name: "seed", from: "seed", type: "int" },
    ],
  },

  expectedRunMs: 6000,
  estimatedCostUsdPerCall: 0.08,
  estimatedCostUsdPerSecond: null,
};
