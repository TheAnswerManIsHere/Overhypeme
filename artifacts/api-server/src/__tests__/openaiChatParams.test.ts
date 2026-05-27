/**
 * Unit tests for lib/openaiChatParams.ts — the call-shape branch that lets the
 * scene/motion generators stay model-agnostic across the GPT-4.x (max_tokens +
 * temperature) and GPT-5 reasoning (max_completion_tokens + reasoning_effort)
 * families. Pure functions; no DB.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isReasoningChatModel,
  chatModelTuningParams,
  REASONING_TOKEN_HEADROOM,
} from "../lib/openaiChatParams";

describe("openaiChatParams", () => {
  it("classifies reasoning vs non-reasoning models", () => {
    for (const m of ["gpt-5.1", "gpt-5.2", "gpt-5.4-mini", "gpt-5", "o3", "o4-mini", "GPT-5.2"]) {
      assert.equal(isReasoningChatModel(m), true, `${m} should be a reasoning model`);
    }
    for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]) {
      assert.equal(isReasoningChatModel(m), false, `${m} should not be a reasoning model`);
    }
  });

  it("non-reasoning models use max_tokens + temperature", () => {
    const p = chatModelTuningParams({ model: "gpt-4.1", maxTokens: 400, temperature: 0.7, reasoningEffort: "low" });
    assert.equal(p.max_tokens, 400);
    assert.equal(p.temperature, 0.7);
    assert.equal(p.max_completion_tokens, undefined);
    assert.equal(p.reasoning_effort, undefined);
  });

  it("reasoning models use max_completion_tokens (with headroom) + reasoning_effort, no temperature", () => {
    const p = chatModelTuningParams({ model: "gpt-5.2", maxTokens: 200, temperature: 0.7, reasoningEffort: "low" });
    assert.equal(p.max_completion_tokens, 200 + REASONING_TOKEN_HEADROOM);
    assert.equal(p.reasoning_effort, "low");
    assert.equal(p.max_tokens, undefined);
    assert.equal(p.temperature, undefined);
  });

  it("omits reasoning_effort when blank", () => {
    const p = chatModelTuningParams({ model: "gpt-5.1", maxTokens: 200, temperature: 0.7, reasoningEffort: "" });
    assert.equal(p.reasoning_effort, undefined);
    assert.equal(p.max_completion_tokens, 200 + REASONING_TOKEN_HEADROOM);
  });
});
