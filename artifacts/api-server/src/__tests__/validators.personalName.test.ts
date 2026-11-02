/**
 * Unit tests for the personal-name validator.
 *
 * The validator is the gate for everything that ends up rendered into LLM
 * prompts via {NAME} / {SUBJ} / {OBJ} substitutions. Names follow the shared
 * name rule (identity-flow Phase 2); pronouns keep their own pipeline: a `/`
 * separator, a 4-token cap and the per-word cap.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeAndValidatePersonalName,
  sanitizeAndValidatePronouns,
  sanitizePersonalNameSync,
  _resetPersonalNameValidatorCache,
  NAME_VALIDATION_DEFAULT_MAX_CHARS_PER_WORD,
} from "../lib/validators/personalName.js";

describe("validators/personalName", () => {
  before(() => {
    _resetPersonalNameValidatorCache();
  });

  // Names follow the shared rule; its full table is personalNameRule.test.ts.
  // These pin the server wrapper: refusal rather than stripping, no word cap,
  // the 50-grapheme limit, and the sync variant.
  describe("sanitizeAndValidatePersonalName", () => {
    it("accepts a clean name and normalizes whitespace", async () => {
      const r = await sanitizeAndValidatePersonalName("   Pat  O'Brien Jr   ");
      assert.deepEqual(r, { ok: true, value: "Pat O'Brien Jr" });
    });

    it("refuses an emoji or punctuation instead of stripping it", async () => {
      for (const v of ["Pat🦊 Doe", "Pat!@# Doe", "Pa\u200Bt"]) {
        const r = await sanitizeAndValidatePersonalName(v);
        assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(v)}`);
      }
    });

    it("rejects empty and non-string input", async () => {
      for (const v of ["", "   ", 42 as unknown as string]) {
        assert.equal((await sanitizeAndValidatePersonalName(v)).ok, false);
      }
    });

    it("has no word-count or per-word cap", async () => {
      assert.equal((await sanitizeAndValidatePersonalName("one two three four five")).ok, true);
      assert.equal((await sanitizeAndValidatePersonalName("x".repeat(40))).ok, true);
    });

    it("caps at 50 visible characters", async () => {
      assert.equal((await sanitizeAndValidatePersonalName("x".repeat(50))).ok, true);
      assert.equal((await sanitizeAndValidatePersonalName("x".repeat(51))).ok, false);
    });

    it("accepts letters and marks in any script, with joiners", async () => {
      for (const v of ["Café Ünder", "مهر\u200Cناز", "क्\u200Dष"]) {
        assert.equal((await sanitizeAndValidatePersonalName(v)).ok, true, v);
      }
    });
  });

  describe("sanitizePersonalNameSync", () => {
    it("applies the same rule without the denylist", () => {
      assert.deepEqual(sanitizePersonalNameSync("Pat Doe"), { ok: true, value: "Pat Doe" });
      assert.equal(sanitizePersonalNameSync("Pat 🦊").ok, false);
    });
    it("keeps the pronoun per-word default", () => {
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
