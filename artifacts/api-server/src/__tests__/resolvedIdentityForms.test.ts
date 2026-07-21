/**
 * Unit tests for the shared resolved-identity-forms contract
 * (lib/api-zod/src/resolvedIdentityForms.ts).
 *
 * The load-bearing case here is grammatical number: the historical rule
 * (preserved from the pre-refactor `renderPersonalized`) is "singular UNLESS
 * the subject pronoun is literally 'they'" — not "singular for he/she,
 * plural for everything else." A neopronoun subject (e.g. "xe/xem") must
 * render SINGULAR verbs, same as he/she, because it isn't literally "they".
 * Getting this backwards was caught during the refactor by this exact test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveIdentityForms,
  renderTemplateWithIdentityForms,
  possessive,
  unresolvedSimpleTokens,
} from "@workspace/api-zod";

describe("resolveIdentityForms — grammatical number", () => {
  it("is plural ONLY for the literal subject 'they'", () => {
    assert.equal(resolveIdentityForms("Alex", "they/them").grammaticalNumber, "plural");
  });

  it("is singular for he/she", () => {
    assert.equal(resolveIdentityForms("David", "he/him").grammaticalNumber, "singular");
    assert.equal(resolveIdentityForms("Sam", "she/her").grammaticalNumber, "singular");
  });

  it("is singular for a neopronoun subject (NOT plural — the near-miss case)", () => {
    assert.equal(resolveIdentityForms("Robin", "xe/xem").grammaticalNumber, "singular");
    assert.equal(resolveIdentityForms("Robin", "ze/zir").grammaticalNumber, "singular");
  });

  it("is singular for malformed/unrecognized pronoun input", () => {
    assert.equal(resolveIdentityForms("Robin", "???").grammaticalNumber, "singular");
  });

  it("defaults to they/them (plural) when pronouns is absent", () => {
    assert.equal(resolveIdentityForms("Alex", null).grammaticalNumber, "plural");
    assert.equal(resolveIdentityForms("Alex", undefined).grammaticalNumber, "plural");
  });
});

describe("resolveIdentityForms — token forms", () => {
  it("resolves he/him to the historical possessive/reflexive set", () => {
    const f = resolveIdentityForms("David", "he/him").tokens;
    assert.equal(f.SUBJ, "he"); assert.equal(f.Subj, "He");
    assert.equal(f.OBJ, "him"); assert.equal(f.Obj, "Him");
    assert.equal(f.POSS, "his"); assert.equal(f.Poss, "His");
    assert.equal(f.POSS_PRO, "his"); assert.equal(f.Poss_Pro, "His");
    assert.equal(f.REFL, "himself"); assert.equal(f.Refl, "Himself");
  });

  it("resolves she/her to the historical possessive/reflexive set", () => {
    const f = resolveIdentityForms("Sam", "she/her").tokens;
    assert.equal(f.POSS, "her"); assert.equal(f.POSS_PRO, "hers"); assert.equal(f.REFL, "herself");
  });

  it("resolves any non-he/she subject to the they-style possessive/reflexive set", () => {
    const f = resolveIdentityForms("Robin", "xe/xem").tokens;
    assert.equal(f.POSS, "their"); assert.equal(f.POSS_PRO, "theirs"); assert.equal(f.REFL, "themselves");
  });

  it("NAME and NAME_POSSESSIVE reflect the given name", () => {
    const f = resolveIdentityForms("Chris", "he/him").tokens;
    assert.equal(f.NAME, "Chris");
    assert.equal(f.NAME_POSSESSIVE, "Chris's");
  });

  it("every grammar simple token has a resolved-forms key (no drift)", () => {
    assert.deepEqual(unresolvedSimpleTokens(), []);
  });
});

describe("renderTemplateWithIdentityForms", () => {
  it("substitutes simple tokens and picks the branch per grammaticalNumber", () => {
    const singular = resolveIdentityForms("David", "he/him");
    assert.equal(
      renderTemplateWithIdentityForms("{NAME} {gives|give} {POSS} best.", singular),
      "David gives his best.",
    );
    const plural = resolveIdentityForms("Alex", "they/them");
    assert.equal(
      renderTemplateWithIdentityForms("{NAME} {gives|give} {POSS} best.", plural),
      "Alex give their best.",
    );
  });

  it("neopronoun subject renders the SINGULAR conjugation branch (the near-miss case)", () => {
    // POSS resolves to the they-style "their" (not he/she), but the VERB still
    // takes the singular branch — "xe" is not literally "they".
    const neo = resolveIdentityForms("Robin", "xe/xem");
    assert.equal(
      renderTemplateWithIdentityForms("{NAME} {gives|give} {POSS} best.", neo),
      "Robin gives their best.",
    );
  });

  it("fixes indefinite-article agreement against the resolved name", () => {
    const alex = resolveIdentityForms("Alex", "they/them");
    assert.equal(renderTemplateWithIdentityForms("a {NAME} enters", alex), "an Alex enters");
    const david = resolveIdentityForms("David", "he/him");
    assert.equal(renderTemplateWithIdentityForms("a {NAME} enters", david), "a David enters");
  });

  it("leaves an unrecognized token untouched", () => {
    const forms = resolveIdentityForms("Alex", "they/them");
    assert.equal(renderTemplateWithIdentityForms("{UNKNOWN_TOKEN}", forms), "{UNKNOWN_TOKEN}");
  });
});

describe("possessive", () => {
  it("always appends 's, including names ending in s", () => {
    assert.equal(possessive("Chris"), "Chris's");
    assert.equal(possessive("James"), "James's");
  });

  it("returns empty string for empty input", () => {
    assert.equal(possessive(""), "");
  });
});
