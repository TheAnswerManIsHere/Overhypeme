/**
 * Unit tests for the shared prompt-content detectors (PR-A, plan §6).
 *
 * These guard two boundaries: the compiler-owned-language detector must catch
 * identity/reference/text-policy prose (so a planner can't re-author it and a
 * moderator gets warned), and the medium-claim detector must catch explicit
 * artistic-medium claims while NOT firing on mood/staging words — a false
 * positive there would block a valid physical-lighting plan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectOwnedLanguage, detectMediumClaim } from "@workspace/api-zod";

describe("detectOwnedLanguage", () => {
  it("flags identity/likeness preservation prose", () => {
    const f = detectOwnedLanguage("Preserve the recognizable face and likeness of the subject.");
    assert.equal(f?.category, "identity");
    assert.ok(f && f.matchedText.length > 0);
  });

  it("flags reference-image operational language", () => {
    assert.equal(detectOwnedLanguage("Use the reference photo as the identity source.")?.category, "reference");
    assert.equal(detectOwnedLanguage("This is an image-to-image edit.")?.category, "reference");
  });

  it("flags readable-text / logo / watermark policy", () => {
    assert.equal(detectOwnedLanguage("No watermarks or brand marks in the image.")?.category, "text_policy");
    assert.equal(detectOwnedLanguage("Keep it free of any readable text.")?.category, "text_policy");
  });

  it("returns null for ordinary scene description", () => {
    assert.equal(detectOwnedLanguage("David sits calmly in a folding chair beside a dead cobra."), null);
    assert.equal(detectOwnedLanguage(""), null);
  });

  it("returns the earliest-positioned finding with its matched text", () => {
    // reference phrase comes first in the string
    const f = detectOwnedLanguage("Use the source image; preserve the same person's identity.");
    assert.equal(f?.category, "reference");
  });
});

describe("detectMediumClaim", () => {
  it("flags explicit artistic-medium claims", () => {
    for (const s of [
      "Illustrated in detailed anime style.",
      "Rendered as a classical oil painting.",
      "bold cel-shaded rendering",
      "32-bit pixel art look",
      "hyper-photorealistic photograph",
      "photorealistic rendering of the scene",
    ]) {
      assert.ok(detectMediumClaim(s), `expected medium claim in: ${s}`);
    }
  });

  it("does NOT fire on mood / staging / physical-lighting words", () => {
    for (const s of [
      "dramatic cinematic staging with deep shadows",
      "a tense, moody nighttime atmosphere",
      "cold blue emergency lighting",
      "gritty, high-contrast look",
      "an epic sense of scale",
      "vibrant color and warm highlights",
    ]) {
      assert.equal(detectMediumClaim(s), null, `false positive on: ${s}`);
    }
  });

  it("does not fire on bare 'photorealistic' without a rendering claim", () => {
    // bare adjective is ambiguous with quality; only explicit rendering claims fire
    assert.equal(detectMediumClaim("the scene looks almost photorealistic in places"), null);
  });

  it("returns null for empty input", () => {
    assert.equal(detectMediumClaim(""), null);
  });
});
