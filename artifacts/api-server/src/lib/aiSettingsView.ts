/**
 * @purpose The read-only AI settings view: every AI step's engine, model and call parameters, and every system prompt, read from code for the admin AI settings page.
 * @subsystem ai-config
 *
 * David, 2026-11-14: "instead of a configuration page that lets you SET the
 * values, we should have a page that SHOWS the values." Every value here is
 * the code's (decisions.md 2026-11-14, AI call settings live in code); a
 * change is a reviewed code change, so nothing here is writable.
 *
 * An OpenAI step shows what its request actually carries, built by the same
 * `chatModelTuningParams` the calls use, so a temperature the model does not
 * accept reads "not sent" rather than a number that never leaves the server.
 */
import { engineById, type Engine } from "./engineInterpreter";
import { chatModelTuningParams } from "./openaiChatParams";
import { DEFAULT_FACT_ENRICHMENT_ENGINE_ID, FACT_ENRICHMENT_CONFIG_KEYS, getFactEnrichmentSystem } from "./factEnrichmentConfig";
import { DEFAULT_VISUAL_CONCEPTS_ENGINE_ID, VISUAL_CONCEPTS_CONFIG_KEYS, getVisualConceptsSystem } from "./visualConceptsConfig";
import {
  DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID,
  DEFAULT_IMAGE_PROMPT_ENGINE_ID,
  IMAGE_PROMPT_CONFIG_KEYS,
  getFactSourceClassifierSystem,
  getImagePromptSystem,
} from "./imagePromptConfig";
import { SCENE_PROMPT_CONFIG_KEYS, getScenePromptSystem } from "./scenePromptConfig";
import { REFERENCE_RESEARCH_CONFIG_KEYS, getReferenceResearchSystem } from "./referenceResearchConfig";
import { CODE_OWNED_PROMPT_DEFS } from "./codeOwnedPrompts";
import { JUDGEMENT_REASONING_EFFORT, UTILITY_LLM_ENGINE_ID } from "./utilityLLM";
import { TOKENIZER_MODEL, TOKENIZER_REASONING_EFFORT } from "./factTokenizer";
import { IMAGE_ENGINE_IDS } from "./imageEngineRouting";
import { DEFAULT_NSFW_ENDPOINT } from "./moderation/nsfwClassifier";
import { FAL_SAFETY_TOLERANCE } from "./moderation/falSafety";

export interface AiSettingRow {
  /** What the step does, in product English. */
  step: string;
  /** The engine's catalogue label, or null for a step with no engine record. */
  engine: string | null;
  /** The OpenAI model or fal endpoint the request goes to. */
  model: string;
  /** Each request parameter as it is sent: name → shown value. "not sent" where the request omits it. */
  parameters: Array<{ name: string; value: string }>;
  /** The system prompt this step sends, by key, or null. */
  promptKey: string | null;
}

export interface AiSettingsView {
  steps: AiSettingRow[];
  prompts: Array<{ key: string; label: string; description: string; text: string }>;
}

const NOT_SENT = "not sent";

/** What an OpenAI chat request carries for a model, budget, temperature and effort. */
function chatParameters(model: string, maxTokens: number, temperature: number | null, effort: string | null | undefined): AiSettingRow["parameters"] {
  const sent = chatModelTuningParams({ model, maxTokens, temperature: temperature ?? 0, reasoningEffort: effort ?? undefined }) as Record<string, unknown>;
  const show = (v: unknown) => (v === undefined ? NOT_SENT : String(v));
  const tokens = sent["max_completion_tokens"] ?? sent["max_tokens"];
  return [
    { name: "Reasoning effort", value: show(sent["reasoning_effort"]) },
    { name: "Token limit", value: show(tokens) },
    { name: "Temperature", value: show(sent["temperature"]) },
  ];
}

function llmStep(step: string, engineId: string, promptKey: string | null): AiSettingRow {
  const engine = requireEngine(engineId);
  const temperature = engine.defaultTemperature != null ? Number(engine.defaultTemperature) : null;
  return {
    step,
    engine: engine.label,
    model: engine.endpointId,
    parameters: chatParameters(engine.endpointId, engine.defaultMaxTokens ?? 0, temperature, engine.defaultReasoningEffort),
    promptKey,
  };
}

function imageStep(step: string, engineId: string): AiSettingRow {
  const engine = requireEngine(engineId);
  return {
    step,
    engine: engine.label,
    model: engine.endpointId,
    parameters: [
      { name: "Default resolution", value: engine.defaultResolution ?? NOT_SENT },
      { name: "Default aspect ratio", value: engine.defaultAspectRatio ?? NOT_SENT },
    ],
    promptKey: null,
  };
}

function requireEngine(id: string): Engine {
  const engine = engineById(id);
  if (!engine) throw new Error(`AI settings view: engine "${id}" is not in the catalogue`);
  return engine;
}

const PROMPT_TEXT: Record<string, () => Promise<string>> = {
  [FACT_ENRICHMENT_CONFIG_KEYS.system]: getFactEnrichmentSystem,
  [VISUAL_CONCEPTS_CONFIG_KEYS.system]: getVisualConceptsSystem,
  [IMAGE_PROMPT_CONFIG_KEYS.imagePromptSystem]: getImagePromptSystem,
  [IMAGE_PROMPT_CONFIG_KEYS.sourceClassifierSystem]: getFactSourceClassifierSystem,
  [SCENE_PROMPT_CONFIG_KEYS.system]: getScenePromptSystem,
  [REFERENCE_RESEARCH_CONFIG_KEYS.system]: getReferenceResearchSystem,
};

export async function aiSettingsView(): Promise<AiSettingsView> {
  const utility = requireEngine(UTILITY_LLM_ENGINE_ID);
  const utilityTemperature = utility.defaultTemperature != null ? Number(utility.defaultTemperature) : null;
  const steps: AiSettingRow[] = [
    llmStep("Fact classification (enrichment)", DEFAULT_FACT_ENRICHMENT_ENGINE_ID, FACT_ENRICHMENT_CONFIG_KEYS.system),
    llmStep("Gag writer (visual gags and joke read)", DEFAULT_VISUAL_CONCEPTS_ENGINE_ID, VISUAL_CONCEPTS_CONFIG_KEYS.system),
    llmStep("Picture planner (image prompt)", DEFAULT_IMAGE_PROMPT_ENGINE_ID, IMAGE_PROMPT_CONFIG_KEYS.imagePromptSystem),
    imageStep("Picture engine: text to image", IMAGE_ENGINE_IDS.t2i),
    imageStep("Picture engine: from a reference photo", IMAGE_ENGINE_IDS.i2i),
    {
      step: "Source-photo detector",
      engine: requireEngine(DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID).label,
      model: requireEngine(DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID).endpointId,
      parameters: [],
      promptKey: IMAGE_PROMPT_CONFIG_KEYS.sourceClassifierSystem,
    },
    {
      step: "NSFW check on every image",
      engine: null,
      model: DEFAULT_NSFW_ENDPOINT,
      parameters: [],
      promptKey: null,
    },
    {
      step: "FLUX Pro safety tolerance (when the caller sets none)",
      engine: null,
      model: "fal FLUX Pro endpoints",
      parameters: [{ name: "safety_tolerance", value: FAL_SAFETY_TOLERANCE }],
      promptKey: null,
    },
    {
      step: "General helper model (defaults; a call may set its own budget)",
      engine: utility.label,
      model: utility.endpointId,
      parameters: chatParameters(utility.endpointId, utility.defaultMaxTokens ?? 0, utilityTemperature, utility.defaultReasoningEffort),
      promptKey: null,
    },
    {
      step: "General helper model, judgement calls",
      engine: utility.label,
      model: utility.endpointId,
      parameters: [{ name: "Reasoning effort", value: JUDGEMENT_REASONING_EFFORT }],
      promptKey: null,
    },
    {
      step: "Fact tokenizer",
      engine: null,
      model: TOKENIZER_MODEL,
      parameters: [{ name: "Reasoning effort", value: TOKENIZER_REASONING_EFFORT }],
      promptKey: null,
    },
  ];
  const prompts = await Promise.all(
    CODE_OWNED_PROMPT_DEFS.map(async (d) => ({ key: d.key, label: d.label, description: d.description, text: await (PROMPT_TEXT[d.key]?.() ?? Promise.resolve("")) })),
  );
  return { steps, prompts };
}
