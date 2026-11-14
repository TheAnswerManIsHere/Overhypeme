import type { EngineDefinition } from "./types";

/**
 * OpenAI visual-planner engine — the dedicated frontier LLM for render-time
 * visual gag planning (image-prompt generation).
 *
 * Selected per-purpose by `DEFAULT_IMAGE_PROMPT_ENGINE_ID` in
 * lib/imagePromptConfig.ts, set in code, NOT by being the utility engine.
 *
 * Like openai-general, this is not called through the fal interpreter —
 * `endpointId` is the OpenAI model, set here (decisions.md 2026-11-14: AI call settings live in code).
 */
export const OPENAI_VISUAL_PLANNER: EngineDefinition = {
  id: "openai-visual-planner",
  provider: "openai",
  endpointId: "gpt-5.5",
  label: "OpenAI — Visual Planner",
  description:
    "Dedicated LLM for render-time visual gag planning. Chosen in code; not eligible as the global default LLM.",
  kind: "llm",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 1,
  featureFlagRequired: null,

  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,

  // Not consumed for OpenAI engines (no fal interpreter), but the column is
  // NOT NULL — provide an empty schema.
  paramSchema: { params: [] },

  expectedRunMs: 90000,
  estimatedCostUsdPerCall: null,

  // Temperature is dropped for reasoning models by chatModelTuningParams;
  // it applies only if an admin points the row at a 4.x chat model.
  // No temperature: at this reasoning effort the model accepts none, so none
  // is sent (openaiChatParams.ts; OpenAI's GPT-6 guide: "When reasoning effort
  // is not none, remove temperature"). Parameter audit, 2026-11-14.
  defaultTemperature: null,
  defaultMaxTokens: 2800,
  defaultReasoningEffort: "high",
};
