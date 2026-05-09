/**
 * Phase-4 validator unit tests.
 *
 * Pure (no DB, no canvas) coverage of:
 *   - Pronoun allowlist enforcement
 *   - Name length, character class, control-char rejection
 *   - Mode derivation from imageSource + imageTransform
 *   - SaveMemeBody / RenderRequestBody round-trips
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PRONOUN_ALLOWLIST,
  PronounsSchema,
  NameSchema,
  RenderRequestBody,
  SaveMemeBody,
  deriveRenderMode,
} from "../lib/validators/memeBuilder.js";

describe("Phase 4 — PronounsSchema", () => {
  for (const allowed of PRONOUN_ALLOWLIST) {
    it(`accepts ${allowed}`, () => {
      const r = PronounsSchema.safeParse(allowed);
      assert.equal(r.success, true);
      if (r.success) assert.equal(r.data, allowed);
    });
  }

  it("normalises mixed case before checking the allowlist", () => {
    const r = PronounsSchema.safeParse("She/Her");
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data, "she/her");
  });

  it("rejects unknown pronouns", () => {
    const r = PronounsSchema.safeParse("foo/bar");
    assert.equal(r.success, false);
  });

  it("rejects empty input", () => {
    assert.equal(PronounsSchema.safeParse("").success, false);
  });

  it("rejects oversized input", () => {
    assert.equal(PronounsSchema.safeParse("a".repeat(100)).success, false);
  });
});

describe("Phase 4 — NameSchema", () => {
  it("accepts a normal name", () => {
    const r = NameSchema.safeParse("Alex");
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data, "Alex");
  });

  it("accepts a name with spaces, apostrophes, hyphens, periods", () => {
    const r = NameSchema.safeParse("Mary-Anne O'Neill Jr.");
    assert.equal(r.success, true);
  });

  it("collapses internal whitespace runs", () => {
    const r = NameSchema.safeParse("Alex   Smith");
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data, "Alex Smith");
  });

  it("rejects newlines", () => {
    assert.equal(NameSchema.safeParse("Alex\nSmith").success, false);
  });

  it("rejects carriage returns and tabs", () => {
    assert.equal(NameSchema.safeParse("Alex\rSmith").success, false);
    assert.equal(NameSchema.safeParse("Alex\tSmith").success, false);
  });

  it("rejects names of 51 chars or longer", () => {
    assert.equal(NameSchema.safeParse("A".repeat(51)).success, false);
  });

  it("rejects empty input", () => {
    assert.equal(NameSchema.safeParse("").success, false);
  });

  it("rejects whitespace-only input", () => {
    // Whitespace-only fails because the regex requires at least one
    // letter / digit / punctuation character before the trim collapses it.
    assert.equal(NameSchema.safeParse("   ").success, false);
  });

  it("rejects HTML angle brackets and shell metacharacters", () => {
    assert.equal(NameSchema.safeParse("<script>").success, false);
    assert.equal(NameSchema.safeParse("Alex; rm -rf").success, false);
  });

  it("accepts non-ASCII letters", () => {
    const r = NameSchema.safeParse("José Núñez");
    assert.equal(r.success, true);
  });
});

describe("Phase 4 — deriveRenderMode", () => {
  it("returns stock for template imageSource", () => {
    assert.equal(deriveRenderMode({ type: "template", templateId: "action" }), "stock");
  });
  it("returns stock for stock imageSource", () => {
    assert.equal(deriveRenderMode({ type: "stock", pexelsPhotoId: 123 }), "stock");
  });
  it("returns self-upload for upload imageSource without pulid transform", () => {
    assert.equal(deriveRenderMode({ type: "upload", uploadKey: "/objects/foo" }), "self-upload");
  });
  it("returns self-upload for identity imageSource", () => {
    assert.equal(deriveRenderMode({ type: "identity" }), "self-upload");
  });
  it("returns pulid when imageTransform is pulid, regardless of imageSource", () => {
    assert.equal(
      deriveRenderMode({ type: "upload", uploadKey: "/objects/foo" }, "pulid"),
      "pulid",
    );
  });
  it("returns the imageSource-derived mode for pulid_fallback_text", () => {
    // pulid_fallback_text means the PuLID generator hit a no-face fallback —
    // the resulting image is text-only, so it isn't a real PuLID render and
    // is gated as self-upload, not legendary-only.
    assert.equal(
      deriveRenderMode({ type: "upload", uploadKey: "/objects/foo" }, "pulid_fallback_text"),
      "self-upload",
    );
  });
});

describe("Phase 4 — RenderRequestBody", () => {
  it("accepts a minimal stock-mode request", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "stock", pexelsPhotoId: 42 },
      name: "Alex",
      pronouns: "they/them",
    });
    assert.equal(r.success, true);
  });

  it("rejects a body missing name", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "stock", pexelsPhotoId: 42 },
      pronouns: "they/them",
    });
    assert.equal(r.success, false);
  });

  it("rejects a body with disallowed pronouns", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "stock", pexelsPhotoId: 42 },
      name: "Alex",
      pronouns: "they/he",
    });
    assert.equal(r.success, false);
  });

  it("rejects a body with malformed imageSource", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "upload" }, // missing uploadKey
      name: "Alex",
      pronouns: "they/them",
    });
    assert.equal(r.success, false);
  });

  it("rejects an uploadKey that doesn't begin with /objects/", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "upload", uploadKey: "foo/bar" },
      name: "Alex",
      pronouns: "they/them",
    });
    assert.equal(r.success, false);
  });
});

describe("Phase 4 — SaveMemeBody", () => {
  it("makes name and pronouns optional (server falls back to req.user)", () => {
    const r = SaveMemeBody.safeParse({
      factId: 1,
      imageSource: { type: "template", templateId: "action" },
    });
    assert.equal(r.success, true);
  });

  it("still validates pronouns when provided", () => {
    const r = SaveMemeBody.safeParse({
      factId: 1,
      imageSource: { type: "template", templateId: "action" },
      pronouns: "garbage/value",
    });
    assert.equal(r.success, false);
  });

  it("accepts imageTransform = pulid", () => {
    const r = SaveMemeBody.safeParse({
      factId: 1,
      imageSource: { type: "upload", uploadKey: "/objects/foo" },
      imageTransform: "pulid",
    });
    assert.equal(r.success, true);
  });
});
