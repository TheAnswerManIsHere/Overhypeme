import type { EngineDefinition, PriceModel, SizeVocabulary } from "./types";

/**
 * Meta Muse Image, via fal — a launch Phase 8 candidate. Schemas read from
 * fal's pages on 2026-11-06: https://fal.ai/models/meta/muse-image/text-to-image
 * and .../edit. There is no size parameter: "Only the ratio is used: Muse
 * renders it at its own fixed resolution of roughly 2.5 megapixels", so the
 * vocabulary has one option, and every purpose gets it. The aspect is a
 * free-form "w:h" string. No seed, safety or quality parameter.
 */

export const MUSE_IMAGE_SIZES: SizeVocabulary = {
  options: [{ params: {}, megapixels: 2.5 }],
};

export const MUSE_IMAGE_PRICE: PriceModel = {
  kind: "flat",
  usdPerImage: 0.01,
  source: "https://fal.ai/models/meta/muse-image/text-to-image (\"$0.01 per images\")",
  readOn: "2026-11-06",
};

const SHARED_PARAMS = [
  { name: "prompt", from: "imagePrompt", type: "string" as const, required: true },
  { name: "aspect_ratio", from: "aspectRatio", type: "string" as const, map: { landscape: "16:9", square: "1:1", portrait: "9:16" } },
  { name: "num_images", from: "numImages", type: "int" as const, default: 1, range: { min: 1, max: 10, policy: "clamp" as const } },
  { name: "output_format", from: "outputFormat", type: "string" as const, enum: ["jpeg", "png", "webp"], default: "png" },
];

export const MUSE_IMAGE: EngineDefinition = {
  id: "muse-image",
  provider: "meta",
  endpointId: "meta/muse-image/text-to-image",
  label: "Meta Muse Image (text-to-image)",
  description: "Meta Muse Image via fal: a fixed ~2.5 MP output at $0.01 (Phase 8 candidate).",
  kind: "image",
  imageMode: "t2i",
  family: "muse-image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 68,
  featureFlagRequired: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  paramSchema: { params: SHARED_PARAMS },
  sizeVocabulary: MUSE_IMAGE_SIZES,
  priceModel: MUSE_IMAGE_PRICE,
  expectedRunMs: 15000,
  estimatedCostUsdPerCall: 0.01,
};

export const MUSE_IMAGE_EDIT: EngineDefinition = {
  ...MUSE_IMAGE,
  id: "muse-image-edit",
  endpointId: "meta/muse-image/edit",
  label: "Meta Muse Image (edit)",
  description: "Meta Muse Image edit via fal: between 1 and 10 references (Phase 8 candidate).",
  imageMode: "i2i",
  sortOrder: 69,
  paramSchema: {
    params: [
      ...SHARED_PARAMS,
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ],
  },
};
