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
    for (const m of ["gpt-5.1", "gpt-5.2", "gpt-5.4-mini", "gpt-5", "gpt-6-luna", "gpt-6.1-sol", "GPT-6-Luna", "o3", "o4-mini", "GPT-5.2"]) {
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

  it("gpt-6 at effort none keeps the caller's temperature and budget, with no headroom", () => {
    for (const temperature of [0, 0.3, 0.7]) {
      const p = chatModelTuningParams({ model: "gpt-6-luna", maxTokens: 60, temperature, reasoningEffort: "none" });
      assert.equal(p.temperature, temperature);
      assert.equal(p.max_completion_tokens, 60);
      assert.equal(p.reasoning_effort, "none");
      assert.equal(p.max_tokens, undefined);
    }
    const padded = chatModelTuningParams({ model: "GPT-6-Luna", maxTokens: 60, temperature: 0, reasoningEffort: " none " });
    assert.equal(padded.temperature, 0);
  });

  it("gpt-6 at any other effort (or unset) drops temperature and adds headroom", () => {
    for (const reasoningEffort of ["low", "medium", "", undefined]) {
      const p = chatModelTuningParams({ model: "gpt-6-luna", maxTokens: 512, temperature: 0.2, reasoningEffort });
      assert.equal(p.temperature, undefined, `effort ${String(reasoningEffort)}`);
      assert.equal(p.max_completion_tokens, 512 + REASONING_TOKEN_HEADROOM);
      assert.equal(p.max_tokens, undefined);
    }
  });

  it("gpt-5 / o-series keep the plain reasoning shape even at effort none", () => {
    for (const model of ["gpt-5.4-mini", "gpt-5.5", "o4-mini"]) {
      const p = chatModelTuningParams({ model, maxTokens: 1024, temperature: 0, reasoningEffort: "none" });
      assert.equal(p.temperature, undefined, model);
      assert.equal(p.max_completion_tokens, 1024 + REASONING_TOKEN_HEADROOM);
      assert.equal(p.reasoning_effort, "none");
    }
  });

  it("omits reasoning_effort when blank", () => {
    const p = chatModelTuningParams({ model: "gpt-5.1", maxTokens: 200, temperature: 0.7, reasoningEffort: "" });
    assert.equal(p.reasoning_effort, undefined);
    assert.equal(p.max_completion_tokens, 200 + REASONING_TOKEN_HEADROOM);
  });
});
