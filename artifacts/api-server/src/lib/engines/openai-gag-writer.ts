import type { EngineDefinition } from "./types";

/**
 * OpenAI gag writer: the model that drafts each fact's joke read and three
 * candidate visual gags during moderation prep (plan
 * docs/plans/PLAN_GAG_GENERATOR.md, approved by David 2026-11-13: "Astra 6 as
 * the model that generates the gags in the app"). Selected by the
 * `fact_visual_concepts_engine_id` admin_config key, which migration 0137
 * points here. Its own row, so the render planner (`openai-visual-planner`)
 * is unchanged. There is no fallback to a weaker model (David: "an admin
 * function so doesn't need high availability").
 *
 * Not called through the fal interpreter; `endpointId` is the OpenAI model,
 * admin-editable from /admin/engines.
 */
export const OPENAI_GAG_WRITER: EngineDefinition = {
  id: "openai-gag-writer",
  provider: "openai",
  endpointId: "gpt-6-astra",
  label: "OpenAI — Gag Writer",
  description:
    "Drafts each fact's joke read and three candidate visual gags for moderators. Selected by fact_visual_concepts_engine_id; not eligible as the global default LLM.",
  kind: "llm",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 2,
  featureFlagRequired: null,
  eligibleAsKindDefault: false,

  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,

  paramSchema: { params: [] },

  expectedRunMs: 120000,
  estimatedCostUsdPerCall: null,

  // Temperature is dropped for reasoning models. The answer is three short
  // scenes plus a joke read; reasoning headroom is added on top of this by
  // chatModelTuningParams.
  defaultTemperature: 0.8,
  defaultMaxTokens: 4000,
  defaultReasoningEffort: "high",
};
