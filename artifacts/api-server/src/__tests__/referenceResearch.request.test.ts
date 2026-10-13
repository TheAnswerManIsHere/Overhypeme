/**
 * Unit tests for the reference-research Responses request shape. Pure; no DB,
 * no network. Guards the move off gpt-4.1: the current web-search tool, an
 * explicit low reasoning effort, and an output cap with reasoning headroom so
 * reasoning tokens cannot starve the JSON answer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildReferenceResearchRequest,
  REFERENCE_RESEARCH_MODEL,
  REFERENCE_RESEARCH_MAX_OUTPUT_TOKENS,
} from "../lib/referenceResearch/openaiResponses";
import { isReasoningChatModel, REASONING_TOKEN_HEADROOM } from "../lib/openaiChatParams";

describe("buildReferenceResearchRequest", () => {
  const req = buildReferenceResearchRequest({ systemPrompt: "sys", userMessage: "user" });

  it("uses a current reasoning model, not the gpt-4.x family", () => {
    assert.equal(req.model, REFERENCE_RESEARCH_MODEL);
    assert.equal(isReasoningChatModel(String(req.model)), true);
    assert.doesNotMatch(String(req.model), /^gpt-4/);
  });

  it("uses the web_search tool, not web_search_preview", () => {
    assert.deepEqual(req.tools, [{ type: "web_search" }]);
  });

  it("sets an explicit low reasoning effort", () => {
    assert.equal(req.reasoning?.effort, "low");
  });

  it("adds reasoning headroom on top of the visible output budget", () => {
    assert.equal(req.max_output_tokens, REFERENCE_RESEARCH_MAX_OUTPUT_TOKENS + REASONING_TOKEN_HEADROOM);
  });

  it("passes the prompts through and requests strict JSON", () => {
    assert.deepEqual(req.input, [
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
    const format = req.text?.format as { type: string; strict?: boolean } | undefined;
    assert.equal(format?.type, "json_schema");
    assert.equal(format?.strict, true);
  });
});
