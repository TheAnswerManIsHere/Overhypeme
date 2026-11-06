import type { EngineDefinition, PriceModel, SizeVocabulary } from "./types";

/**
 * FLUX 3 Image (Black Forest Labs), via fal — a launch Phase 8 candidate.
 * Schemas read from fal's pages on 2026-11-06:
 * https://fal.ai/models/blackforestlabs/flux-3/text-to-image and .../edit-image.
 * One flat price per image at 1K, "whatever the number of references"; the
 * edit takes up to 10 references, each at least 256 px a side. No
 * num_images or seed parameter. `safety_tolerance` (0 strictest to 4) keeps
 * fal's default, 2.
 */

export const FLUX_3_SIZES: SizeVocabulary = {
  options: [
    { params: { resolution: "768sq" }, megapixels: 0.59 },
    { params: { resolution: "1k" }, megapixels: 1 },
    { params: { resolution: "1.5k" }, megapixels: 2.25 },
    { params: { resolution: "2k" }, megapixels: 4 },
    { params: { resolution: "4k" }, megapixels: 16 },
  ],
};

export const FLUX_3_PRICE: PriceModel = {
  kind: "flat",
  usdPerImage: 0.048,
  source: "https://fal.ai/models/blackforestlabs/flux-3/text-to-image (\"A 1K (1 MP) image costs $0.048.\")",
  readOn: "2026-11-06",
};

const SHARED_PARAMS = [
  { name: "prompt", from: "imagePrompt", type: "string" as const, required: true },
  {
    name: "aspect_ratio", from: "aspectRatio", type: "string" as const,
    map: { landscape: "16:9", square: "1:1", portrait: "9:16" },
    enum: ["auto", "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2"],
    default: "9:16",
  },
  { name: "resolution", from: "resolution", type: "string" as const, enum: ["768sq", "1k", "1.5k", "2k", "4k"], default: "1k" },
  { name: "output_format", from: "outputFormat", type: "string" as const, enum: ["jpeg", "png"], default: "png" },
  { name: "safety_tolerance", from: "safetyTolerance", type: "int" as const, default: 2, range: { min: 0, max: 4, policy: "clamp" as const } },
  { name: "enable_prompt_expansion", from: "enablePromptExpansion", type: "boolean" as const, default: false },
];

export const FLUX_3: EngineDefinition = {
  id: "flux-3",
  provider: "fal",
  endpointId: "blackforestlabs/flux-3/text-to-image",
  label: "FLUX 3 Image (text-to-image)",
  description: "Black Forest Labs FLUX 3 via fal: flat price per image (Phase 8 candidate).",
  kind: "image",
  imageMode: "t2i",
  family: "flux-3",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 64,
  featureFlagRequired: null,
  allowedResolutions: ["768sq", "1k", "1.5k", "2k", "4k"],
  defaultResolution: "1k",
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  paramSchema: { params: SHARED_PARAMS },
  sizeVocabulary: FLUX_3_SIZES,
  priceModel: FLUX_3_PRICE,
  expectedRunMs: 15000,
  estimatedCostUsdPerCall: 0.048,
};

export const FLUX_3_EDIT: EngineDefinition = {
  ...FLUX_3,
  id: "flux-3-edit",
  endpointId: "blackforestlabs/flux-3/edit-image",
  label: "FLUX 3 Image (edit)",
  description: "Black Forest Labs FLUX 3 edit via fal: up to 10 references at one flat price (Phase 8 candidate).",
  imageMode: "i2i",
  sortOrder: 65,
  paramSchema: {
    params: [
      ...SHARED_PARAMS,
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ],
  },
};
