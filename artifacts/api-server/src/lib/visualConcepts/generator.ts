/**
 * Candidate Visual-concept generator (Slice 2A).
 *
 * ONE frontier structured-outputs call returns THREE distinct "describe the
 * picture" concepts for a fact. Mirrors the render-time image-prompt generator's
 * engine-resolution + retry-once flow, but:
 *   - it reuses the SAME descriptive context via `buildImagePromptContextBlocks`
 *     with the render-mode-AGNOSTIC subset (CANDIDATE_CONTEXT_OPTS) — no
 *     source-image / identity / render-control / style / target-engine blocks,
 *     because a picked concept must work across every render mode; and
 *   - the moderator scene is fed as a fresh-idea seed (blank field → no scene) or
 *     as `existing_draft_context` (Regenerate → propose DISTINCT alternatives),
 *     never as an authoritative directive.
 *
 * Each returned concept is sanitized + token-validated at store time so a picked
 * candidate can never fail the `coreSceneOverride` save superRefine.
 */

import { zodResponseFormat } from "openai/helpers/zod";
import {
  candidateConceptsWireSchema,
  validateCandidateConcepts,
  sanitizeCandidateConcept,
  CANDIDATE_VISUAL_CONCEPT_COUNT,
  VISUAL_CONCEPTS_PROMPT_VERSION,
  type FactEnrichment,
  type RenderPolicy,
  type StoredCandidateConcept,
  type VisualConceptProvenance,
} from "@workspace/api-zod";
import { callUtilityLLM, UTILITY_LLM_TIMEOUT_MS } from "../utilityLLM";
import {
  buildImagePromptContextBlocks,
  CANDIDATE_CONTEXT_OPTS,
  type ImagePromptContextInput,
  type ModeratorCoreSceneMode,
} from "../imagePrompt/generator";
import { getVisualConceptsSystem, getVisualConceptsEngineId, DEFAULT_VISUAL_CONCEPTS_ENGINE_ID } from "../visualConceptsConfig";
import { loadEngine } from "../engineInterpreter";
import { logger } from "../logger";

/** A frontier reasoning model at high effort needs minutes, not the 30s default. */
export const VISUAL_CONCEPTS_LLM_TIMEOUT_MS = 180_000;
export const VISUAL_CONCEPTS_TEMPERATURE = 0.8; // ideation → some diversity
export const VISUAL_CONCEPTS_MAX_TOKENS = 3000;

export class VisualConceptsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualConceptsError";
  }
}

export interface GenerateVisualConceptsInput {
  /** Fact text with {NAME}/pronoun tokens INTACT (concepts carry the tokens). */
  factText: string;
  enrichment: FactEnrichment;
  renderPolicy?: RenderPolicy;
  /** Regenerate: the moderator's unsaved draft, offered as distinct-alt context. */
  moderatorDraftScene?: string;
}

export interface VisualConceptsGenerationResult {
  candidates: StoredCandidateConcept[];
  provenance: VisualConceptProvenance;
}

// ─── Engine settings resolution ─────────────────────────────────────────────

interface VisualConceptsLLMSettings {
  model?: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: string;
  timeoutMs?: number;
  provenance: VisualConceptProvenance;
}

function fallbackSettings(configuredEngineId: string, fallbackReason: string): VisualConceptsLLMSettings {
  return {
    temperature: VISUAL_CONCEPTS_TEMPERATURE,
    maxTokens: VISUAL_CONCEPTS_MAX_TOKENS,
    provenance: {
      engineId: configuredEngineId,
      model: null,
      reasoningEffort: null,
      timeoutMs: UTILITY_LLM_TIMEOUT_MS,
      promptVersion: VISUAL_CONCEPTS_PROMPT_VERSION,
      fallbackReason,
    },
  };
}

/**
 * Resolve the candidate-concept engine (config key `fact_visual_concepts_engine_id`)
 * into per-call settings + provenance. Any invalid state falls back to the default
 * utility LLM with the reason recorded — never throws.
 */
export async function resolveVisualConceptsLLMSettings(): Promise<VisualConceptsLLMSettings> {
  let configuredEngineId = DEFAULT_VISUAL_CONCEPTS_ENGINE_ID;
  try {
    configuredEngineId = (await getVisualConceptsEngineId()).trim() || DEFAULT_VISUAL_CONCEPTS_ENGINE_ID;
    const engine = await loadEngine(configuredEngineId);
    const reason = !engine
      ? "engine_not_found"
      : engine.kind !== "llm"
        ? "engine_not_llm"
        : engine.provider !== "openai"
          ? "engine_not_openai"
          : !engine.isActive
            ? "engine_inactive"
            : engine.deletedAt != null
              ? "engine_deleted"
              : !engine.endpointId
                ? "engine_missing_model"
                : null;
    if (engine && reason === null) {
      return {
        model: engine.endpointId,
        temperature: engine.defaultTemperature != null ? Number(engine.defaultTemperature) : VISUAL_CONCEPTS_TEMPERATURE,
        maxTokens: engine.defaultMaxTokens ?? VISUAL_CONCEPTS_MAX_TOKENS,
        reasoningEffort: engine.defaultReasoningEffort ?? undefined,
        timeoutMs: VISUAL_CONCEPTS_LLM_TIMEOUT_MS,
        provenance: {
          engineId: configuredEngineId,
          model: engine.endpointId,
          reasoningEffort: engine.defaultReasoningEffort ?? null,
          timeoutMs: VISUAL_CONCEPTS_LLM_TIMEOUT_MS,
          promptVersion: VISUAL_CONCEPTS_PROMPT_VERSION,
          fallbackReason: null,
        },
      };
    }
    logger.warn({ configuredEngineId, reason }, "[visualConcepts.generator] engine fallback");
    return fallbackSettings(configuredEngineId, reason ?? "unknown");
  } catch (err) {
    logger.warn({ configuredEngineId, err }, "[visualConcepts.generator] engine fallback");
    return fallbackSettings(configuredEngineId, "resolver_error");
  }
}

// ─── User-message assembly ──────────────────────────────────────────────────

type UserMessage = { role: "user"; content: string };

export function buildVisualConceptsUserMessage(input: GenerateVisualConceptsInput): string {
  const draft = input.moderatorDraftScene?.trim() ?? "";
  const moderatorMode: ModeratorCoreSceneMode = draft ? "existing_draft_context" : false;

  // The render-mode-agnostic context input (runtime fields deliberately absent).
  const contextInput: ImagePromptContextInput = {
    factText: input.factText,
    enrichment: input.enrichment,
    renderPolicy: input.renderPolicy,
  };

  const contextLines = buildImagePromptContextBlocks(contextInput, {
    ...CANDIDATE_CONTEXT_OPTS,
    includeModeratorCoreScene: moderatorMode,
    ...(draft ? { moderatorDraftScene: draft } : {}),
  });

  return [
    `Draft ${CANDIDATE_VISUAL_CONCEPT_COUNT} distinct Visual concepts for the following fact — different stagings/gags for the SAME fact. The protagonist is written with the {NAME} token; keep that token in every sceneDescription.`,
    "",
    ...contextLines,
    "OUTPUT CONTRACT:",
    `- Return EXACTLY ${CANDIDATE_VISUAL_CONCEPT_COUNT} concepts in "concepts".`,
    "- Each concept: { title, whyItWorks, sceneDescription }, all non-empty.",
    "- sceneDescription: ONE tight paragraph, describe-the-picture (visible pixels only), referring to the protagonist ONLY as {NAME} / {NAME_POSSESSIVE} (+ pronoun tokens). No identity/reference-image/style/target-engine language.",
    "- Make the three concepts genuinely different from each other.",
    "- Return ONLY the JSON object.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function buildCorrective(error: string): string {
  return `The previous response failed validation: ${error}\n\nReturn the full JSON object again with exactly ${CANDIDATE_VISUAL_CONCEPT_COUNT} valid concepts.`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export async function generateVisualConceptsWithModel(
  input: GenerateVisualConceptsInput,
  callModel: (msgs: UserMessage[]) => Promise<string>,
): Promise<StoredCandidateConcept[]> {
  const firstUser: UserMessage = { role: "user", content: buildVisualConceptsUserMessage(input) };

  let raw = await callModel([firstUser]);
  let result = validateCandidateConcepts(safeJsonParse(raw));

  if (!result.ok) {
    raw = await callModel([firstUser, { role: "user", content: buildCorrective(result.error) }]);
    result = validateCandidateConcepts(safeJsonParse(raw));
  }

  if (!result.ok) {
    throw new VisualConceptsError(result.error);
  }

  return result.data.concepts.map(sanitizeCandidateConcept);
}

function makeOpenAIConceptsCaller(
  settings: VisualConceptsLLMSettings,
): (userMessages: UserMessage[]) => Promise<string> {
  return async (userMessages: UserMessage[]): Promise<string> => {
    const systemPrompt = await getVisualConceptsSystem();
    const response = await callUtilityLLM({
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      reasoningEffort: settings.reasoningEffort,
      timeoutMs: settings.timeoutMs,
      responseFormat: zodResponseFormat(candidateConceptsWireSchema, "visual_concepts"),
      messages: [{ role: "system", content: systemPrompt }, ...userMessages],
    });
    return response.choices[0]?.message?.content ?? "{}";
  };
}

/**
 * Generate three candidate concepts via the configured engine (falling back to
 * the default utility LLM). Returns sanitized/token-validated candidates +
 * provenance. Throws VisualConceptsError on unrecoverable failure.
 */
export async function generateVisualConcepts(
  input: GenerateVisualConceptsInput,
): Promise<VisualConceptsGenerationResult> {
  const settings = await resolveVisualConceptsLLMSettings();
  const candidates = await generateVisualConceptsWithModel(input, makeOpenAIConceptsCaller(settings));
  return { candidates, provenance: settings.provenance };
}
