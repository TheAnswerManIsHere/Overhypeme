/**
 * Unit tests for the NSFW classifier wrapper + decision matrix.
 *
 * The classifier itself is exercised via a stub that mimics the
 * `fal.subscribe` shape. The decision matrix tests cover the three
 * outcomes the upload route depends on:
 *
 *   score < threshold                              → accept
 *   score >= threshold && !user.nsfwModeEnabled    → reject
 *   score >= threshold &&  user.nsfwModeEnabled    → accept + tag
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyNsfwByUrl,
  classifyAndDecide,
  extractNsfwScore,
  DEFAULT_NSFW_THRESHOLD,
  DEFAULT_NSFW_ENDPOINT,
} from "../lib/moderation/nsfwClassifier.js";

function fakeFal(score: number) {
  return {
    subscribe: async () => ({ data: { nsfw_score: score } }),
  };
}

describe("moderation/nsfwClassifier", () => {
  describe("extractNsfwScore", () => {
    it("reads nsfw_score, score, nsfw_probability, nsfw", () => {
      assert.equal(extractNsfwScore({ nsfw_score: 0.9 }), 0.9);
      assert.equal(extractNsfwScore({ data: { score: 0.7 } }), 0.7);
      assert.equal(extractNsfwScore({ data: { nsfw_probability: 0.42 } }), 0.42);
      assert.equal(extractNsfwScore({ data: { nsfw: true } }), 1);
      assert.equal(extractNsfwScore({ data: { nsfw: false } }), 0);
      assert.equal(extractNsfwScore({}), null);
      assert.equal(extractNsfwScore(null), null);
    });
  });

  describe("classifyNsfwByUrl", () => {
    it("returns score + endpoint", async () => {
      const r = await classifyNsfwByUrl("https://example/img.jpg", {
        falImpl: fakeFal(0.42),
        endpoint: "fal-ai/imageutils/nsfw",
        timeoutMs: 1_000,
      });
      assert.equal(r.score, 0.42);
      assert.equal(r.model, "fal-ai/imageutils/nsfw");
    });
  });

  describe("classifyAndDecide", () => {
    it("accepts when score < threshold", async () => {
      const decision = await classifyAndDecide("u", {
        nsfwModeEnabled: false,
        overrides: { falImpl: fakeFal(DEFAULT_NSFW_THRESHOLD - 0.1), endpoint: DEFAULT_NSFW_ENDPOINT },
      });
      assert.equal(decision.outcome, "accept");
      if (decision.outcome === "accept") assert.equal(decision.isNsfwTag, false);
    });

    it("rejects when score >= threshold and nsfw mode is off", async () => {
      const decision = await classifyAndDecide("u", {
        nsfwModeEnabled: false,
        overrides: { falImpl: fakeFal(DEFAULT_NSFW_THRESHOLD + 0.05), endpoint: DEFAULT_NSFW_ENDPOINT },
      });
      assert.equal(decision.outcome, "reject");
    });

    it("accepts and tags when score >= threshold and nsfw mode is on", async () => {
      const decision = await classifyAndDecide("u", {
        nsfwModeEnabled: true,
        overrides: { falImpl: fakeFal(DEFAULT_NSFW_THRESHOLD + 0.05), endpoint: DEFAULT_NSFW_ENDPOINT },
      });
      assert.equal(decision.outcome, "accept");
      if (decision.outcome === "accept") assert.equal(decision.isNsfwTag, true);
    });

    it("returns error when the classifier throws", async () => {
      const failingFal = {
        subscribe: async () => { throw new Error("fal-down"); },
      };
      const decision = await classifyAndDecide("u", {
        nsfwModeEnabled: false,
        overrides: { falImpl: failingFal, endpoint: DEFAULT_NSFW_ENDPOINT },
      });
      assert.equal(decision.outcome, "error");
    });
  });
});
