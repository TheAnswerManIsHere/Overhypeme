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
 * Param shape mirrors what `generateAndStoreImage` sends for the FLUX-1 family
 * (`else` branch): image_size, num_inference_steps, guidance_scale,
 * output_format, plus safety_tolerance (flux-pro / flux-pro/v1.1 only).
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
        default: "square_hd",
      },
      {
        name: "num_inference_steps",
        from: "numInferenceSteps",
        type: "int",
        default: 28,
        range: { min: 1, max: 50, policy: "clamp" },
      },
      {
        name: "guidance_scale",
        from: "guidanceScale",
        type: "float",
        default: 3.5,
        range: { min: 1, max: 20, policy: "clamp" },
      },
      {
        name: "safety_tolerance",
        from: "safetyTolerance",
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6"],
        default: "2",
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
    ],
  },

  expectedRunMs: 12000,
  // FLUX Pro v1.1 is priced per output megapixel; ~$0.04 for a 1MP image.
  estimatedCostUsdPerCall: 0.04,
  estimatedCostUsdPerSecond: null,
};
