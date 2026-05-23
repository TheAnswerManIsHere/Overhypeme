import type { EngineDefinition } from "./types";

/**
 * PuLID (FLUX) — fal-hosted face-matched stylization. Stage 1 of the video
 * pipeline and the entire AI image flow.
 *
 * Schema verified against fal's live docs for `fal-ai/flux-pulid` (May 2026).
 *
 * Notable contracts:
 *   - `image_size` controls output dimensions. fal default is `landscape_4_3`
 *     which mismatches our short-form video pipeline. We map the wizard's
 *     aspectRatio onto an appropriate fal preset so the Stage-1 still matches
 *     the eventual Stage-2 video frame (landscape→landscape_16_9,
 *     portrait→portrait_16_9, square→square_hd).
 *   - `id_weight` is the face-likeness knob. Higher (1.0-1.2) locks identity
 *     more tightly; lower (0.6-0.9) gives the model more stylistic latitude.
 *   - `num_inference_steps` default 20 in fal docs; we raise to 28 for
 *     better quality (still fast enough for the 18s expectedRunMs).
 *   - `true_cfg` defaults to 1 which effectively disables negative-prompt
 *     enforcement. We keep that default; raise it via the test workbench
 *     if a negative_prompt needs to actually bite.
 *   - `enable_safety_checker` defaults true. When the checker fires, fal
 *     returns a censored image rather than an error; check
 *     `has_nsfw_concepts[0]` on the response.
 *
 * Pricing: $0.0333/megapixel (rounded up to the nearest MP).
 */
export const PULID_FLUX: EngineDefinition = {
  id: "pulid-flux",
  provider: "fal",
  endpointId: "fal-ai/flux-pulid",
  label: "PuLID (FLUX)",
  description:
    "Face-matched stylization. Internal utility, not user-selectable.",
  kind: "image",
  tierRequirement: "legendary",
  // Demoted to fallback as of May 2026. Nano Banana Pro is the new default
  // image-kind engine in the catalogue (see nano-banana-pro.ts). PuLID
  // stays active so the workbench can A/B test the two, and so the
  // hardcoded Stage-1 helper (aiMemePipeline.generateAiMemeBackgroundFromReference)
  // continues to work until the runtime Stage-1 refactor lands.
  isDefault: false,
  isActive: true,
  sortOrder: 100,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  // The wizard's notion of resolution doesn't apply here — PuLID speaks in
  // image_size presets. Kept null; the paramSchema's `image_size` entry is
  // the source of truth.
  allowedResolutions: null,
  defaultResolution: null,
  // PuLID's aspect choices via image_size presets. We surface the wizard's
  // generic aspect labels (landscape/square/portrait) and map at the
  // interpreter layer.
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  paramSchema: {
    params: [
      {
        name: "reference_image_url",
        from: "referenceImageUrl",
        type: "string",
        required: true,
      },
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      // Match Stage-2 video frame: landscape video → landscape image, etc.
      // Default portrait_16_9 since most short-form output is vertical.
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
        default: "portrait_16_9",
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
        default: 4,
        range: { min: 0, max: 20, policy: "clamp" },
      },
      {
        name: "id_weight",
        from: "idWeight",
        type: "float",
        default: 1,
        range: { min: 0, max: 2, policy: "clamp" },
      },
      {
        name: "true_cfg",
        from: "trueCfg",
        type: "float",
        default: 1,
        range: { min: 1, max: 10, policy: "clamp" },
      },
      {
        name: "negative_prompt",
        from: "negativePrompt",
        type: "string",
        includeWhen: { field: "negativePrompt", present: true },
      },
      {
        name: "enable_safety_checker",
        from: "enableSafetyChecker",
        type: "boolean",
        default: true,
      },
      {
        name: "seed",
        from: "seed",
        type: "int",
        includeWhen: { field: "seed", present: true },
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

  expectedRunMs: 18000,
  estimatedCostUsdPerCall: 0.03,
  estimatedCostUsdPerSecond: null,
};
