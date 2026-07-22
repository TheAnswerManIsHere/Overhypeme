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
  isCandidateConceptPickable,
  withCandidateConceptDraft,
  CANDIDATE_VISUAL_CONCEPT_COUNT,
  VISUAL_CONCEPTS_PROMPT_VERSION,
  MAX_BUBBLES,
  BUBBLE_TEXT_MAX_CHARS,
  type FactEnrichment,
  type RenderPolicy,
  type StoredCandidateConcept,
  type VisualConceptProvenance,
} from "@workspace/api-zod";
import { validateVisualStrategyOverridePersistence } from "../imagePrompt/promptBudget";
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
    '- Each concept: { title, whyItWorks, sceneDescription, bubbles }, with title/whyItWorks/sceneDescription non-empty. "bubbles" is REQUIRED — [] when the concept needs none (the normal case).',
    "- sceneDescription: ONE tight paragraph, describe-the-picture (visible pixels only), referring to the protagonist ONLY as {NAME} / {NAME_POSSESSIVE} (+ pronoun tokens). No identity/reference-image/style/target-engine language.",
    `- bubbles: propose a speech/thought bubble ONLY when it materially serves the gag — above all when the fact contains literal quoted speech or thought (put the exact quote in a bubble instead of describing it). Each bubble: { type: "speech"|"thought", entity, text }. entity is the literal word "subject" for the protagonist (NEVER {NAME} or any {token}) or a plain role label for another character ("the bartender"). text is the EXACT line to letter, at most ${BUBBLE_TEXT_MAX_CHARS} characters (shorter is better; {NAME}/pronoun tokens allowed). If a source quote is longer, use an exact meaningful excerpt that fits, or propose no bubble — NEVER paraphrase as if it were the quote. At most ${MAX_BUBBLES} bubbles.`,
    "- When you propose bubbles, the sceneDescription must NOT describe any balloon, bubble, tail, or the bubble's text — stage only the pose, expression, and clear headroom for it. Text on signs/screens/objects is scene content, not a bubble; quotation marks used ironically or as a title are not speech; if you cannot attribute a quote to a clear speaker, propose no bubble.",
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

/**
 * The DETERMINISTIC validate/sanitize matrix — runs in full BEFORE the retry
 * decision, so every error class has exactly one outcome:
 *
 *   RETRYABLE whole-response contract errors (one corrective retry; a second
 *   failure fails the generation attempt under normal queue semantics):
 *     wire-shape/missing `bubbles`, wrong concept count, >MAX bubbles,
 *     empty/over-cap entity or text, invalid type, single-channel violations
 *     (all via `validateCandidateConcepts`), a pickable concept whose applied
 *     override fails the combined budget preflight, and a response with NO
 *     pickable concept at all (an all-unpickable response is not a useful
 *     artifact — it must never be stored as `ok`).
 *
 *   STORED-UNPICKABLE candidate errors (kept, displayed with their exact
 *   error, excluded from pick — the existing scene tokenValid pattern):
 *     an unknown personalization token in scene or bubble text, or a token in
 *     a bubble entity, on a response that still has ≥1 pickable concept.
 */
export function validateAndSanitizeCandidateConcepts(
  parsed: unknown,
): { ok: true; candidates: StoredCandidateConcept[] } | { ok: false; error: string } {
  const result = validateCandidateConcepts(parsed);
  if (!result.ok) return result;
  const candidates = result.data.concepts.map(sanitizeCandidateConcept);

  // pickable ⇒ saveable: preflight the EXACT override a pick produces
  // (withCandidateConceptDraft on the pool-independent base) through the one
  // server persistence validator. A pickable concept that cannot be saved is
  // a contract violation the model must correct.
  for (const [i, c] of candidates.entries()) {
    if (!isCandidateConceptPickable(c)) continue;
    const budget = validateVisualStrategyOverridePersistence(withCandidateConceptDraft(undefined, c));
    if (!budget.ok) {
      const first = budget.errors[0];
      return {
        ok: false,
        error: `concept ${i + 1} would exceed the prompt budget once applied (${first?.message ?? "over budget"}) — shorten its sceneDescription or bubble text`,
      };
    }
  }

  if (!candidates.some(isCandidateConceptPickable)) {
    return {
      ok: false,
      error:
        "every concept has an invalid personalization token in its scene or bubbles — use ONLY {NAME}/{NAME_POSSESSIVE}/pronoun tokens in text, and 'subject' or a plain role label (never a token) as a bubble entity",
    };
  }

  return { ok: true, candidates };
}

export async function generateVisualConceptsWithModel(
  input: GenerateVisualConceptsInput,
  callModel: (msgs: UserMessage[]) => Promise<string>,
): Promise<StoredCandidateConcept[]> {
  const firstUser: UserMessage = { role: "user", content: buildVisualConceptsUserMessage(input) };

  let raw = await callModel([firstUser]);
  let result = validateAndSanitizeCandidateConcepts(safeJsonParse(raw));

  if (!result.ok) {
    raw = await callModel([firstUser, { role: "user", content: buildCorrective(result.error) }]);
    result = validateAndSanitizeCandidateConcepts(safeJsonParse(raw));
  }

  if (!result.ok) {
    throw new VisualConceptsError(result.error);
  }

  return result.candidates;
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
