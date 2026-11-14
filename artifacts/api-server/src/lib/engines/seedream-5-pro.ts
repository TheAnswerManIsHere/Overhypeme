import type { EngineDefinition, PriceModel, SizeVocabulary } from "./types";

/**
 * Seedream 5.0 Pro (ByteDance), via fal — a launch Phase 8 candidate.
 * Schemas read from fal's pages on 2026-11-06:
 * https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image and .../edit.
 * Size is a pixel object with total pixels 921,600 to 4,624,220, so the
 * vocabulary is per aspect. No aspect or safety-tolerance parameter.
 *
 * fal marks the price TENTATIVE ("Final pricing is not yet confirmed"):
 * $0.0675 per image up to 1536x1536, $0.135 up to 2048x2048, and on the edit
 * $0.0045 per additional input image. The plan re-reads it before each run.
 */

export const SEEDREAM_5_PRO_SIZES: SizeVocabulary = {
  options: [
    { params: { imageSize: "1024x1024" }, megapixels: 1.05, aspect: "square" },
    { params: { imageSize: "2048x2048" }, megapixels: 4.19, aspect: "square" },
    { params: { imageSize: "768x1344" }, megapixels: 1.03, aspect: "portrait" },
    { params: { imageSize: "1536x2688" }, megapixels: 4.13, aspect: "portrait" },
    { params: { imageSize: "1344x768" }, megapixels: 1.03, aspect: "landscape" },
    { params: { imageSize: "2688x1536" }, megapixels: 4.13, aspect: "landscape" },
  ],
};

const PRICE_SOURCE = {
  source: "https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image (tentative pricing)",
  readOn: "2026-11-06",
};

export const SEEDREAM_5_PRO_PRICE: PriceModel = { kind: "flat", usdPerImage: 0.0675, ...PRICE_SOURCE };

/** The edit's one reference is billed as an additional input. */
export const SEEDREAM_5_PRO_EDIT_PRICE: PriceModel = {
  kind: "flat",
  usdPerImage: 0.072,
  usdPerExtraInput: 0.0045,
  ...PRICE_SOURCE,
};

const SHARED_PARAMS = [
  { name: "prompt", from: "imagePrompt", type: "string" as const, required: true },
  { name: "image_size", from: "imageSize", type: "dimensions" as const },
  { name: "num_images", from: "numImages", type: "int" as const, default: 1, range: { min: 1, max: 6, policy: "clamp" as const } },
  { name: "output_format", from: "outputFormat", type: "string" as const, enum: ["jpeg", "png"], default: "png" },
  { name: "enhance_prompt_mode", from: "enhancePromptMode", type: "string" as const, enum: ["standard", "fast"], default: "standard" },
];

export const SEEDREAM_5_PRO: EngineDefinition = {
  id: "seedream-5-pro",
  provider: "bytedance",
  endpointId: "bytedance/seedream/v5/pro/text-to-image",
  label: "Seedream 5.0 Pro (text-to-image)",
  description: "ByteDance Seedream 5.0 Pro via fal (Phase 8 candidate; price tentative on fal).",
  kind: "image",
  imageMode: "t2i",
  family: "seedream-5-pro",
  tierRequirement: "legendary",
  isActive: true,
  sortOrder: 66,
  featureFlagRequired: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  paramSchema: { params: SHARED_PARAMS },
  sizeVocabulary: SEEDREAM_5_PRO_SIZES,
  priceModel: SEEDREAM_5_PRO_PRICE,
  expectedRunMs: 20000,
  estimatedCostUsdPerCall: 0.0675,
};

export const SEEDREAM_5_PRO_EDIT: EngineDefinition = {
  ...SEEDREAM_5_PRO,
  id: "seedream-5-pro-edit",
  endpointId: "bytedance/seedream/v5/pro/edit",
  label: "Seedream 5.0 Pro (edit)",
  description: "ByteDance Seedream 5.0 Pro edit via fal: up to 10 references (Phase 8 candidate; price tentative).",
  imageMode: "i2i",
  sortOrder: 67,
  paramSchema: {
    params: [
      ...SHARED_PARAMS,
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ],
  },
  priceModel: SEEDREAM_5_PRO_EDIT_PRICE,
  estimatedCostUsdPerCall: 0.072,
};
