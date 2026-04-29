import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderCanonical, renderPersonalized } from "../lib/renderCanonical.js";

// ── renderCanonical ───────────────────────────────────────────────────────────

describe("renderCanonical", () => {
  it("replaces {NAME} with 'Alex'", () => {
    assert.equal(renderCanonical("{NAME} is great"), "Alex is great");
  });

  it("replaces all pronoun tokens with they/them canonical forms", () => {
    assert.equal(renderCanonical("{SUBJ}"), "they");
    assert.equal(renderCanonical("{Subj}"), "They");
    assert.equal(renderCanonical("{OBJ}"), "them");
    assert.equal(renderCanonical("{Obj}"), "Them");
    assert.equal(renderCanonical("{POSS}"), "their");
    assert.equal(renderCanonical("{Poss}"), "Their");
    assert.equal(renderCanonical("{POSS_PRO}"), "theirs");
    assert.equal(renderCanonical("{Poss_Pro}"), "Theirs");
    assert.equal(renderCanonical("{REFL}"), "themselves");
    assert.equal(renderCanonical("{Refl}"), "Themselves");
  });

  it("picks the plural (right) side of {singular|plural} alternations", () => {
    assert.equal(renderCanonical("{has|have}"), "have");
    assert.equal(renderCanonical("{doesn't|don't}"), "don't");
    assert.equal(renderCanonical("{was|were}"), "were");
    assert.equal(renderCanonical("{is|are}"), "are");
  });

  it("leaves unknown single-word tokens unchanged", () => {
    assert.equal(renderCanonical("{UNKNOWN}"), "{UNKNOWN}");
    assert.equal(renderCanonical("{fooBar}"), "{fooBar}");
  });

  it("handles a full sentence with multiple token types", () => {
    assert.equal(
      renderCanonical("{NAME} {has|have} done {POSS} work {REFL}."),
      "Alex have done their work themselves.",
    );
  });

  it("replaces all occurrences of the same token", () => {
    assert.equal(renderCanonical("{NAME} knows {NAME}"), "Alex knows Alex");
    assert.equal(renderCanonical("{SUBJ} and {SUBJ}"), "they and they");
  });

  it("preserves plain text with no tokens", () => {
    assert.equal(renderCanonical("no tokens here"), "no tokens here");
  });

  it("returns empty string unchanged", () => {
    assert.equal(renderCanonical(""), "");
  });
});

// ── renderPersonalized ────────────────────────────────────────────────────────

describe("renderPersonalized — he/him (singular)", () => {
  it("renders {NAME}", () => {
    assert.equal(renderPersonalized("{NAME}", "Dave", "he/him"), "Dave");
  });

  it("renders all lowercase pronoun tokens", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Dave", "he/him"), "he");
    assert.equal(renderPersonalized("{OBJ}", "Dave", "he/him"), "him");
    assert.equal(renderPersonalized("{POSS}", "Dave", "he/him"), "his");
    assert.equal(renderPersonalized("{POSS_PRO}", "Dave", "he/him"), "his");
    assert.equal(renderPersonalized("{REFL}", "Dave", "he/him"), "himself");
  });

  it("renders capitalized pronoun tokens", () => {
    assert.equal(renderPersonalized("{Subj}", "Dave", "he/him"), "He");
    assert.equal(renderPersonalized("{Obj}", "Dave", "he/him"), "Him");
    assert.equal(renderPersonalized("{Poss}", "Dave", "he/him"), "His");
    assert.equal(renderPersonalized("{Poss_Pro}", "Dave", "he/him"), "His");
    assert.equal(renderPersonalized("{Refl}", "Dave", "he/him"), "Himself");
  });

  it("uses singular verb form for {singular|plural}", () => {
    assert.equal(renderPersonalized("{has|have}", "Dave", "he/him"), "has");
    assert.equal(renderPersonalized("{doesn't|don't}", "Dave", "he/him"), "doesn't");
    assert.equal(renderPersonalized("{was|were}", "Dave", "he/him"), "was");
  });

  it("handles a complete sentence", () => {
    assert.equal(
      renderPersonalized("{NAME} {has|have} done {POSS} work {REFL}.", "Dave", "he/him"),
      "Dave has done his work himself.",
    );
  });
});

describe("renderPersonalized — she/her (singular)", () => {
  it("renders all pronoun tokens", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Alice", "she/her"), "she");
    assert.equal(renderPersonalized("{OBJ}", "Alice", "she/her"), "her");
    assert.equal(renderPersonalized("{POSS}", "Alice", "she/her"), "her");
    assert.equal(renderPersonalized("{POSS_PRO}", "Alice", "she/her"), "hers");
    assert.equal(renderPersonalized("{REFL}", "Alice", "she/her"), "herself");
  });

  it("uses singular verb form", () => {
    assert.equal(renderPersonalized("{has|have}", "Alice", "she/her"), "has");
    assert.equal(renderPersonalized("{was|were}", "Alice", "she/her"), "was");
  });
});

describe("renderPersonalized — they/them (plural)", () => {
  it("renders all pronoun tokens", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Sam", "they/them"), "they");
    assert.equal(renderPersonalized("{OBJ}", "Sam", "they/them"), "them");
    assert.equal(renderPersonalized("{POSS}", "Sam", "they/them"), "their");
    assert.equal(renderPersonalized("{POSS_PRO}", "Sam", "they/them"), "theirs");
    assert.equal(renderPersonalized("{REFL}", "Sam", "they/them"), "themselves");
  });

  it("uses plural verb form", () => {
    assert.equal(renderPersonalized("{has|have}", "Sam", "they/them"), "have");
    assert.equal(renderPersonalized("{doesn't|don't}", "Sam", "they/them"), "don't");
    assert.equal(renderPersonalized("{was|were}", "Sam", "they/them"), "were");
  });
});

describe("renderPersonalized — edge cases", () => {
  it("null pronouns defaults to they/them (plural)", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Sam", null), "they");
    assert.equal(renderPersonalized("{has|have}", "Sam", null), "have");
  });

  it("undefined pronouns defaults to they/them (plural)", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Sam", undefined), "they");
  });

  it("unknown token is left unchanged", () => {
    assert.equal(renderPersonalized("{UNKNOWN}", "Dave", "he/him"), "{UNKNOWN}");
  });

  it("replaces all occurrences of the same token", () => {
    assert.equal(
      renderPersonalized("{NAME} met {NAME}", "Dave", "he/him"),
      "Dave met Dave",
    );
  });

  it("returns empty string unchanged", () => {
    assert.equal(renderPersonalized("", "Dave", "he/him"), "");
  });
});
