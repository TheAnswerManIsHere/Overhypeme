/**
 * Unit tests for the personal-name validator.
 *
 * The validator is the gate for everything that ends up rendered into LLM
 * prompts via {NAME} / {SUBJ} / {OBJ} substitutions. Tests focus on the
 * three correctness pillars:
 *
 *   1. Strip control / zero-width characters before counting words/chars.
 *   2. Drop everything outside `[\p{L}\p{M}\p{N}'-]` plus whitespace.
 *   3. Enforce 3-word / 20-char-per-word caps from admin_config.
 *
 * Pronouns share the same pipeline plus a `/` separator and a 4-token cap.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeAndValidatePersonalName,
  sanitizeAndValidatePronouns,
  sanitizePersonalNameSync,
  _resetPersonalNameValidatorCache,
  NAME_VALIDATION_DEFAULT_MAX_WORDS,
  NAME_VALIDATION_DEFAULT_MAX_CHARS_PER_WORD,
} from "../lib/validators/personalName.js";

describe("validators/personalName", () => {
  before(() => {
    _resetPersonalNameValidatorCache();
  });

  describe("sanitizeAndValidatePersonalName", () => {
    it("accepts a clean 3-word ASCII name", async () => {
      const r = await sanitizeAndValidatePersonalName("Pat O'Brien Jr");
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.value, "Pat O'Brien Jr");
    });

    it("strips zero-width and control characters", async () => {
      const raw = "Pa​t‮s";
      const r = await sanitizeAndValidatePersonalName(raw);
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.value, "Pats");
    });

    it("drops emoji, punctuation, and other disallowed chars", async () => {
      const r = await sanitizeAndValidatePersonalName("Pat🦊!@# Doe");
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.value, "Pat Doe");
    });

    it("collapses whitespace runs and trims", async () => {
      const r = await sanitizeAndValidatePersonalName("   Pat\t\t  Doe   ");
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.value, "Pat Doe");
    });

    it("rejects empty input", async () => {
      for (const v of ["", "   ", "🦊!"]) {
        const r = await sanitizeAndValidatePersonalName(v);
        assert.equal(r.ok, false, `expected reject for ${JSON.stringify(v)}`);
      }
    });

    it("rejects non-string input", async () => {
      const r = await sanitizeAndValidatePersonalName(42 as unknown as string);
      assert.equal(r.ok, false);
    });

    it("rejects more than 3 words", async () => {
      const r = await sanitizeAndValidatePersonalName("one two three four");
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && /3 words or fewer/.test(r.error), true);
    });

    it("rejects a single word over 20 characters", async () => {
      const r = await sanitizeAndValidatePersonalName("x".repeat(21));
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && /20 characters or fewer/.test(r.error), true);
    });

    it("accepts unicode letters and marks (Café, Ünder)", async () => {
      const r = await sanitizeAndValidatePersonalName("Café Ünder");
      assert.equal(r.ok, true);
    });
  });

  describe("sanitizePersonalNameSync", () => {
    it("uses the in-process defaults without hitting the DB", () => {
      const r = sanitizePersonalNameSync("Pat Doe");
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.value, "Pat Doe");
    });
    it("respects custom caps", () => {
      const r = sanitizePersonalNameSync("Patrick Doe", { maxCharsPerWord: 5 });
      assert.equal(r.ok, false);
    });
    it("default caps match exported constants", () => {
      assert.equal(NAME_VALIDATION_DEFAULT_MAX_WORDS, 3);
      assert.equal(NAME_VALIDATION_DEFAULT_MAX_CHARS_PER_WORD, 20);
    });
  });

  describe("sanitizeAndValidatePronouns", () => {
    it("accepts canonical they/them, she/her, he/him", async () => {
      for (const v of ["they/them", "she/her", "he/him"]) {
        const r = await sanitizeAndValidatePronouns(v);
        assert.equal(r.ok, true, v);
        assert.equal(r.ok && r.value, v);
      }
    });

    it("accepts 'they/them or she/her' (4-token cap)", async () => {
      const r = await sanitizeAndValidatePronouns("they/them or she/her");
      assert.equal(r.ok, true);
    });

    it("rejects pronouns with disallowed punctuation", async () => {
      const r = await sanitizeAndValidatePronouns("she/her, they/them");
      assert.equal(r.ok, true); // the comma is stripped, leaving spaces
      assert.equal(r.ok && r.value, "she/her they/them");
    });

    // The pronoun editor's custom set, `subj|obj|poss|possPro|refl|s|p`
    // (serializeCustom in the web's lib/pronouns.ts), is a structure, not text:
    // the pipes are its delimiters (launch Phase 5, PR #801 round 1).
    it("keeps a custom pronoun set intact, singular and plural", async () => {
      for (const v of ["xe|xem|xyr|xyrs|xemself|s", "fae|faer|faer|faers|faerself|s", "they|them|their|theirs|themselves|p"]) {
        const r = await sanitizeAndValidatePronouns(v);
        assert.equal(r.ok, true, v);
        assert.equal(r.ok && r.value, v);
      }
    });

    it("allows the empty fields the editor allows, and cleans each field like a word", async () => {
      const r = await sanitizeAndValidatePronouns("ze|hir||| hirself |s");
      assert.equal(r.ok && r.value, "ze|hir|||hirself|s");
      const stripped = await sanitizeAndValidatePronouns("ze<|hir|hir|hirs|hirself|s");
      assert.equal(stripped.ok && stripped.value, "ze|hir|hir|hirs|hirself|s");
    });

    it("refuses a custom field over the per-word cap, a wrong part count, and a bad verb marker", async () => {
      assert.equal((await sanitizeAndValidatePronouns(`xe|xem|xyr|xyrs|${"x".repeat(25)}|s`)).ok, false);
      assert.equal((await sanitizeAndValidatePronouns("xe|xem|xyr|xyrs|s")).ok, false);
      assert.equal((await sanitizeAndValidatePronouns("xe|xem|xyr|xyrs|xemself|s|p")).ok, false);
      assert.equal((await sanitizeAndValidatePronouns("xe|xem|xyr|xyrs|xemself|x")).ok, false);
      assert.equal((await sanitizeAndValidatePronouns("|||||s")).ok, false, "a set with no forms at all is empty");
    });

    it("refuses a field holding two words", async () => {
      assert.equal((await sanitizeAndValidatePronouns("xe xe|xem|xyr|xyrs|xemself|s")).ok, false);
    });

    it("rejects pronouns whose part exceeds the per-word cap", async () => {
      const r = await sanitizeAndValidatePronouns("a".repeat(25) + "/them");
      assert.equal(r.ok, false);
    });

    it("rejects more than 4 pronoun tokens", async () => {
      const r = await sanitizeAndValidatePronouns("a b c d e");
      assert.equal(r.ok, false);
    });
  });
});
