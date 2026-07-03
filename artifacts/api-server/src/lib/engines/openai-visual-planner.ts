import type { EngineDefinition } from "./types";

/**
 * OpenAI visual-planner engine — the dedicated frontier LLM for render-time
 * visual gag planning (image-prompt generation).
 *
 * Selected per-purpose via the `fact_image_prompt_engine_id` admin_config key
 * (see lib/imagePromptConfig.ts), NOT by being the default `llm` engine.
 * `eligibleAsKindDefault: false` blocks it from ever becoming the global
 * default LLM — routing every utility call through a high-reasoning model
 * would be a silent cost/latency blast radius.
 *
 * Like openai-general, this is not called through the fal interpreter —
 * `endpointId` is the OpenAI model, admin-editable from /admin/engines.
 */
export const OPENAI_VISUAL_PLANNER: EngineDefinition = {
  id: "openai-visual-planner",
  provider: "openai",
  endpointId: "gpt-5.5",
  label: "OpenAI — Visual Planner",
  description:
    "Dedicated LLM for render-time visual gag planning. Selected by fact_image_prompt_engine_id; not eligible as the global default LLM.",
  kind: "llm",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 1,
  featureFlagRequired: null,
  eligibleAsKindDefault: false,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
  // Not consumed for OpenAI engines (no fal interpreter), but the column is
  // NOT NULL — provide an empty schema.
  paramSchema: { params: [] },

  expectedRunMs: 90000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: null,

  // Temperature is dropped for reasoning models by chatModelTuningParams;
  // it applies only if an admin points the row at a 4.x chat model.
  defaultTemperature: 0.4,
  defaultMaxTokens: 2800,
  defaultReasoningEffort: "high",
};
