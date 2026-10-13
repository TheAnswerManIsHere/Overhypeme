/**
 * Which helper calls reason (David, 2026-10-13): the five that make a real
 * judgement request JUDGEMENT_REASONING_EFFORT per call; the quick lookups
 * inherit the engine default ("none") and keep their temperatures. Captures the
 * request each call site actually sends through the utility-LLM seam.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { __setUtilityLLMClientForTest, JUDGEMENT_REASONING_EFFORT } from "../lib/utilityLLM";
import { llmDuplicateCheck, moderateComment, suggestHashtagsForText } from "../routes/ai";
import { generateVideoDirection } from "../lib/videoDirection";
import { generateScenePrompts } from "../lib/aiMemePipeline";
import { runTier3AiVisionFallback } from "../lib/sourceImageAnalysis/tier3AiVisionFallback";

type Sent = Record<string, unknown>;
let sent: Sent[] = [];
let reply = "{}";

const fakeClient = {
  chat: {
    completions: {
      create: async (params: Sent) => {
        sent.push(params);
        return { choices: [{ message: { content: reply } }] };
      },
    },
  },
} as unknown as Parameters<typeof __setUtilityLLMClientForTest>[0];

async function lastRequest(run: () => Promise<unknown>): Promise<Sent> {
  sent = [];
  await run().catch(() => undefined); // only the outgoing request is under test
  assert.equal(sent.length, 1, "exactly one model call");
  return sent[0];
}

describe("utility LLM reasoning effort per call site", () => {
  before(() => __setUtilityLLMClientForTest(fakeClient));
  after(() => __setUtilityLLMClientForTest(null));
  beforeEach(() => { reply = "{}"; });

  it("the judgement helpers request low effort", async () => {
    assert.equal(JUDGEMENT_REASONING_EFFORT, "low");
    const calls: [string, () => Promise<unknown>][] = [
      ["duplicate check", () => llmDuplicateCheck("{NAME} lifts mountains", [{ id: 1, text: "x", canonicalText: null, similarity: 0.9 }])],
      ["comment moderation", () => moderateComment(-1, "great fact")],
      ["tier-3 image classifier", () => runTier3AiVisionFallback("https://example.com/a.jpg")],
      ["video direction", () => generateVideoDirection("{NAME} lifts mountains", "https://example.com/a.jpg")],
      ["scene prompts", () => generateScenePrompts("{NAME} lifts mountains")],
    ];
    for (const [name, run] of calls) {
      const req = await lastRequest(run);
      assert.equal(req.reasoning_effort, "low", name);
      assert.equal(req.temperature, undefined, `${name}: reasoning drops temperature`);
    }
  });

  it("the quick lookups inherit the engine default and keep their temperature", async () => {
    reply = JSON.stringify({ tags: ["strength"] });
    const req = await lastRequest(() => suggestHashtagsForText("{NAME} lifts mountains"));
    assert.equal(req.reasoning_effort, "none");
    assert.equal(req.temperature, 0.3);
  });
});
