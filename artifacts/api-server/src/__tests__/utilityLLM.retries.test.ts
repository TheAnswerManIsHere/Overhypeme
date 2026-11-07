// The engine comparison's planner calls submit once (launch Phase 8 plan,
// "Comparison planner calls use an OpenAI client built with `maxRetries: 0`").
// The no-retry scope reaches the OpenAI request options of every call made
// inside it, and no call outside it.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { __setUtilityLLMClientForTest, callUtilityLLM, withoutLlmRetries } from "../lib/utilityLLM.js";

const seen: Array<Record<string, unknown> | undefined> = [];
const fakeClient = {
  chat: {
    completions: {
      async create(_body: unknown, options?: Record<string, unknown>) {
        seen.push(options);
        return { choices: [{ message: { content: "{}" } }] };
      },
    },
  },
} as unknown as Parameters<typeof __setUtilityLLMClientForTest>[0];

after(() => __setUtilityLLMClientForTest(null));

describe("utility LLM retries", () => {
  it("a call inside the no-retry scope sends maxRetries 0; one outside keeps the SDK's default", async () => {
    __setUtilityLLMClientForTest(fakeClient);
    const req = { model: "gpt-5.5", maxTokens: 10, temperature: 0.4, messages: [{ role: "user" as const, content: "x" }] };
    await withoutLlmRetries(async () => {
      await callUtilityLLM(req);
      await callUtilityLLM(req); // the corrective call is in the same scope
    });
    await callUtilityLLM(req);
    assert.equal(seen[0]?.["maxRetries"], 0);
    assert.equal(seen[1]?.["maxRetries"], 0);
    assert.equal(seen[2]?.["maxRetries"], undefined);
  });
});
