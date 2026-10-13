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
  REFERENCE_RESEARCH_REASONING_HEADROOM,
  readReferenceResearchText,
  ReferenceResearchOpenAIError,
} from "../lib/referenceResearch/openaiResponses";
import { isReasoningChatModel } from "../lib/openaiChatParams";

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
    assert.equal(req.max_output_tokens, REFERENCE_RESEARCH_MAX_OUTPUT_TOKENS + REFERENCE_RESEARCH_REASONING_HEADROOM);
    assert.ok(REFERENCE_RESEARCH_REASONING_HEADROOM >= 25_000, "room for a web-searching reasoning model");
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

describe("readReferenceResearchText", () => {
  it("returns the text of a completed response", () => {
    assert.equal(readReferenceResearchText({ status: "completed", output_text: "{\"a\":1}" }), "{\"a\":1}");
  });

  it("refuses an incomplete response even when partial text is present", () => {
    for (const reason of ["max_output_tokens", "content_filter", undefined]) {
      assert.throws(
        () => readReferenceResearchText({
          status: "incomplete",
          incomplete_details: reason ? { reason } : null,
          output_text: "{\"explanation\": \"cut of",
        }),
        (err: unknown) => err instanceof ReferenceResearchOpenAIError && /incomplete/.test(err.message),
      );
    }
  });

  it("refuses an empty answer", () => {
    assert.throws(() => readReferenceResearchText({ status: "completed", output_text: "" }), ReferenceResearchOpenAIError);
  });
});
