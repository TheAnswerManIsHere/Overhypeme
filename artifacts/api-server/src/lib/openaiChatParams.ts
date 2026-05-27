/**
 * Call-shape helper for OpenAI chat completions.
 *
 * The GPT-4o / 4.1 families take `max_tokens` + `temperature`. The reasoning
 * families (gpt-5*, o-series) reject those: they need `max_completion_tokens`
 * and (optionally) `reasoning_effort`, and only support the default temperature.
 * This helper returns the right tuning fragment so callers can stay
 * model-agnostic — pass the admin-configured levers, spread the result into
 * `chat.completions.create({ model, messages, ... })`.
 *
 * Reasoning tokens count against `max_completion_tokens`, so for reasoning
 * models we add headroom on top of the configured visible-output budget;
 * otherwise a small cap (e.g. 200) would be consumed by reasoning and return an
 * empty/truncated answer. Billing is by actual tokens used, not the cap.
 */

import type OpenAI from "openai";

/** Reasoning models: gpt-5 family (5, 5.1, 5.2, 5.4, 5.5, incl. mini/nano) and the o-series. */
export function isReasoningChatModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("gpt-5") || /^o\d/.test(m);
}

/** Extra completion-token budget for reasoning models so reasoning doesn't starve the answer. */
export const REASONING_TOKEN_HEADROOM = 8000;

type TuningParams = Pick<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "max_tokens" | "max_completion_tokens" | "temperature" | "reasoning_effort"
>;

export function chatModelTuningParams(opts: {
  model: string;
  maxTokens: number;
  temperature: number;
  /** Only applied to reasoning models; ignored for gpt-4.x. */
  reasoningEffort?: string;
}): TuningParams {
  const { model, maxTokens, temperature, reasoningEffort } = opts;
  if (isReasoningChatModel(model)) {
    const params: TuningParams = {
      max_completion_tokens: maxTokens + REASONING_TOKEN_HEADROOM,
    };
    const effort = reasoningEffort?.trim();
    if (effort) {
      params.reasoning_effort = effort as TuningParams["reasoning_effort"];
    }
    return params;
  }
  return { max_tokens: maxTokens, temperature };
}
