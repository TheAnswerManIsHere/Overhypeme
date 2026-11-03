/**
 * @purpose Runs the shared name table against the rule, and proves a provider name is kept only whole (never stripped, spaced out or cut) and that typed input is filtered without cutting a paste.
 * @subsystem accounts-auth
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acceptProvidedPersonalName, checkPersonalName, filterNameInput } from "@workspace/api-zod";
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

// Names-and-fonts plan: a Google or Apple name is kept whole or not at all,
// so nothing garbled is ever stored ("Nguyễn" was once stored "Nguy n").
describe("a provider-supplied name", () => {
  it("is kept whole when the rule admits it", () => assert.equal(acceptProvidedPersonalName("Nguyễn"), "Nguyễn"));
  it("is normalized like a typed one", () => assert.equal(acceptProvidedPersonalName("  O\u2019Brien "), "O'Brien"));
  it("is not stored at all when any character is outside the rule", () => {
    for (const raw of ["Иван", "John 王", "Ada 😀 (Countess)"]) assert.equal(acceptProvidedPersonalName(raw), null, raw);
  });
  it("is not stored, rather than cut, when it is over 50 characters", () => assert.equal(acceptProvidedPersonalName("b".repeat(60)), null));
  it("stays absent when the provider sent none", () => {
    assert.equal(acceptProvidedPersonalName(null), null);
    assert.equal(acceptProvidedPersonalName(""), null);
  });
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
