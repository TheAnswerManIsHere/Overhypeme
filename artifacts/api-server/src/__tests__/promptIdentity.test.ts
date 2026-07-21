/**
 * Unit tests for the prompt-identity snapshot resolution logic (plan §11.5).
 *
 * Pure functions only — no DB. `resolvePromptIdentityForUser` (the DB-backed
 * path) is exercised by the attempt-construction integration tests in a later
 * slice; this file locks in the reduction rules and the snapshot validator.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  graphemeSafeTruncate,
  reducePromptName,
  clampPronouns,
  canonicalPromptIdentity,
  resolvePromptIdentityFromSample,
  resolvePromptIdentityForWorkbench,
  isValidPromptIdentitySnapshot,
  PROMPT_IDENTITY_SNAPSHOT_VERSION,
} from "../lib/imagePrompt/promptIdentity";
import { RENDERED_IDENTITY_NAME_MAX } from "@workspace/api-zod";
import { CANONICAL_NAME } from "../lib/renderCanonical";

describe("graphemeSafeTruncate", () => {
  it("returns short strings unchanged", () => {
    assert.equal(graphemeSafeTruncate("David", 20), "David");
  });

  it("truncates to the exact grapheme count for plain ASCII", () => {
    assert.equal(graphemeSafeTruncate("Alexandratown", 5), "Alexa");
  });

  it("never splits a surrogate-pair emoji mid-codepoint", () => {
    const s = "David🎉🎉🎉🎉🎉"; // 5 chars + 5 astral emoji = 10 grapheme clusters
    const truncated = graphemeSafeTruncate(s, 6);
    // Every emoji in the result must be a complete, valid code point (no lone surrogate).
    for (const ch of truncated) {
      const cp = ch.codePointAt(0)!;
      assert.ok(!(cp >= 0xd800 && cp <= 0xdfff), `lone surrogate found in truncated output: ${truncated}`);
    }
  });

  it("handles empty input and non-positive max", () => {
    assert.equal(graphemeSafeTruncate("", 20), "");
    assert.equal(graphemeSafeTruncate("David", 0), "");
  });
});

describe("reducePromptName", () => {
  it("prefers firstName when present", () => {
    assert.equal(reducePromptName({ firstName: "David", displayName: "David Franklin" }), "David");
  });

  it("falls back to the first token of displayName when firstName is absent", () => {
    assert.equal(reducePromptName({ displayName: "David Franklin" }), "David");
  });

  it("falls back to the canonical name when both are absent/empty", () => {
    assert.equal(reducePromptName({}), CANONICAL_NAME);
    assert.equal(reducePromptName({ firstName: "", displayName: "" }), CANONICAL_NAME);
  });

  it("bounds a long firstName to RENDERED_IDENTITY_NAME_MAX", () => {
    const long = "X".repeat(50);
    const reduced = reducePromptName({ firstName: long });
    assert.equal(reduced.length, RENDERED_IDENTITY_NAME_MAX);
  });

  it("reduces a multi-word displayName to only its first token, not a truncated fragment of the whole string", () => {
    assert.equal(reducePromptName({ displayName: "Alexandra Smith-Jones" }), "Alexandra");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(reducePromptName({ firstName: "  David  " }), "David");
  });
});

describe("clampPronouns", () => {
  it("returns null for null/undefined input", () => {
    assert.equal(clampPronouns(null), null);
    assert.equal(clampPronouns(undefined), null);
  });

  it("preserves a normally-sized pronoun string byte-for-byte", () => {
    assert.equal(clampPronouns("he/him"), "he/him");
    assert.equal(clampPronouns("they/them"), "they/them");
  });

  it("clamps an oversized side without touching a normal side", () => {
    const oversized = "x".repeat(40);
    const result = clampPronouns(`${oversized}/him`)!;
    const [subj, obj] = result.split("/");
    assert.equal(subj!.length, RENDERED_IDENTITY_NAME_MAX);
    assert.equal(obj, "him");
  });
});

describe("snapshot builders", () => {
  it("canonicalPromptIdentity has the canonical_fallback source and no pronouns", () => {
    const snap = canonicalPromptIdentity();
    assert.equal(snap.name, CANONICAL_NAME);
    assert.equal(snap.pronouns, null);
    assert.equal(snap.source, "canonical_fallback");
    assert.equal(snap.version, PROMPT_IDENTITY_SNAPSHOT_VERSION);
  });

  it("resolvePromptIdentityFromSample reduces the sample name and tags the source", () => {
    const snap = resolvePromptIdentityFromSample({ name: "David Franklin", pronouns: "he/him" }, "review_sample");
    assert.equal(snap.name, "David");
    assert.equal(snap.pronouns, "he/him");
    assert.equal(snap.source, "review_sample");
  });

  it("resolvePromptIdentityFromSample supports eval_sample too", () => {
    const snap = resolvePromptIdentityFromSample({ name: "Sam Rivera", pronouns: "she/her" }, "eval_sample");
    assert.equal(snap.source, "eval_sample");
    assert.equal(snap.name, "Sam");
  });

  it("resolvePromptIdentityForWorkbench reduces the test name and tags workbench (distinct from canonical_fallback)", () => {
    const snap = resolvePromptIdentityForWorkbench("David Franklin", "he/him");
    assert.equal(snap.name, "David");
    assert.equal(snap.source, "workbench");
    assert.notEqual(snap.source, "canonical_fallback");
  });
});

describe("isValidPromptIdentitySnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    assert.equal(
      isValidPromptIdentitySnapshot({ version: 1, name: "David", pronouns: "he/him", source: "user" }),
      true,
    );
  });

  it("accepts null pronouns", () => {
    assert.equal(
      isValidPromptIdentitySnapshot({ version: 1, name: "Alex", pronouns: null, source: "canonical_fallback" }),
      true,
    );
  });

  it("rejects a wrong version", () => {
    assert.equal(
      isValidPromptIdentitySnapshot({ version: 2, name: "David", pronouns: null, source: "user" }),
      false,
    );
  });

  it("rejects an empty name", () => {
    assert.equal(
      isValidPromptIdentitySnapshot({ version: 1, name: "", pronouns: null, source: "user" }),
      false,
    );
  });

  it("rejects an unknown source", () => {
    assert.equal(
      isValidPromptIdentitySnapshot({ version: 1, name: "David", pronouns: null, source: "bogus" }),
      false,
    );
  });

  it("rejects non-object / null / a bare cast target", () => {
    assert.equal(isValidPromptIdentitySnapshot(null), false);
    assert.equal(isValidPromptIdentitySnapshot(undefined), false);
    assert.equal(isValidPromptIdentitySnapshot("David"), false);
    assert.equal(isValidPromptIdentitySnapshot({}), false);
  });
});
