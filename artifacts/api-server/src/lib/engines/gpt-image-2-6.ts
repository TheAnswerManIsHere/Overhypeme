import type { EngineDefinition, PriceModel, TokenPriceComponent } from "./types";
import { GPT_IMAGE_2_5_SIZES } from "./gpt-image-2-5";

/**
 * GPT Image 2.6 Sunburst (OpenAI), via fal — the GPT candidate in the launch
 * Phase 8 engine comparison, in place of 2.5 (David, 2026-11-10: "2.6"; the
 * plan's rule "GPT Image 2.6 replaces 2.5 if its fal price settles before the
 * runs"). Schemas read through fal's catalogue on 2026-11-10:
 * openai/gpt-image-2.6/sunburst/text-to-image and .../sunburst/edit.
 *
 * The inputs are 2.5's (a pixel `image_size` object, `quality`), plus
 * `reasoning_effort` (low / medium / high; fal's default is high). It is sent
 * as "high", fal's default, so every engine is judged as its vendor ships it
 * (David, 2026-11-10: "High."). The size limits are 2.5's, so the size
 * vocabulary is shared.
 */

const PRICE_SOURCE = {
  source:
    "https://fal.ai/gpt-image-2.6 (rates: image $8/M in and $30/M out, text $5/M in and $10/M out; launch measurement of about $0.053 for a 1024x1024 image at high quality and low reasoning)",
  readOn: "2026-11-10",
};

/**
 * Reasoning tokens bill as text output. No ceiling is published (fal:
 * "Higher reasoning effort spends more tokens, so it costs more"), so this
 * component is an allowance, not a documented maximum. Pricing gates no
 * comparison run (David, 2026-11-07), so the bound is a record only.
 */
const T2I_COMPONENTS: TokenPriceComponent[] = [
  { name: "image output", usdPerMillionTokens: 30, maxTokens: 1756, ceilingBasis: "vendor constant at 1024x1024, quality high (as 2.5; the launch measurement matches it)" },
  { name: "reasoning (text output)", usdPerMillionTokens: 10, maxTokens: 4000, ceilingBasis: "no published ceiling: an allowance, not a documented maximum (high reasoning may exceed it)" },
  { name: "prompt (text input)", usdPerMillionTokens: 5, maxTokens: 4000, ceilingBasis: "compiled prompt bounded at 4,000 tokens" },
];

/**
 * Typical: fal's launch quote of about $0.053 (for the sister variant, Flare,
 * at low reasoning) plus a compiled prompt of about 1,000 tokens. At high
 * reasoning this is a floor: read fal's bill for round 1's GPT pictures.
 */
export const GPT_IMAGE_2_6_PRICE: PriceModel = {
  kind: "tokens",
  components: T2I_COMPONENTS,
  typicalUsdPerImage: 0.058,
  typicalBasis: "a floor: fal's launch quote of about $0.053 for Flare at 1024x1024, high quality, low reasoning, plus a compiled prompt of about 1,000 tokens; high reasoning bills more",
  ...PRICE_SOURCE,
};

/** The reference image as on 2.5: fal's measured $0.008 for a 1024-edge reference, reserved at twice that. */
export const GPT_IMAGE_2_6_EDIT_PRICE: PriceModel = {
  kind: "tokens",
  components: [
    ...T2I_COMPONENTS,
    { name: "reference image (image input)", usdPerMillionTokens: 8, maxTokens: 2000, ceilingBasis: "twice fal's measured charge on 2.5 for a reference resized to 1024 on the long edge", measured: true },
  ],
  typicalUsdPerImage: 0.066,
  typicalBasis: "the text-to-image figure plus the $0.008 measured on 2.5 for a reference resized to 1024 on the long edge",
  ...PRICE_SOURCE,
};

const SHARED_PARAMS = [
  { name: "prompt", from: "imagePrompt", type: "string" as const, required: true },
  { name: "image_size", from: "imageSize", type: "dimensions" as const },
  { name: "quality", from: "quality", type: "string" as const, enum: ["auto", "low", "medium", "high", "xhigh", "max"], default: "high" },
  { name: "reasoning_effort", from: "reasoningEffort", type: "string" as const, enum: ["low", "medium", "high"], default: "high" },
  { name: "output_format", from: "outputFormat", type: "string" as const, enum: ["jpeg", "png", "webp"], default: "png" },
  { name: "num_images", from: "numImages", type: "int" as const, default: 1, range: { min: 1, max: 10, policy: "clamp" as const } },
];

export const GPT_IMAGE_2_6: EngineDefinition = {
  id: "gpt-image-2-6",
  provider: "openai",
  endpointId: "openai/gpt-image-2.6/sunburst/text-to-image",
  label: "GPT Image 2.6 Sunburst (text-to-image)",
  description: "OpenAI GPT Image 2.6 Sunburst via fal, at high reasoning (Phase 8 candidate, in place of 2.5).",
  kind: "image",
  imageMode: "t2i",
  family: "gpt-image-2-6",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 62,
  featureFlagRequired: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  paramSchema: { params: SHARED_PARAMS },
  sizeVocabulary: GPT_IMAGE_2_5_SIZES,
  priceModel: GPT_IMAGE_2_6_PRICE,
  expectedRunMs: 60000,
  estimatedCostUsdPerCall: 0.058,
};

export const GPT_IMAGE_2_6_EDIT: EngineDefinition = {
  ...GPT_IMAGE_2_6,
  id: "gpt-image-2-6-edit",
  endpointId: "openai/gpt-image-2.6/sunburst/edit",
  label: "GPT Image 2.6 Sunburst (edit)",
  description: "OpenAI GPT Image 2.6 Sunburst edit via fal, at high reasoning: reference-photo editing (Phase 8 candidate, in place of 2.5).",
  imageMode: "i2i",
  sortOrder: 63,
  paramSchema: {
    params: [
      ...SHARED_PARAMS,
      // An array of up to 16 references; one is sent.
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ],
  },
  priceModel: GPT_IMAGE_2_6_EDIT_PRICE,
  estimatedCostUsdPerCall: 0.066,
};
