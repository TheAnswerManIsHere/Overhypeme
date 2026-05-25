import type { EngineDefinition } from "./types";

/**
 * Nano Banana 2 (Google Gemini 3.1 Flash Image) — text-to-image.
 * Schema verified against fal's docs for `fal-ai/nano-banana-2`.
 *
 * Multimodal foundation model: identity/text/composition share one pathway
 * (no PuLID-style adapter conflict), which is why it's the recommended new
 * default for prompt-only generation (fact scene backgrounds + the no-face
 * fallback). Fast + cheap-ish ($0.08/image at 1K).
 *
 * Distinguishing trait: NO source image param → text-to-image bench. The edit
 * sibling (`nano-banana-2-edit`) adds `image_urls` and is image-to-image.
 */
export const NANO_BANANA_2: EngineDefinition = {
  id: "nano-banana-2",
  provider: "google",
  endpointId: "fal-ai/nano-banana-2",
  label: "Nano Banana 2 (text-to-image)",
  description:
    "Google Gemini 3.1 Flash Image. Fast, semantic-aware text-to-image — recommended default for prompt-only scene generation.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 80,
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
      // String "1" (strictest) - "6" (most permissive). fal default is "4";
      // raised to "5" because meme prompts on real likenesses tend to trip
      // the filter at "4".
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
      // Optional model "thinking"; omitted entirely when unset (fal disables it).
      {
        name: "thinking_level",
        from: "thinkingLevel",
        type: "string",
        enum: ["minimal", "high"],
      },
      // Omitted when blank — fal generates a random seed.
      { name: "seed", from: "seed", type: "int" },
    ],
  },

  expectedRunMs: 5000,
  // ~$0.08/image at 1K; 1.5x at 2K, 2x at 4K.
  estimatedCostUsdPerCall: 0.08,
  estimatedCostUsdPerSecond: null,
};
