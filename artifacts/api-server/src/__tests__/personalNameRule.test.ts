/**
 * @purpose Runs the shared name table against the rule, and proves a provider name is cleaned rather than refused and that typed input is filtered without cutting a paste.
 * @subsystem accounts-auth
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPersonalName, cleanProvidedPersonalName, filterNameInput } from "@workspace/api-zod";
import { PERSONAL_NAME_ACCEPTED, PERSONAL_NAME_REFUSED } from "../../../../lib/api-zod/src/personalNameRule.fixtures";

describe("the shared name rule", () => {
  for (const c of PERSONAL_NAME_ACCEPTED) {
    it(`accepts ${c.why}`, () => assert.deepEqual(checkPersonalName(c.input), { ok: true, value: c.value }));
  }
  for (const c of PERSONAL_NAME_REFUSED) {
    it(`refuses ${c.why}`, () => {
      const r = checkPersonalName(c.input);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.reason, c.reason);
    });
  }
});

describe("a provider-supplied name", () => {
  it("is cleaned, not refused", () => assert.equal(cleanProvidedPersonalName("Ada 😀 (Countess)"), "Ada Countess"));
  it("is cut at 50 graphemes", () => assert.equal(cleanProvidedPersonalName("b".repeat(60)), "b".repeat(50)));
  it("is dropped when nothing is left", () => assert.equal(cleanProvidedPersonalName("😀😀"), null));
});

describe("typed input", () => {
  it("drops a disallowed character and says so", () => assert.deepEqual(filterNameInput("Ada😀"), { value: "Ada", refused: true }));
  it("converts the curly apostrophe", () => assert.deepEqual(filterNameInput("O’B"), { value: "O'B", refused: false }));
  it("keeps a pasted name's word breaks: other whitespace becomes a space, not a refusal", () => {
    for (const sep of ["\u00A0", "\u202F", "\u2009", "\u3000", "\t"]) {
      assert.deepEqual(filterNameInput(`Mary${sep}Jane`), { value: "Mary Jane", refused: false }, JSON.stringify(sep));
    }
    assert.deepEqual(filterNameInput("Mary "), { value: "Mary ", refused: false });
  });
  it("does not cut a long paste", () => assert.equal(filterNameInput("c".repeat(70)).value.length, 70));
});
