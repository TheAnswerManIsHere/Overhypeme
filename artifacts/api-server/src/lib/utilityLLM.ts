/**
 * Shared OpenAI chat dispatch.
 *
 * Every general-intelligence text/JSON call in the app routes through here so
 * the model + sampling defaults are set in ONE place — the code definition of
 * the utility engine, `UTILITY_LLM_ENGINE_ID` (decisions.md 2026-11-14: AI call
 * settings live in code). Call sites pass their own messages + response format
 * and may override temperature / max tokens per request.
 *
 * If the utility engine is switched off or its lookup fails, we fall back to
 * baked-in defaults so a misconfiguration degrades rather than hard-fails.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type OpenAI from "openai";
import { getOpenAIClient } from "./aiClients";
import { loadEngine } from "./engineInterpreter";
import { chatModelTuningParams } from "./openaiChatParams";
import { logger } from "./logger";

const FALLBACK_MODEL = "gpt-6-luna";
const FALLBACK_TEMPERATURE = 0.7;
const FALLBACK_MAX_TOKENS = 512;
/**
 * gpt-6-luna defaults to medium effort; "none" keeps helper calls fast and
 * non-reasoning, like the gpt-4o-mini they replaced, and keeps temperature.
 */
const FALLBACK_REASONING_EFFORT = "none";

/**
 * Per-call reasoning effort for the helpers that make a real judgement (David,
 * 2026-10-13): the duplicate check, comment moderation, the tier-3 image
 * classifier, video direction and scene prompts. A wrong answer there reaches a
 * user, and on gpt-6-luna a little reasoning costs fractions of a cent. The
 * quick lookups (pronouns, hashtags) inherit the engine
 * default, "none", which keeps them fast and keeps their temperatures. Note
 * that at this effort a GPT-6 model ignores the caller's temperature.
 */
export const JUDGEMENT_REASONING_EFFORT = "low";

/** Milliseconds before a utility LLM call is aborted. */
export const UTILITY_LLM_TIMEOUT_MS = 30_000;

export interface UtilityLLMRequest {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  /** e.g. { type: "json_object" }. Omit for plain-text completions. */
  responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"];
  /** Per-call override of the engine's default temperature (chat models only). */
  temperature?: number;
  /** Per-call override of the engine's default max output tokens. */
  maxTokens?: number;
  /**
   * Per-call override of the model. When set, this call uses the given model
   * instead of the default "llm" engine's model — letting a single call site
   * (e.g. the tokenizer) move to a stronger model without changing the global
   * utility model every other call shares.
   */
  model?: string;
  /** Per-call override of the reasoning effort (reasoning models only). */
  reasoningEffort?: string;
  /** Override the default per-call timeout (ms). */
  timeoutMs?: number;
}

interface LLMSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: string;
}

// Test seam: lets tests capture the request a call site sends without a live
// OpenAI key. Mirrors `__setSuggestHashtagsForTest`. Always reset in an after().
/**
 * A scope in which every utility LLM call submits once: the SDK's own retries
 * are off. The engine comparison runs its planner calls inside one, because it
 * reserves exactly the calls it permits and a retry is another priced call
 * (launch Phase 8 plan, "Comparison planner calls use an OpenAI client built
 * with `maxRetries: 0`"). Everything else keeps the SDK's defaults.
 */
const noRetryScope = new AsyncLocalStorage<true>();
export function withoutLlmRetries<T>(fn: () => Promise<T>): Promise<T> {
  return noRetryScope.run(true, fn);
}
/** The retry count the current scope imposes, or undefined for the SDK's default. */
export function llmMaxRetriesInScope(): number | undefined {
  return noRetryScope.getStore() ? 0 : undefined;
}

let clientForTest: ReturnType<typeof getOpenAIClient> | null = null;
export function __setUtilityLLMClientForTest(client: ReturnType<typeof getOpenAIClient> | null): void {
  clientForTest = client;
}

/**
 * The utility helpers' engine (decisions.md 2026-10-13, GPT-6 Luna). Chosen in
 * code (decisions.md 2026-11-14): no engine row's `is_default` picks it.
 */
export const UTILITY_LLM_ENGINE_ID = "openai-general";

/** Resolve the model + sampling defaults from the utility engine's code definition. */
async function resolveLLMSettings(): Promise<LLMSettings> {
  try {
    const engine = await loadEngine(UTILITY_LLM_ENGINE_ID);
    if (!engine || !engine.isActive) throw new Error(`utility engine "${UTILITY_LLM_ENGINE_ID}" is unavailable`);
    return {
      model: engine.endpointId || FALLBACK_MODEL,
      temperature: engine.defaultTemperature != null ? Number(engine.defaultTemperature) : FALLBACK_TEMPERATURE,
      maxTokens: engine.defaultMaxTokens ?? FALLBACK_MAX_TOKENS,
      reasoningEffort: engine.defaultReasoningEffort ?? undefined,
    };
  } catch (err) {
    logger.warn({ err }, "[utilityLLM] utility engine unavailable; using baked-in defaults");
    return {
      model: FALLBACK_MODEL,
      temperature: FALLBACK_TEMPERATURE,
      maxTokens: FALLBACK_MAX_TOKENS,
      reasoningEffort: FALLBACK_REASONING_EFFORT,
    };
  }
}

/**
 * Run a chat completion through the configured general-intelligence engine.
 * The call shape (max_tokens+temperature vs max_completion_tokens+reasoning_effort)
 * is chosen by chatModelTuningParams based on the engine's model, so reasoning
 * and non-reasoning models both work transparently.
 */
export async function callUtilityLLM(
  req: UtilityLLMRequest,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const openai = clientForTest ?? getOpenAIClient();
  const settings = await resolveLLMSettings();
  const timeoutMs = req.timeoutMs ?? UTILITY_LLM_TIMEOUT_MS;
  const model = req.model ?? settings.model;
  return openai.chat.completions.create(
    {
      model,
      ...chatModelTuningParams({
        model,
        maxTokens: req.maxTokens ?? settings.maxTokens,
        temperature: req.temperature ?? settings.temperature,
        reasoningEffort: req.reasoningEffort ?? settings.reasoningEffort,
      }),
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      messages: req.messages,
    },
    { timeout: timeoutMs, ...(llmMaxRetriesInScope() === 0 ? { maxRetries: 0 } : {}) },
  );
}
