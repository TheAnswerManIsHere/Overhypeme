import type { EngineDefinition, PriceModel, SizeVocabulary } from "./types";

/**
 * GPT Image 2.5 Sunburst (OpenAI), via fal — a launch Phase 8 candidate
 * (plan PLAN_PHASE8_ENGINE_EVALUATION.md; David's D2, 2026-11-06: 2.5 Sunburst
 * is the GPT candidate). Schemas read from fal's pages on 2026-11-06:
 * https://fal.ai/models/openai/gpt-image-2.5/sunburst/text-to-image and
 * .../sunburst/edit.
 *
 * Size is a pixel object (`image_size: {width, height}`; both dimensions
 * multiples of 16, total pixels 655,360 to 8,294,400, aspect at most 3:1), so
 * the vocabulary is per aspect. There is no aspect, seed or reasoning
 * parameter. `quality` stays "high", the plan's priced setting.
 */

/** ~1 MP and ~4 MP per aspect, every dimension a multiple of 16. */
export const GPT_IMAGE_2_5_SIZES: SizeVocabulary = {
  options: [
    { params: { imageSize: "1024x1024" }, megapixels: 1.05, aspect: "square" },
    { params: { imageSize: "2048x2048" }, megapixels: 4.19, aspect: "square" },
    { params: { imageSize: "768x1360" }, megapixels: 1.04, aspect: "portrait" },
    { params: { imageSize: "1536x2720" }, megapixels: 4.18, aspect: "portrait" },
    { params: { imageSize: "1360x768" }, megapixels: 1.04, aspect: "landscape" },
    { params: { imageSize: "2720x1536" }, megapixels: 4.18, aspect: "landscape" },
  ],
};

const PRICE_SOURCE = {
  source:
    "https://fal.ai/models/openai/gpt-image-2.5/sunburst/text-to-image (rates); OpenAI image generation guide's cost calculator (1,756 output tokens at 1024x1024 high)",
  readOn: "2026-11-06",
};

/** Text output is not billed on this model (fal and OpenAI both say so). */
const T2I_COMPONENTS = [
  { name: "image output", usdPerMillionTokens: 30, maxTokens: 1756, ceilingBasis: "vendor constant at 1024x1024, quality high (OpenAI calculator)" },
  { name: "prompt (text input)", usdPerMillionTokens: 5, maxTokens: 4000, ceilingBasis: "compiled prompt bounded at 4,000 tokens" },
];

export const GPT_IMAGE_2_5_PRICE: PriceModel = { kind: "tokens", components: T2I_COMPONENTS, ...PRICE_SOURCE };

/**
 * The reference image is the one component OpenAI publishes no rule for on
 * the GPT Image models: fal bills about $0.008 for a reference resized to at
 * most 1024 on the long edge (measured), and the reservation is twice that.
 * A padded measurement, not a documented maximum (D2, accepted by David).
 */
export const GPT_IMAGE_2_5_EDIT_PRICE: PriceModel = {
  kind: "tokens",
  components: [
    ...T2I_COMPONENTS,
    { name: "reference image (image input)", usdPerMillionTokens: 8, maxTokens: 2000, ceilingBasis: "twice fal's measured charge for a reference resized to 1024 on the long edge", measured: true },
  ],
  ...PRICE_SOURCE,
};

const SHARED_PARAMS = [
  { name: "prompt", from: "imagePrompt", type: "string" as const, required: true },
  { name: "image_size", from: "imageSize", type: "dimensions" as const },
  { name: "quality", from: "quality", type: "string" as const, enum: ["auto", "low", "medium", "high", "xhigh", "max"], default: "high" },
  { name: "output_format", from: "outputFormat", type: "string" as const, enum: ["jpeg", "png", "webp"], default: "png" },
  { name: "num_images", from: "numImages", type: "int" as const, default: 1, range: { min: 1, max: 10, policy: "clamp" as const } },
];

export const GPT_IMAGE_2_5: EngineDefinition = {
  id: "gpt-image-2-5",
  provider: "openai",
  endpointId: "openai/gpt-image-2.5/sunburst/text-to-image",
  label: "GPT Image 2.5 Sunburst (text-to-image)",
  description: "OpenAI GPT Image 2.5 Sunburst via fal. Leads the public boards for text-to-image (Phase 8 candidate).",
  kind: "image",
  imageMode: "t2i",
  family: "gpt-image-2-5",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 60,
  featureFlagRequired: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  paramSchema: { params: SHARED_PARAMS },
  sizeVocabulary: GPT_IMAGE_2_5_SIZES,
  priceModel: GPT_IMAGE_2_5_PRICE,
  expectedRunMs: 60000,
  estimatedCostUsdPerCall: 0.053,
};

export const GPT_IMAGE_2_5_EDIT: EngineDefinition = {
  ...GPT_IMAGE_2_5,
  id: "gpt-image-2-5-edit",
  endpointId: "openai/gpt-image-2.5/sunburst/edit",
  label: "GPT Image 2.5 Sunburst (edit)",
  description: "OpenAI GPT Image 2.5 Sunburst edit via fal: reference-photo editing (Phase 8 candidate).",
  imageMode: "i2i",
  sortOrder: 61,
  paramSchema: {
    params: [
      ...SHARED_PARAMS,
      // An array of up to 16 references; one is sent.
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ],
  },
  priceModel: GPT_IMAGE_2_5_EDIT_PRICE,
  estimatedCostUsdPerCall: 0.061,
};
