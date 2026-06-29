/**
 * Unit tests for the shared hashtag persistence helpers. No DB / no model —
 * pure functions that every server-side hashtag path now funnels through.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeHashtagsForPersistence,
  resolveTagsForApproval,
} from "../lib/hashtags.js";

describe("sanitizeHashtagsForPersistence", () => {
  it("lowercases and strips '#' + symbols (matches normalizeHashtag)", () => {
    assert.deepEqual(sanitizeHashtagsForPersistence(["#Coffee!"], { limit: 10 }), ["coffee"]);
  });

  it("strips underscores too — unifies on normalizeHashtag's rule", () => {
    assert.deepEqual(sanitizeHashtagsForPersistence(["multi_word"], { limit: 10 }), ["multiword"]);
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(sanitizeHashtagsForPersistence(["  strength  "], { limit: 10 }), ["strength"]);
  });

  it("drops empty and non-string values defensively", () => {
    const input = ["", "   ", 5, null, undefined, {}, "earth"] as unknown[];
    assert.deepEqual(sanitizeHashtagsForPersistence(input, { limit: 10 }), ["earth"]);
  });

  it("removes denied subject-name / app-name tags", () => {
    assert.deepEqual(
      sanitizeHashtagsForPersistence(["alex", "overhype", "overhypeme", "strength"], { limit: 10 }),
      ["strength"],
    );
  });

  it("dedupes on normalized form, preserving first-seen order", () => {
    assert.deepEqual(
      sanitizeHashtagsForPersistence(["Coffee", "#coffee", "COFFEE!", "tea"], { limit: 10 }),
      ["coffee", "tea"],
    );
  });

  it("applies the cap AFTER sanitize + dedupe", () => {
    assert.deepEqual(sanitizeHashtagsForPersistence(["a", "a", "b", "c", "d"], { limit: 2 }), ["a", "b"]);
  });
});

describe("resolveTagsForApproval", () => {
  it("submitter tags win over enrichment fallback", () => {
    assert.deepEqual(
      resolveTagsForApproval(["coffee", "strength"], ["legendary", "pushups"]),
      ["coffee", "strength"],
    );
  });

  it("falls back to enrichment when the submitter gave no tags", () => {
    assert.deepEqual(resolveTagsForApproval([], ["legendary", "pushups"]), ["legendary", "pushups"]);
  });

  it("falls back when submitter tags SANITIZE to empty (only denied/invalid) — never untagged", () => {
    assert.deepEqual(
      resolveTagsForApproval(["alex", "overhype", "!!!"], ["strength", "legendary", "pushups"]),
      ["strength", "legendary", "pushups"],
    );
  });

  it("normalizes the winning submitter tags", () => {
    assert.deepEqual(resolveTagsForApproval(["#Strength", "strength!", "Legendary"], ["x"]), ["strength", "legendary"]);
  });

  it("handles null / undefined sources", () => {
    assert.deepEqual(resolveTagsForApproval(null, null), []);
    assert.deepEqual(resolveTagsForApproval(undefined, ["earth"]), ["earth"]);
  });
});
