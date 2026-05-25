import type { EngineDefinition } from "./types";

/**
 * FLUX Pro v1.1 — text-to-image. This is the model the legacy pipeline
 * (`aiMemePipeline.generateAndStoreImage`) has been calling all along for
 * prompt-only generation (scene backgrounds + the no-face standalone
 * fallback), but it was never represented in the engine catalogue. Cataloguing
 * it gives the workbench a text-to-image bench and a single source of truth.
 *
 * Distinguishing trait: NO reference/source image param. The workbench keys
 * off that to render the text-to-image bench (prompt only) rather than the
 * image-to-image bench (source image + transform prompt).
 *
 * Param shape verified against fal's docs for `fal-ai/flux-pro/v1.1`
 * (text-to-image). NOTE: the base v1.1 endpoint does NOT accept
 * `num_inference_steps` / `guidance_scale` — those belong to the `/redux`
 * sub-endpoint. The legacy pipeline's generic FLUX-1 branch sent them anyway;
 * fal ignores them here. The real knobs are below.
 */
export const FLUX_PRO_V1_1: EngineDefinition = {
  id: "flux-pro-v1-1",
  provider: "fal",
  endpointId: "fal-ai/flux-pro/v1.1",
  label: "FLUX Pro v1.1 (text-to-image)",
  description:
    "Text-to-image. Current production model for prompt-only scene generation and the no-face fallback.",
  kind: "image",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 70,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "square",
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
        ],
        default: "square_hd",
      },
      {
        name: "safety_tolerance",
        from: "safetyTolerance",
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6"],
        default: "2",
      },
      {
        name: "enhance_prompt",
        from: "enhancePrompt",
        type: "boolean",
        default: false,
      },
      {
        name: "output_format",
        from: "outputFormat",
        type: "string",
        enum: ["jpeg", "png"],
        default: "jpeg",
      },
      {
        name: "num_images",
        from: "numImages",
        type: "int",
        default: 1,
        range: { min: 1, max: 4, policy: "clamp" },
      },
      // Omitted when blank — fal generates a random seed.
      { name: "seed", from: "seed", type: "int" },
    ],
  },

  expectedRunMs: 12000,
  // FLUX Pro v1.1 is priced per output megapixel; ~$0.04 for a 1MP image.
  estimatedCostUsdPerCall: 0.04,
  estimatedCostUsdPerSecond: null,
};
