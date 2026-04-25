import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTemplate } from "../lib/templateGrammar.js";

describe("validateTemplate — empty input", () => {
  it("rejects empty string", () => {
    const r = validateTemplate("");
    assert.equal(r.valid, false);
    assert.equal(r.error, "Template is empty");
  });
});

describe("validateTemplate — plain text", () => {
  it("accepts text without any braces", () => {
    assert.deepEqual(validateTemplate("Hello, world."), { valid: true });
  });

  it("accepts text with punctuation and unicode", () => {
    assert.deepEqual(validateTemplate("Café — résumé!"), { valid: true });
  });
});

describe("validateTemplate — allowed simple tokens", () => {
  const tokens = [
    "NAME",
    "SUBJ", "Subj",
    "OBJ", "Obj",
    "POSS", "Poss",
    "POSS_PRO", "Poss_Pro",
    "REFL", "Refl",
  ];

  for (const t of tokens) {
    it(`accepts {${t}}`, () => {
      assert.deepEqual(validateTemplate(`Hello {${t}}.`), { valid: true });
    });
  }

  it("accepts multiple tokens in one template", () => {
    assert.deepEqual(
      validateTemplate("{NAME} kicked {Obj} with {Poss} foot."),
      { valid: true },
    );
  });
});

describe("validateTemplate — conjugation pairs", () => {
  it("accepts {is|are}", () => {
    assert.deepEqual(validateTemplate("{NAME} {is|are} here."), { valid: true });
  });

  it("accepts multiple conjugation pairs", () => {
    assert.deepEqual(
      validateTemplate("{Subj} {has|have} {Poss} {own|own}."),
      { valid: true },
    );
  });

  it("rejects pair with empty left half (regex requires non-empty alternatives)", () => {
    const r = validateTemplate("{|are}");
    assert.equal(r.valid, false);
    assert.match(r.error ?? "", /Unknown token "\{\|are\}"/);
  });

  it("rejects pair with empty right half", () => {
    const r = validateTemplate("{is|}");
    assert.equal(r.valid, false);
    assert.match(r.error ?? "", /Unknown token "\{is\|\}"/);
  });
});

describe("validateTemplate — error cases", () => {
  it("rejects nested braces {{NAME}}", () => {
    const r = validateTemplate("{{NAME}}");
    assert.equal(r.valid, false);
    assert.equal(r.error, "Nested braces detected");
  });

  it("rejects unmatched opening brace", () => {
    const r = validateTemplate("hello {NAME");
    assert.equal(r.valid, false);
    assert.equal(r.error, "Unmatched opening brace");
  });

  it("rejects unknown token", () => {
    const r = validateTemplate("{FOO}");
    assert.equal(r.valid, false);
    assert.equal(r.error, 'Unknown token "{FOO}"');
  });

  it("rejects trailing unmatched closing brace", () => {
    const r = validateTemplate("hello}");
    assert.equal(r.valid, false);
    assert.equal(r.error, "Unmatched closing brace");
  });

  it("rejects multiple closing braces with no opens", () => {
    const r = validateTemplate("}}}");
    assert.equal(r.valid, false);
    assert.equal(r.error, "Unmatched closing brace");
  });
});
