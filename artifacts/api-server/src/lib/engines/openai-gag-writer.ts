import type { EngineDefinition } from "./types";

/**
 * OpenAI gag writer: the model that drafts each fact's joke read and three
 * candidate visual gags during moderation prep (plan
 * docs/plans/PLAN_GAG_GENERATOR.md, approved by David 2026-11-13: "Astra 6 as
 * the model that generates the gags in the app"). Selected by
 * `DEFAULT_VISUAL_CONCEPTS_ENGINE_ID`, set in code. Its own row, so the render planner (`openai-visual-planner`)
 * is unchanged. There is no fallback to a weaker model (David: "an admin
 * function so doesn't need high availability").
 *
 * Not called through the fal interpreter; `endpointId` is the OpenAI model,
 * set here (decisions.md 2026-11-14: AI call settings live in code).
 */
export const OPENAI_GAG_WRITER: EngineDefinition = {
  id: "openai-gag-writer",
  provider: "openai",
  endpointId: "gpt-6-astra",
  label: "OpenAI — Gag Writer",
  description:
    "Drafts each fact's joke read and three candidate visual gags for moderators. Chosen in code; not eligible as the global default LLM.",
  kind: "llm",
  tierRequirement: "legendary",
  isDefault: false,
  isActive: true,
  sortOrder: 2,
  featureFlagRequired: null,

  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,

  paramSchema: { params: [] },

  expectedRunMs: 120000,
  estimatedCostUsdPerCall: null,

  // The answer is three short scenes plus a joke read; reasoning headroom is
  // added on top of this by chatModelTuningParams.
  // No temperature: at this reasoning effort the model accepts none, so none
  // is sent (openaiChatParams.ts; OpenAI's GPT-6 guide: "When reasoning effort
  // is not none, remove temperature"). Parameter audit, 2026-11-14.
  defaultTemperature: null,
  defaultMaxTokens: 4000,
  // Medium (David, 2026-11-14, in UAT: high took 100–211 s a call, "WAY too
  // long"). Set here; no engine row's stored copy is read.
  defaultReasoningEffort: "medium",
};
