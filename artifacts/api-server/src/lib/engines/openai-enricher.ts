import type { EngineDefinition } from "./types";

/**
 * OpenAI fact-enricher engine — the dedicated frontier LLM for fact enrichment
 * / taxonomy classification (the step that assigns archetype, subtype,
 * modifiers, cultural references, and semantic entities).
 *
 * Selected per-purpose via the `fact_enrichment_engine_id` admin_config key
 * (see lib/factEnrichmentConfig.ts), NOT by being the default `llm` engine.
 * `eligibleAsKindDefault: false` blocks it from ever becoming the global
 * default LLM — routing every utility call through a high-reasoning model
 * would be a silent cost/latency blast radius.
 *
 * Like openai-general, this is not called through the fal interpreter —
 * `endpointId` is the OpenAI model, admin-editable from /admin/engines. The
 * sampling defaults mirror the enrichment constants (temp 0.2, 600 output
 * tokens); temperature is dropped for reasoning models by chatModelTuningParams.
 */
export const OPENAI_ENRICHER: EngineDefinition = {
  id: "openai-enricher",
  provider: "openai",
  endpointId: "gpt-5.5",
  label: "OpenAI — Fact Enricher",
  description:
    "Dedicated LLM for fact enrichment / taxonomy classification. Selected by fact_enrichment_engine_id; not eligible as the global default LLM.",
  kind: "llm",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 2,
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

  expectedRunMs: 60000,
  estimatedCostUsdPerCall: null,
  estimatedCostUsdPerSecond: null,

  // Mirror the enrichment sampling constants. Temperature is dropped for
  // reasoning models by chatModelTuningParams; it applies only if an admin
  // points the row at a 4.x chat model.
  defaultTemperature: 0.2,
  defaultMaxTokens: 600,
  defaultReasoningEffort: "high",
};
