import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateTemplate,
  expandSubjectContractions,
  applyDeterministicGrammar,
  collapseNameSubjectConjugationPairs,
  repairGluedConjugationSuffixes,
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

// #1131: the tokenizer wrapped "adds" as a pair and left the "s" behind
// ("{NAME} calmly {adds|add}s"), which renders "addss". The repair drops a
// glued suffix that repeats the end of the singular branch; any other glued
// shape is refused by the validator rather than stored.
describe("repairGluedConjugationSuffixes (#1131)", () => {
  it("drops a suffix that repeats the end of the singular branch", () => {
    assert.equal(repairGluedConjugationSuffixes("{Subj} calmly {adds|add}s the mark"), "{Subj} calmly {adds|add} the mark");
    assert.equal(repairGluedConjugationSuffixes("{Subj} {watches|watch}es TV"), "{Subj} {watches|watch} TV");
    assert.equal(repairGluedConjugationSuffixes("{Subj} {carries|carry}ies it"), "{Subj} {carries|carry} it");
    assert.equal(repairGluedConjugationSuffixes("{Subj} {has|have}s one"), "{Subj} {has|have} one");
  });

  it("repairs every glued pair in a template, not only the first", () => {
    assert.equal(
      repairGluedConjugationSuffixes("{Subj} {adds|add}s it and {watches|watch}es"),
      "{Subj} {adds|add} it and {watches|watch}",
    );
  });

  it("leaves a glued suffix that is not the singular's ending, for the validator to refuse", () => {
    assert.equal(repairGluedConjugationSuffixes("{Subj} {is|are}ly here"), "{Subj} {is|are}ly here");
  });

  it("leaves well-formed pairs, simple tokens and punctuation after a pair alone", () => {
    for (const t of ["{Subj} {adds|add} it.", "{Subj} {adds|add}, then rests", "{NAME}s list", "{Subj} {doesn't|don't} care", "{NAME_POSSESSIVE} hat"]) {
      assert.equal(repairGluedConjugationSuffixes(t), t);
    }
  });

  it("is idempotent", () => {
    const once = repairGluedConjugationSuffixes("{Subj} {adds|add}s it");
    assert.equal(repairGluedConjugationSuffixes(once), once);
  });
});

describe("applyDeterministicGrammar — a glued suffix after a pair (#1131)", () => {
  it("a {NAME} subject: the reported scene renders 'adds', never 'addss'", () => {
    assert.equal(
      applyDeterministicGrammar("{NAME} calmly {adds|add}s the final check mark"),
      "{NAME} calmly adds the final check mark",
    );
  });

  it("a pronoun subject keeps a clean pair for they/them", () => {
    assert.equal(applyDeterministicGrammar("{Subj} calmly {adds|add}s the mark"), "{Subj} calmly {adds|add} the mark");
  });

  it("is idempotent", () => {
    const once = applyDeterministicGrammar("{NAME} {adds|add}s it");
    assert.equal(applyDeterministicGrammar(once), once);
  });
});

describe("validateTemplate — a pair joined to the letters after it (#1131)", () => {
  it("refuses a pair followed directly by a letter", () => {
    const r = validateTemplate("{Subj} {is|are}ly here");
    assert.equal(r.valid, false);
    assert.match(r.error ?? "", /joined to the letters after it/);
    assert.equal(validateTemplate("{NAME} calmly {adds|add}s it").valid, false);
  });

  it("accepts a pair followed by punctuation, a space or the end", () => {
    for (const t of ["{Subj} {adds|add}.", "{Subj} {adds|add}, then", "{Subj} {adds|add}", "{Subj} {adds|add}'"]) {
      assert.deepEqual(validateTemplate(t), { valid: true }, t);
    }
  });

  it("does not apply to simple tokens followed by letters", () => {
    assert.deepEqual(validateTemplate("{NAME}s"), { valid: true });
  });
});

// PR #1145 round 1 (Codex 4655277100): a glued ending the repair cannot explain
// must still reach the validator with its braces. The {NAME}-subject collapse
// used to strip them first, so "{adds|add}es" was stored as "addses".
describe("applyDeterministicGrammar then validateTemplate — an unrepairable glued pair is refused, never stored", () => {
  for (const raw of [
    "{NAME} calmly {adds|add}es the final check mark",
    "{NAME} {runs|run} and {hides|hide}ing",
    "{NAME} eats cake and {drinks|drink}ing soda",
    "{NAME} {adds|add}S",
  ]) {
    it(raw, () => {
      const out = applyDeterministicGrammar(raw);
      const r = validateTemplate(out);
      assert.equal(r.valid, false, `stored as "${out}"`);
      assert.match(r.error ?? "", /joined to the letters after it/);
    });
  }

  it("a repairable glued pair after a name still becomes the plain word", () => {
    assert.equal(applyDeterministicGrammar("{NAME} calmly {adds|add}s the mark"), "{NAME} calmly adds the mark");
  });

  it("well-formed name-subject pairs collapse exactly as before", () => {
    assert.equal(applyDeterministicGrammar("{NAME} {runs|run} and {hides|hide}."), "{NAME} runs and hides.");
    assert.equal(applyDeterministicGrammar("{NAME} eats cake and {drinks|drink} soda"), "{NAME} eats cake and drinks soda");
  });

  it("identical branches glued to letters still collapse to the word (cannot)", () => {
    assert.equal(applyDeterministicGrammar("{Subj} {can|can}not stop"), "{Subj} cannot stop");
  });
});

// Build report on PR #1145: "n't" joined after a pair is a real word in both
// branches ({does|do}n't → doesn't / don't), so it must stay accepted, be left
// alone by the repair, and collapse after a name like any other pair.
describe("a negative contraction joined after a pair stays valid (PR #1145 follow-up)", () => {
  it("validates {does|do}n't, {is|are}n't and {was|were}n’t", () => {
    for (const t of ["{Subj} {does|do}n't care", "{Subj} {is|are}n't here", "{Subj} {was|were}n’t there", "{Subj} {does|do}n't."]) {
      assert.deepEqual(validateTemplate(t), { valid: true }, t);
    }
  });

  it("the repair leaves it alone", () => {
    assert.equal(repairGluedConjugationSuffixes("{Subj} {does|do}n't care"), "{Subj} {does|do}n't care");
  });

  it("after a name it collapses to the singular word", () => {
    assert.equal(applyDeterministicGrammar("{NAME} {does|do}n't care"), "{NAME} doesn't care");
    assert.equal(applyDeterministicGrammar("{NAME} eats cake and {does|do}n't share"), "{NAME} eats cake and doesn't share");
  });

  it("still refuses other letters joined after a pair, and n't followed by more letters", () => {
    assert.equal(validateTemplate("{Subj} {adds|add}es it").valid, false);
    assert.equal(validateTemplate("{Subj} {does|do}n'ts").valid, false);
    assert.equal(validateTemplate("{Subj} {does|do}nt care").valid, false);
  });
});
