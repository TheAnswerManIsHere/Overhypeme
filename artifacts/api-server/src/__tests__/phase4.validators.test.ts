/**
 * Phase-4 validator unit tests.
 *
 * Pure (no DB, no canvas) coverage of:
 *   - Pronoun allowlist enforcement
 *   - Name length, character class, control-char rejection
 *   - Mode derivation from imageSource
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

  it("normalises a slash form's case", () => {
    const r = PronounsSchema.safeParse("She/Her");
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data, "she/her");
  });

  // The account's own pronoun rule (identity-flow Phase 2): any slash form
  // and any six-part custom set an account can store.
  it("accepts any slash form an account accepts", () => {
    const r = PronounsSchema.safeParse("fae/faer");
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data, "fae/faer");
  });

  it("accepts a custom six-part set, keeping its forms", () => {
    const r = PronounsSchema.safeParse("Xe|xem|xyr|xyrs|xemself|s");
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data, "Xe|xem|xyr|xyrs|xemself|s");
  });

  it("rejects a malformed custom set", () => {
    assert.equal(PronounsSchema.safeParse("xe|xem|xyr").success, false);
    assert.equal(PronounsSchema.safeParse("xe|xem|xyr|xyrs|xemself|q").success, false);
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

  // The shared name rule turns any whitespace run into one space, so a line
  // break or tab never reaches a prompt or a caption (identity-flow Phase 2;
  // before, this schema refused them).
  it("turns newlines, carriage returns and tabs into a single space", () => {
    for (const raw of ["Alex\nSmith", "Alex\rSmith", "Alex\tSmith", "Alex\r\n Smith"]) {
      const r = NameSchema.safeParse(raw);
      assert.equal(r.success, true, JSON.stringify(raw));
      assert.equal(r.success && r.data, "Alex Smith");
    }
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
  it("returns self-upload for upload imageSource", () => {
    assert.equal(deriveRenderMode({ type: "upload", uploadKey: "/objects/foo" }), "self-upload");
  });
  it("returns self-upload for identity imageSource", () => {
    assert.equal(deriveRenderMode({ type: "identity" }), "self-upload");
  });
});

describe("Phase 4 — RenderRequestBody", () => {
  it("accepts a minimal upload request", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "upload", uploadKey: "/objects/uploads/x.jpg" },
      name: "Alex",
      pronouns: "they/them",
    });
    assert.equal(r.success, true);
  });

  it("rejects a body missing name", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "upload", uploadKey: "/objects/uploads/x.jpg" },
      pronouns: "they/them",
    });
    assert.equal(r.success, false);
  });

  it("rejects a body with disallowed pronouns", () => {
    const r = RenderRequestBody.safeParse({
      factId: 1,
      imageSource: { type: "upload", uploadKey: "/objects/uploads/x.jpg" },
      name: "Alex",
      pronouns: "xe|xem",
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
      imageSource: { type: "upload", uploadKey: "/objects/uploads/x.jpg" },
    });
    assert.equal(r.success, true);
  });

  it("still validates pronouns when provided", () => {
    const r = SaveMemeBody.safeParse({
      factId: 1,
      imageSource: { type: "upload", uploadKey: "/objects/uploads/x.jpg" },
      pronouns: "one two three four five",
    });
    assert.equal(r.success, false);
  });

  it("strips a stale imageTransform: no save writes a PuLID label since removal 3", () => {
    const r = SaveMemeBody.safeParse({
      factId: 1,
      imageSource: { type: "upload", uploadKey: "/objects/foo" },
      imageTransform: "pulid",
    });
    assert.equal(r.success, true);
    assert.equal(r.success && "imageTransform" in r.data, false);
  });
});
