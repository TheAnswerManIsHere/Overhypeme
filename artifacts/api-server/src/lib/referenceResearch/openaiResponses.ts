/**
 * OpenAI Responses API wrapper for reference research.
 *
 * Distinct from `callUtilityLLM` (chat.completions) because this code path
 * needs the `web_search_preview` tool — only available on the Responses API
 * surface. Same OpenAI client; different endpoint.
 *
 * The Responses API returns an `output` array of items (reasoning, tool
 * calls, message content). For our use case (Structured Outputs JSON via the
 * `text.format.json_schema` field) the synthesized JSON lands in
 * `response.output_text`. We parse that into the wire schema.
 */

import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import {
  REFERENCE_RESEARCH_CONFIDENCE_VALUES,
  REFERENCE_RESEARCH_SOURCE_TYPE_VALUES,
} from "@workspace/api-zod";
import { logger } from "../logger";

/** Default model for the research call. Web-search is gpt-4.1 / gpt-4o family. */
export const REFERENCE_RESEARCH_MODEL = "gpt-4.1";
/** Modest output; the JSON is small. */
export const REFERENCE_RESEARCH_MAX_OUTPUT_TOKENS = 1500;
/** Hard timeout for the (slower) tool-using call. */
export const REFERENCE_RESEARCH_TIMEOUT_MS = 60_000;

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
 * Call the Responses API with the web_search_preview tool + Structured
 * Outputs JSON schema, returning the raw output_text. The caller validates.
 */
export async function callReferenceResearchModel({
  systemPrompt,
  userMessage,
}: CallArgs): Promise<string> {
  const openai = getOpenAIClient();
  try {
    const response = await openai.responses.create(
      {
        model: REFERENCE_RESEARCH_MODEL,
        tools: [{ type: "web_search_preview" }],
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
        max_output_tokens: REFERENCE_RESEARCH_MAX_OUTPUT_TOKENS,
      },
      { timeout: REFERENCE_RESEARCH_TIMEOUT_MS },
    );
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
