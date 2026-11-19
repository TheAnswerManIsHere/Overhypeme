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
  uploadForClassifier,
  CLASSIFIER_UPLOAD_LIFECYCLE,
  NO_REQUEST_HISTORY_HEADERS,
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

// Launch Phase 14, increment 6b — vendor expiry: the member's photo fal is
// given to classify expires after an hour, and the classification request is
// kept out of fal's 90-day request history.
describe("moderation/nsfwClassifier — what fal keeps", () => {
  it("uploads the photo with an expiry", async () => {
    const seen: unknown[] = [];
    const url = await uploadForClassifier(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), async (_file, opts) => {
      seen.push(opts);
      return "https://fal.example/files/x";
    });
    assert.equal(url, "https://fal.example/files/x");
    assert.deepEqual(seen, [{ lifecycle: { expiresIn: "1h" } }]);
    assert.deepEqual(CLASSIFIER_UPLOAD_LIFECYCLE, { expiresIn: "1h" });
  });

  it("asks fal not to store the classification request", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await classifyNsfwByUrl("https://fal.example/files/x", {
      endpoint: DEFAULT_NSFW_ENDPOINT,
      timeoutMs: 1000,
      falImpl: { subscribe: async (_m, opts) => { seen.push(opts); return { data: { nsfw_score: 0.1 } }; } },
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].headers, { "X-Fal-Store-IO": "0" });
    assert.deepEqual(NO_REQUEST_HISTORY_HEADERS, { "X-Fal-Store-IO": "0" });
  });

  it("the upload route classifies through the expiring upload, never a bare fal.storage.upload", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../lib/userImageUpload.ts", import.meta.url), "utf8");
    assert.match(src, /await uploadForClassifier\(blob\)/);
    assert.doesNotMatch(src, /storage\.upload\(/);
  });
});
