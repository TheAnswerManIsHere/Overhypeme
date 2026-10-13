/**
 * OpenAI Responses API wrapper for reference research.
 *
 * Distinct from `callUtilityLLM` (chat.completions) because this code path
 * needs the `web_search` tool — only available on the Responses API
 * surface. Same OpenAI client; different endpoint.
 *
 * The Responses API returns an `output` array of items (reasoning, tool
 * calls, message content). For our use case (Structured Outputs JSON via the
 * `text.format.json_schema` field) the synthesized JSON lands in
 * `response.output_text`. We parse that into the wire schema.
 */

import type OpenAI from "openai";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import {
  REFERENCE_RESEARCH_CONFIDENCE_VALUES,
  REFERENCE_RESEARCH_SOURCE_TYPE_VALUES,
} from "@workspace/api-zod";
import { logger } from "../logger";
import { REASONING_TOKEN_HEADROOM } from "../openaiChatParams";

/**
 * Model for the research call: OpenAI's mid tier, at the same input price as
 * the gpt-4.1 it replaced. A reasoning model that supports the `web_search`
 * tool (it accepts no `none`/`minimal` effort, so `low` is its floor).
 */
export const REFERENCE_RESEARCH_MODEL = "gpt-6.1-sol";
/** Reasoning effort for the research call — the cheapest the model accepts. */
export const REFERENCE_RESEARCH_REASONING_EFFORT = "low" as const;
/** Modest visible output; the JSON is small. */
export const REFERENCE_RESEARCH_MAX_OUTPUT_TOKENS = 1500;
/**
 * `max_output_tokens` also caps the reasoning tokens, so the request adds this
 * headroom on top of the visible budget; without it, reasoning can consume the
 * cap and leave `output_text` empty. Billing is by tokens used, not the cap.
 */
export const REFERENCE_RESEARCH_REASONING_HEADROOM = REASONING_TOKEN_HEADROOM;
/** Hard timeout for the (slower) tool-using, reasoning call. */
export const REFERENCE_RESEARCH_TIMEOUT_MS = 120_000;

export class ReferenceResearchOpenAIError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "ReferenceResearchOpenAIError";
  }
}

interface CallArgs {
  systemPrompt: string;
  userMessage: string;
}

/**
 * The Responses API request body for one research call: the web_search tool,
 * low reasoning effort, Structured Outputs JSON schema, and an output cap that
 * leaves room for reasoning. Pure, so the request shape is testable.
 */
export function buildReferenceResearchRequest({
  systemPrompt,
  userMessage,
}: CallArgs): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  return {
    model: REFERENCE_RESEARCH_MODEL,
    tools: [{ type: "web_search" }],
    reasoning: { effort: REFERENCE_RESEARCH_REASONING_EFFORT },
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "reference_research_result",
        strict: true,
        schema: buildResponseJsonSchema(),
      },
    },
    max_output_tokens:
      REFERENCE_RESEARCH_MAX_OUTPUT_TOKENS + REFERENCE_RESEARCH_REASONING_HEADROOM,
  };
}

/**
 * Call the Responses API with the request above, returning the raw
 * output_text. The caller validates.
 */
export async function callReferenceResearchModel(args: CallArgs): Promise<string> {
  const openai = getOpenAIClient();
  try {
    const response = await openai.responses.create(buildReferenceResearchRequest(args), {
      timeout: REFERENCE_RESEARCH_TIMEOUT_MS,
    });
    const text = (response as { output_text?: string }).output_text ?? "";
    if (!text) {
      throw new ReferenceResearchOpenAIError(
        "OpenAI Responses returned empty output_text",
      );
    }
    return text;
  } catch (err) {
    if (err instanceof ReferenceResearchOpenAIError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "[referenceResearch.openaiResponses] call failed");
    throw new ReferenceResearchOpenAIError(`OpenAI Responses call failed: ${msg}`, err);
  }
}

/**
 * Mirror of `referenceResearchResultWireSchema` in JSON Schema form, since
 * the Responses API's `text.format.json_schema` field wants raw JSON Schema
 * (not a Zod object). Keep these in lockstep.
 */
function buildResponseJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "explanation",
      "visualImplication",
      "confidence",
      "sources",
      "researchNotes",
      "ambiguityWarnings",
    ],
    properties: {
      explanation: { type: "string" },
      visualImplication: { type: "string" },
      confidence: { type: "string", enum: [...REFERENCE_RESEARCH_CONFIDENCE_VALUES] },
      sources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url", "sourceType", "summary"],
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            sourceType: {
              type: "string",
              enum: [...REFERENCE_RESEARCH_SOURCE_TYPE_VALUES],
            },
            summary: { type: "string" },
          },
        },
      },
      researchNotes: { type: "string" },
      ambiguityWarnings: {
        type: "array",
        items: { type: "string" },
      },
    },
  };
}
