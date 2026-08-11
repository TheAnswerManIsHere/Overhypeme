import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderCanonical,
  renderPersonalized,
  hasUnresolvedFactTokens,
  hasSubjectIdentityToken,
  isSubjectNameSemanticEntity,
  stripSubjectNameSemanticEntities,
} from "../lib/renderCanonical.js";

/** Build a minimal semantic-entity-shaped object for the guard tests. */
function ent(surfaceText: string, normalizedText = surfaceText.toLowerCase()) {
  return { surfaceText, normalizedText };
}

// ── {can|can} collapse is output-preserving ──────────────────────────────────
// Locks in the safety claim behind collapseIdenticalConjugationBranches: a
// duplicate conjugation pair and its collapsed plain form render identically, so
// dropping the braces can never change output.

describe("identical conjugation branch renders the same collapsed or not", () => {
  const dup = "{NAME} {can|can} fill up an electric car at a gas station.";
  const flat = "{NAME} can fill up an electric car at a gas station.";

  it("renderCanonical: {can|can} === can", () => {
    assert.equal(renderCanonical(dup), renderCanonical(flat));
  });

  it("renderPersonalized: {can|can} === can for he/him AND they/them", () => {
    assert.equal(renderPersonalized(dup, "Dave", "he/him"), renderPersonalized(flat, "Dave", "he/him"));
    assert.equal(renderPersonalized(dup, "Sam", "they/them"), renderPersonalized(flat, "Sam", "they/them"));
  });
});

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

  it("replaces {NAME_POSSESSIVE} with the canonical possessive 'Alex's'", () => {
    assert.equal(renderCanonical("{NAME_POSSESSIVE}"), "Alex's");
    assert.equal(renderCanonical("{NAME_POSSESSIVE} Week"), "Alex's Week");
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

  it("fixes 'a {NAME}' to 'an Alex' (canonical name starts with a vowel)", () => {
    assert.equal(renderCanonical("Sharks have a {NAME} Week"), "Sharks have an Alex Week");
  });

  it("fixes 'A {NAME}' to 'An Alex' at sentence start", () => {
    assert.equal(renderCanonical("A {NAME} legend"), "An Alex legend");
  });

  it("only touches the article directly before {NAME}", () => {
    assert.equal(renderCanonical("a unicorn met a {NAME}"), "a unicorn met an Alex");
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

describe("renderPersonalized — {NAME_POSSESSIVE} always appends 's", () => {
  it("appends 's to a consonant-ending name", () => {
    assert.equal(renderPersonalized("{NAME_POSSESSIVE}", "David", "he/him"), "David's");
    assert.equal(renderPersonalized("{NAME_POSSESSIVE} Week", "David Franklin", "he/him"), "David Franklin's Week");
  });

  it("ALSO appends 's to names already ending in 's (no James'/Chris' branching)", () => {
    assert.equal(renderPersonalized("{NAME_POSSESSIVE}", "Chris", "he/him"), "Chris's");
    assert.equal(renderPersonalized("{NAME_POSSESSIVE}", "James", "they/them"), "James's");
  });

  it("is pronoun-independent (same possessive regardless of pronouns)", () => {
    assert.equal(renderPersonalized("{NAME_POSSESSIVE}", "Alex", "she/her"), "Alex's");
    assert.equal(renderPersonalized("{NAME_POSSESSIVE}", "Alex", "they/them"), "Alex's");
  });
});

describe("renderPersonalized — indefinite article agreement around {NAME}", () => {
  it("renders 'a {NAME}' as 'an Alex' for a vowel-initial name", () => {
    assert.equal(renderPersonalized("Sharks have a {NAME} Week", "Alex", "he/him"), "Sharks have an Alex Week");
  });

  it("renders 'a {NAME}' as 'a David' for a consonant-initial name", () => {
    assert.equal(renderPersonalized("Sharks have a {NAME} Week", "David", "he/him"), "Sharks have a David Week");
  });

  it("rewrites 'an {NAME}' to 'a' for a consonant-initial name", () => {
    assert.equal(renderPersonalized("It was an {NAME} moment", "David", "he/him"), "It was a David moment");
  });

  it("preserves sentence-start capitalization (A → An)", () => {
    assert.equal(renderPersonalized("A {NAME} legend", "Owen", "she/her"), "An Owen legend");
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

// ── PRONOUN_ALLOWLIST's neopronoun sets (ze/zir, xe/xem) ──────────────────────
// Regression for PR #398 round 1: these are first-class, selectable options on
// the meme-builder endpoints (validators/memeBuilder.ts's PRONOUN_ALLOWLIST),
// not an obscure edge case. Before this fix, resolveIdentityForms only
// special-cased he/she and fell through to the they/them possessive/reflexive
// forms for everything else — so a "ze/zir" or "xe/xem" user's {POSS}/{POSS_PRO}/
// {REFL} silently rendered "their"/"theirs"/"themselves" instead of their own
// pronoun's forms, on any surface that calls renderPersonalized — including,
// as of this PR, the split-caption halves baked into a saved meme image.
describe("renderPersonalized — ze/zir (singular, zir-family forms)", () => {
  it("renders SUBJ/OBJ from the input, POSS/POSS_PRO/REFL from the zir family", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Sam", "ze/zir"), "ze");
    assert.equal(renderPersonalized("{OBJ}", "Sam", "ze/zir"), "zir");
    assert.equal(renderPersonalized("{POSS}", "Sam", "ze/zir"), "zir");
    assert.equal(renderPersonalized("{POSS_PRO}", "Sam", "ze/zir"), "zirs");
    assert.equal(renderPersonalized("{REFL}", "Sam", "ze/zir"), "zirself");
  });

  it("capitalized tokens", () => {
    assert.equal(renderPersonalized("{Subj}", "Sam", "ze/zir"), "Ze");
    assert.equal(renderPersonalized("{Poss}", "Sam", "ze/zir"), "Zir");
    assert.equal(renderPersonalized("{Refl}", "Sam", "ze/zir"), "Zirself");
  });

  it("uses the singular branch for {singular|plural}", () => {
    assert.equal(renderPersonalized("{keeps|keep}", "Sam", "ze/zir"), "keeps");
  });

  it("a complete sentence", () => {
    assert.equal(
      renderPersonalized("{NAME} {has|have} done {POSS} work {REFL}.", "Sam", "ze/zir"),
      "Sam has done zir work zirself.",
    );
  });
});

describe("renderPersonalized — xe/xem (singular, xyr-family forms)", () => {
  it("renders SUBJ/OBJ from the input, POSS/POSS_PRO/REFL from the xyr family", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Sam", "xe/xem"), "xe");
    assert.equal(renderPersonalized("{OBJ}", "Sam", "xe/xem"), "xem");
    assert.equal(renderPersonalized("{POSS}", "Sam", "xe/xem"), "xyr");
    assert.equal(renderPersonalized("{POSS_PRO}", "Sam", "xe/xem"), "xyrs");
    assert.equal(renderPersonalized("{REFL}", "Sam", "xe/xem"), "xemself");
  });

  it("capitalized tokens", () => {
    assert.equal(renderPersonalized("{Subj}", "Sam", "xe/xem"), "Xe");
    assert.equal(renderPersonalized("{Poss}", "Sam", "xe/xem"), "Xyr");
    assert.equal(renderPersonalized("{Refl}", "Sam", "xe/xem"), "Xemself");
  });

  it("uses the singular branch for {singular|plural}", () => {
    assert.equal(renderPersonalized("{keeps|keep}", "Sam", "xe/xem"), "keeps");
  });

  it("a complete sentence", () => {
    assert.equal(
      renderPersonalized("{NAME} {has|have} done {POSS} work {REFL}.", "Sam", "xe/xem"),
      "Sam has done xyr work xemself.",
    );
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

  // A pipe-delimited custom pronoun set ("xe|xem|xyr|xyrs|xemself|s") is a
  // format only the client's resolveMap understands today — this resolver
  // does not parse it. Regression for PR #398 round 1: naive `"/"`-splitting
  // on a string with no "/" previously yielded the ENTIRE raw pipe string as
  // the literal SUBJ token value (e.g. "{SUBJ}" → "xe|xem|xyr|xyrs|xemself|s"),
  // which is worse than an unresolved token — it looks like real (garbled)
  // output. Must fall back to the they/them default instead.
  it("pipe-delimited custom pronouns fall back to they/them, never leak raw text", () => {
    const custom = "xe|xem|xyr|xyrs|xemself|s";
    assert.equal(renderPersonalized("{SUBJ}", "Sam", custom), "they");
    assert.equal(renderPersonalized("{OBJ}", "Sam", custom), "them");
    assert.equal(renderPersonalized("{POSS}", "Sam", custom), "their");
    assert.equal(renderPersonalized("{POSS_PRO}", "Sam", custom), "theirs");
    assert.equal(renderPersonalized("{REFL}", "Sam", custom), "themselves");
    assert.equal(renderPersonalized("{keeps|keep}", "Sam", custom), "keep");
  });

  it("a pipe with no slash at all still falls back cleanly (no crash, no leak)", () => {
    assert.equal(renderPersonalized("{SUBJ}", "Sam", "garbled|input"), "they");
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

// ── hasUnresolvedFactTokens ───────────────────────────────────────────────────

describe("hasUnresolvedFactTokens", () => {
  it("flags leftover identity tokens", () => {
    assert.equal(hasUnresolvedFactTokens("{NAME} did a thing"), true);
    assert.equal(hasUnresolvedFactTokens("It belongs to {POSS} cat"), true);
  });

  it("flags a leftover {NAME_POSSESSIVE} token", () => {
    assert.equal(hasUnresolvedFactTokens("{NAME_POSSESSIVE} Week"), true);
  });

  it("flags leftover {singular|plural} pairs", () => {
    assert.equal(hasUnresolvedFactTokens("Dave {run|runs} fast"), true);
  });

  it("passes fully-rendered text", () => {
    assert.equal(hasUnresolvedFactTokens("Dave runs fast at night"), false);
  });

  it("does not flag legitimate braces (math / emoji shortcodes)", () => {
    assert.equal(hasUnresolvedFactTokens("the set {1, 2, 3} is small"), false);
    assert.equal(hasUnresolvedFactTokens("score of 100% :{tada}:"), false);
  });
});

// ── hasSubjectIdentityToken (narrow: identity tokens only) ─────────────────────

describe("hasSubjectIdentityToken", () => {
  it("flags subject identity tokens", () => {
    assert.equal(hasSubjectIdentityToken("{NAME}"), true);
    assert.equal(hasSubjectIdentityToken("{NAME_POSSESSIVE}"), true);
    assert.equal(hasSubjectIdentityToken("{SUBJ}"), true);
    assert.equal(hasSubjectIdentityToken("belongs to {POSS} cat"), true);
    assert.equal(hasSubjectIdentityToken("{Refl}"), true);
  });

  it("does NOT flag {singular|plural} pairs (those are not the subject)", () => {
    assert.equal(hasSubjectIdentityToken("{has|have}"), false);
    assert.equal(hasSubjectIdentityToken("Dave {run|runs} fast"), false);
  });

  it("does not flag plain text or unrelated braces", () => {
    assert.equal(hasSubjectIdentityToken("Earth seen from orbit"), false);
    assert.equal(hasSubjectIdentityToken("the set {1, 2, 3}"), false);
  });
});

// ── subject-name semantic-entity guard ────────────────────────────────────────

describe("isSubjectNameSemanticEntity", () => {
  it("flags the canonical subject name (exact, case-insensitive, trimmed)", () => {
    assert.equal(isSubjectNameSemanticEntity(ent("Alex")), true);
    assert.equal(isSubjectNameSemanticEntity(ent("alex")), true);
    assert.equal(isSubjectNameSemanticEntity(ent("  Alex  ")), true);
    // Matches on normalizedText even if surfaceText differs in case.
    assert.equal(isSubjectNameSemanticEntity({ surfaceText: "ALEX", normalizedText: "alex" }), true);
  });

  it("flags the canonical possessive subject form 'Alex's' (rendered, not a token)", () => {
    assert.equal(isSubjectNameSemanticEntity(ent("Alex's")), true);
    assert.equal(isSubjectNameSemanticEntity(ent("alex's")), true);
    assert.equal(isSubjectNameSemanticEntity({ surfaceText: "ALEX'S", normalizedText: "alex's" }), true);
  });

  it("flags residual subject identity tokens", () => {
    assert.equal(isSubjectNameSemanticEntity(ent("{NAME}")), true);
    assert.equal(isSubjectNameSemanticEntity(ent("{NAME_POSSESSIVE}")), true);
    assert.equal(isSubjectNameSemanticEntity(ent("{SUBJ}")), true);
  });

  it("PRESERVES non-subject referents, including multi-word names containing the canonical name", () => {
    assert.equal(isSubjectNameSemanticEntity(ent("Alex Honnold")), false);
    assert.equal(isSubjectNameSemanticEntity(ent("Alex Honnold's climb")), false);
    assert.equal(isSubjectNameSemanticEntity(ent("Earth")), false);
    assert.equal(isSubjectNameSemanticEntity(ent("Firearms")), false);
    // A legitimate non-subject referent that happens to carry a pluralization
    // pair must not be stripped (narrow token check, not hasUnresolvedFactTokens).
    assert.equal(isSubjectNameSemanticEntity(ent("{cactus|cacti}")), false);
  });

  it("tolerates partial/stale entities missing normalizedText (no crash)", () => {
    // Stored enrichment blobs may predate the normalizedText field.
    assert.equal(isSubjectNameSemanticEntity({ surfaceText: "Alex" }), true);
    assert.equal(isSubjectNameSemanticEntity({ surfaceText: "{NAME}" }), true);
    assert.equal(isSubjectNameSemanticEntity({ surfaceText: "Earth" }), false);
    assert.equal(isSubjectNameSemanticEntity({}), false);
  });
});

describe("stripSubjectNameSemanticEntities", () => {
  it("removes only the subject-name entities, preserving order and the rest", () => {
    const input = [ent("Earth"), ent("Alex"), ent("Firearms"), ent("{NAME}"), ent("Alex Honnold")];
    const out = stripSubjectNameSemanticEntities(input);
    assert.deepEqual(out.map((e) => e.surfaceText), ["Earth", "Firearms", "Alex Honnold"]);
  });

  it("is a no-op when there is no subject entity", () => {
    const input = [ent("Earth"), ent("Firearms")];
    assert.equal(stripSubjectNameSemanticEntities(input).length, 2);
  });
});
