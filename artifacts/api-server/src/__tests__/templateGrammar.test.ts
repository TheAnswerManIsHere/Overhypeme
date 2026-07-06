import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateTemplate,
  expandSubjectContractions,
  applyDeterministicGrammar,
  collapseNameSubjectConjugationPairs,
} from "../lib/templateGrammar.js";

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
    "NAME_POSSESSIVE",
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

describe("collapseNameSubjectConjugationPairs — object-separated coordination", () => {
  it("collapses a pair separated from {NAME} by an object", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} eats cake and {drinks|drink} soda"),
      "{NAME} eats cake and drinks soda",
    );
  });

  it("collapses with 'or'/'but' and a skippable adverb before the pair", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} eats cake or always {drinks|drink} soda"),
      "{NAME} eats cake or always drinks soda",
    );
  });

  it("does not collapse when a noun sits between the conjunction and the pair", () => {
    const input = "{NAME} eats and dogs {barks|bark}";
    assert.equal(collapseNameSubjectConjugationPairs(input), input);
  });

  it("does not cross a different subject token", () => {
    const input = "{NAME} eats cake or {SUBJ} {drinks|drink} soda";
    assert.equal(collapseNameSubjectConjugationPairs(input), input);
  });

  it("does not cross clause-boundary punctuation (comma)", () => {
    const input = "{NAME} eats cake, and {drinks|drink} soda";
    assert.equal(collapseNameSubjectConjugationPairs(input), input);
  });

  it("does not cross clause-boundary punctuation (semicolon)", () => {
    const input = "{NAME} eats cake; and {drinks|drink} soda";
    assert.equal(collapseNameSubjectConjugationPairs(input), input);
  });

  it("does not cross clause-boundary punctuation (period / new sentence)", () => {
    const input = "{NAME} eats cake. And {drinks|drink} soda";
    assert.equal(collapseNameSubjectConjugationPairs(input), input);
  });

  it("is idempotent for object-separated collapse", () => {
    const input = "{NAME} eats cake and {drinks|drink} soda";
    const once = collapseNameSubjectConjugationPairs(input);
    assert.equal(collapseNameSubjectConjugationPairs(once), once);
  });
});

describe("expandSubjectContractions", () => {
  it("expands {Subj}'s to {Subj} {is|are}", () => {
    assert.equal(
      expandSubjectContractions("{Subj}'s unstoppable"),
      "{Subj} {is|are} unstoppable",
    );
  });

  it("expands {SUBJ}'s to {SUBJ} {is|are}", () => {
    assert.equal(
      expandSubjectContractions("everyone knows {SUBJ}'s unstoppable"),
      "everyone knows {SUBJ} {is|are} unstoppable",
    );
  });

  it("handles a curly apostrophe", () => {
    assert.equal(
      expandSubjectContractions("{Subj}’s unstoppable"),
      "{Subj} {is|are} unstoppable",
    );
  });

  it("leaves text without a subject contraction unchanged", () => {
    const input = "{Subj} keeps it locked in {POSS} back yard";
    assert.equal(expandSubjectContractions(input), input);
  });

  it("leaves an already-expanded pair unchanged", () => {
    const input = "{Subj} {is|are} unstoppable";
    assert.equal(expandSubjectContractions(input), input);
  });

  it("is idempotent", () => {
    const once = expandSubjectContractions("{Subj}'s unstoppable and {SUBJ}'s fast");
    assert.equal(expandSubjectContractions(once), once);
  });

  // Codex review finding: "'s" followed by a has-only word (got/gotten/been/
  // had) must expand to {has|have}, never the copula — "is got"/"is been"/
  // "is had" are not grammatical English, so defaulting to {is|are} would
  // store "They are got the keys" for they/them.
  describe("has-only-following-word disambiguation", () => {
    const hasCases: Array<[string, string]> = [
      ["{Subj}'s got the keys", "{Subj} {has|have} got the keys"],
      ["{SUBJ}'s got the keys", "{SUBJ} {has|have} got the keys"],
      ["{Subj}'s been there before", "{Subj} {has|have} been there before"],
      ["{Subj}'s had enough", "{Subj} {has|have} had enough"],
      ["{Subj}'s gotten away with it", "{Subj} {has|have} gotten away with it"],
    ];
    for (const [input, expected] of hasCases) {
      it(`${input} → ${expected}`, () => {
        assert.equal(expandSubjectContractions(input), expected);
      });
    }

    it("still defaults to the copula for ambiguous/unrelated words", () => {
      assert.equal(expandSubjectContractions("{Subj}'s unstoppable"), "{Subj} {is|are} unstoppable");
      // "done" is genuinely ambiguous (is done / has done it) — deliberately
      // left on the {is|are} default rather than guessed.
      assert.equal(expandSubjectContractions("{Subj}'s done"), "{Subj} {is|are} done");
    });

    it("is case-insensitive for the following word", () => {
      assert.equal(expandSubjectContractions("{Subj}'s GOT the keys"), "{Subj} {has|have} GOT the keys");
    });
  });
});

describe("applyDeterministicGrammar — canonical sequence", () => {
  it("collapses a {NAME}-subject pair, expands a contraction, and conjugates a missed verb in one call", () => {
    const input = "{NAME} {gives|give} you the finger. {Subj}'s telling you {Subj} keeps score.";
    const output = applyDeterministicGrammar(input);
    assert.equal(
      output,
      "{NAME} gives you the finger. {Subj} {is|are} telling you {Subj} {keeps|keep} score.",
    );
    assert.deepEqual(validateTemplate(output), { valid: true });
  });

  it("collapses an identical conjugation branch produced after conjugation", () => {
    assert.equal(
      applyDeterministicGrammar("{Subj} {can|can} fly"),
      "{Subj} can fly",
    );
  });

  it("is idempotent", () => {
    const input = "{NAME} {gives|give} you the finger. {Subj}'s telling you {Subj} keeps score.";
    const once = applyDeterministicGrammar(input);
    assert.equal(applyDeterministicGrammar(once), once);
  });

  it("is a no-op on already-correct text", () => {
    const input = "{NAME} gives you the finger. {Subj} {is|are} telling you {Subj} {keeps|keep} score.";
    assert.equal(applyDeterministicGrammar(input), input);
  });
});
