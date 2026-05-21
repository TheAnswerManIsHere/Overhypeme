import type { EngineDefinition } from "./types";

/**
 * PuLID (FLUX) — fal-hosted face-matched stylization. Stage 1 of the video
 * pipeline and the entire AI image flow. Not user-selectable in the wizard
 * but visible in the admin engines panel so we can tune EMA / pricing.
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
  isDefault: true,
  isActive: true,
  sortOrder: 100,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,
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
    ],
  },

  expectedRunMs: 18000,
  estimatedCostUsdPerCall: 0.03,
  estimatedCostUsdPerSecond: null,
};
