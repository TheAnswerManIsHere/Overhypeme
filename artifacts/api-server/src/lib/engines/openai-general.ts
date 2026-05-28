import type { EngineDefinition } from "./types";

/**
 * OpenAI "general intelligence" utility engine.
 *
 * The single configurable LLM the platform routes ALL chat-completion calls
 * through (fact tokenization, duplicate detection, hashtag/pronoun suggestion,
 * comment moderation, scene-prompt generation, video direction, …). See
 * lib/utilityLLM.ts for the dispatch helper.
 *
 * Unlike the fal media engines, this engine is not called through the fal
 * interpreter — `endpointId` is the OpenAI chat model, and the admin can edit
 * it (plus the sampling defaults) from /admin/engines. Call sites may override
 * temperature / max tokens / response format per request.
 */
export const OPENAI_GENERAL: EngineDefinition = {
  id: "openai-general",
  provider: "openai",
  endpointId: "gpt-4o-mini",
  label: "OpenAI — General Intelligence",
  description:
    "The shared LLM used for all text/JSON helper calls: fact tokenization, duplicate checks, hashtag + pronoun suggestions, comment moderation, scene prompts, and video direction.",
  kind: "llm",
  tierRequirement: "legendary",
  isDefault: true,
  isActive: true,
  sortOrder: 0,
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
  // Not consumed for OpenAI engines (no fal interpreter), but the column is
  // NOT NULL — provide an empty schema.
  paramSchema: { params: [] },

  expectedRunMs: 4000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: null,

  defaultTemperature: 0.7,
  defaultMaxTokens: 512,
  defaultReasoningEffort: "low",
};
