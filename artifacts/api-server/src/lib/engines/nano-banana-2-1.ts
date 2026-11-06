import type { EngineDefinition, PriceModel, SizeVocabulary } from "./types";

/**
 * Nano Banana 2.1 (Google), via fal — a launch Phase 8 candidate. Schemas
 * read from fal's pages on 2026-11-06: https://fal.ai/models/google/nano-banana-2.1
 * and .../edit. Like Nano Banana 2 but token-priced, with no 0.5K size: its
 * smallest size, and so its preview size, is 1K.
 *
 * `thinking_level` is sent as "medium", the engine's documented default
 * (ledger C7). `safety_tolerance` keeps the product's "5", as its sibling does
 * (meme prompts on real likenesses trip fal's default "4").
 */

export const NANO_BANANA_2_1_SIZES: SizeVocabulary = {
  options: [
    { params: { resolution: "1K" }, megapixels: 1 },
    { params: { resolution: "2K" }, megapixels: 4 },
    { params: { resolution: "4K" }, megapixels: 16 },
  ],
};

/**
 * Rates from fal; ceilings from Google's model page for gemini-nano-banana-2.1:
 * 1,120 tokens per input image, 1,120 output tokens per 1K image, and at most
 * 32,768 output tokens, so thinking and text are bounded by the output limit
 * less the image.
 */
export const NANO_BANANA_2_1_PRICE: PriceModel = {
  kind: "tokens",
  components: [
    { name: "image output", usdPerMillionTokens: 35.294, maxTokens: 1120, ceilingBasis: "Google: 1,120 output tokens per 1K image" },
    { name: "thinking and text output", usdPerMillionTokens: 8.823, maxTokens: 31648, ceilingBasis: "Google: 32,768 output-token maximum, less the image" },
    { name: "prompt (text input)", usdPerMillionTokens: 1.764, maxTokens: 4000, ceilingBasis: "compiled prompt bounded at 4,000 tokens" },
    { name: "reference image (input)", usdPerMillionTokens: 1.764, maxTokens: 1120, ceilingBasis: "Google: 1,120 tokens per input image" },
  ],
  source: "https://fal.ai/models/google/nano-banana-2.1 (rates); Google's model page for gemini-nano-banana-2.1 (token ceilings)",
  readOn: "2026-11-06",
};

const SHARED_PARAMS = [
  { name: "prompt", from: "imagePrompt", type: "string" as const, required: true },
  {
    name: "aspect_ratio", from: "aspectRatio", type: "string" as const,
    map: { landscape: "16:9", square: "1:1", portrait: "9:16" },
    enum: ["auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16", "4:1", "1:4", "8:1", "1:8"],
    default: "9:16",
  },
  { name: "resolution", from: "resolution", type: "string" as const, enum: ["1K", "2K", "4K"], default: "1K" },
  { name: "thinking_level", from: "thinkingLevel", type: "string" as const, enum: ["minimal", "medium", "high"], default: "medium" },
  { name: "num_images", from: "numImages", type: "int" as const, default: 1, range: { min: 1, max: 4, policy: "clamp" as const } },
  { name: "output_format", from: "outputFormat", type: "string" as const, enum: ["jpeg", "png", "webp"], default: "png" },
  { name: "safety_tolerance", from: "safetyTolerance", type: "string" as const, enum: ["1", "2", "3", "4", "5", "6"], default: "5" },
  { name: "limit_generations", from: "limitGenerations", type: "boolean" as const, default: true },
  { name: "enable_web_search", from: "enableWebSearch", type: "boolean" as const, default: false },
  { name: "seed", from: "seed", type: "int" as const },
];

export const NANO_BANANA_2_1: EngineDefinition = {
  id: "nano-banana-2-1",
  provider: "google",
  endpointId: "google/nano-banana-2.1",
  label: "Nano Banana 2.1 (text-to-image)",
  description: "Google Nano Banana 2.1 via fal: Nano Banana 2's successor, token-priced (Phase 8 candidate).",
  kind: "image",
  imageMode: "t2i",
  family: "nano-banana-2-1",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 62,
  featureFlagRequired: null,
  allowedResolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K",
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  paramSchema: { params: SHARED_PARAMS },
  sizeVocabulary: NANO_BANANA_2_1_SIZES,
  priceModel: NANO_BANANA_2_1_PRICE,
  expectedRunMs: 8000,
  estimatedCostUsdPerCall: 0.04,
};

export const NANO_BANANA_2_1_EDIT: EngineDefinition = {
  ...NANO_BANANA_2_1,
  id: "nano-banana-2-1-edit",
  endpointId: "google/nano-banana-2.1/edit",
  label: "Nano Banana 2.1 (edit)",
  description: "Google Nano Banana 2.1 edit via fal: reference-photo editing (Phase 8 candidate).",
  imageMode: "i2i",
  sortOrder: 63,
  paramSchema: {
    params: [
      ...SHARED_PARAMS,
      // Optional on fal (a video or PDF can stand in); our edit always sends one.
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ],
  },
};
