/**
 * Unit tests for the shared hashtag persistence helpers. No DB / no model —
 * pure functions that every server-side hashtag path now funnels through.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeHashtagsForPersistence,
  resolveFinalApprovalTags,
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

  it("removes generic-humor tags (every fact is meant to be funny → zero signal)", () => {
    assert.deepEqual(
      sanitizeHashtagsForPersistence(
        ["humor", "funny", "joke", "comedy", "lol", "hilarious", "coffee"],
        { limit: 10 },
      ),
      ["coffee"],
    );
  });

  it("matches humor denials on normalized form (#Funny!, HUMOR)", () => {
    assert.deepEqual(
      sanitizeHashtagsForPersistence(["#Funny!", "HUMOR", "strength"], { limit: 10 }),
      ["strength"],
    );
  });

  it("keeps real topics that merely resemble humor words (e.g. 'comedian' denied, 'comet' kept)", () => {
    assert.deepEqual(
      sanitizeHashtagsForPersistence(["comedian", "comet"], { limit: 10 }),
      ["comet"],
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

describe("resolveFinalApprovalTags (approve-body authoritative)", () => {
  // Present body wins over the submitter's tags, sanitized verbatim.
  it("uses the approve-body list when present, normalized/deduped", () => {
    assert.deepEqual(resolveFinalApprovalTags(["Coffee", "strength!"], ["ignored"]), ["coffee", "strength"]);
  });

  // Present-but-empty is a deliberate "no tags" — does NOT fall back (caller then
  // rejects with HASHTAGS_REQUIRED).
  it("present empty array does NOT fall back (stays empty)", () => {
    assert.deepEqual(resolveFinalApprovalTags([], ["coffee"]), []);
  });

  // Present but only denied/invalid → empty (caller rejects).
  it("present denied/invalid-only sanitizes to empty (no fallback)", () => {
    assert.deepEqual(resolveFinalApprovalTags(["alex", "overhype", "!!!"], ["coffee"]), []);
  });

  // Absent body → legacy fallback: the submitter's tags.
  it("absent body falls back to submitter tags, normalized", () => {
    assert.deepEqual(resolveFinalApprovalTags(undefined, ["#Strength", "strength!", "Legendary"]), ["strength", "legendary"]);
  });
  it("absent body with no valid submitter tags → empty (caller rejects); nothing else is generated", () => {
    assert.deepEqual(resolveFinalApprovalTags(undefined, ["alex"]), []);
    assert.deepEqual(resolveFinalApprovalTags(undefined, null), []);
    assert.deepEqual(resolveFinalApprovalTags(undefined, undefined), []);
  });
});
