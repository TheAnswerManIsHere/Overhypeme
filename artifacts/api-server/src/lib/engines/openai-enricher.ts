import type { EngineDefinition } from "./types";

/**
 * OpenAI fact-enricher engine — the dedicated frontier LLM for fact enrichment
 * / taxonomy classification (the step that assigns archetype, subtype,
 * modifiers, cultural references, and semantic entities).
 *
 * Selected per-purpose by `DEFAULT_FACT_ENRICHMENT_ENGINE_ID` in
 * lib/factEnrichmentConfig.ts, set in code, NOT by being the utility engine.
 *
 * Like openai-general, this is not called through the fal interpreter —
 * `endpointId` is the OpenAI model, set here (decisions.md 2026-11-14: AI call settings live in code). The
 * token limit mirrors the enrichment constant (600 output tokens).
 */
export const OPENAI_ENRICHER: EngineDefinition = {
  id: "openai-enricher",
  provider: "openai",
  endpointId: "gpt-5.5",
  label: "OpenAI — Fact Enricher",
  description:
    "Dedicated LLM for fact enrichment / taxonomy classification. Chosen in code; not eligible as the global default LLM.",
  kind: "llm",
  tierRequirement: "legendary",
  isActive: true,
  sortOrder: 2,
  featureFlagRequired: null,

  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,

  // Not consumed for OpenAI engines (no fal interpreter), but the column is
  // NOT NULL — provide an empty schema.
  paramSchema: { params: [] },

  expectedRunMs: 60000,
  estimatedCostUsdPerCall: null,

  // Mirror the enrichment sampling constants. Temperature is dropped for
  // reasoning models by chatModelTuningParams; it applies only if an admin
  // points the row at a 4.x chat model.
  // No temperature: at this reasoning effort the model accepts none, so none
  // is sent (openaiChatParams.ts; OpenAI's GPT-6 guide: "When reasoning effort
  // is not none, remove temperature"). Parameter audit, 2026-11-14.
  defaultTemperature: null,
  defaultMaxTokens: 600,
  defaultReasoningEffort: "high",
};
