import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoConjugatePersonSubjectVerbs } from "../lib/templateGrammar.js";

const conj = autoConjugatePersonSubjectVerbs;

describe("autoConjugatePersonSubjectVerbs — positive (wraps person-subject verbs)", () => {
  const cases: Array<[string, string]> = [
    ["{Subj} keeps it", "{Subj} {keeps|keep} it"],
    ["{Subj} is", "{Subj} {is|are}"],
    ["{SUBJ} catches", "{SUBJ} {catches|catch}"],
    ["{Subj} fixes", "{Subj} {fixes|fix}"],
    // Contractions (apostrophe-aware matcher + irregular map).
    ["{Subj} doesn't blink", "{Subj} {doesn't|don't} blink"],
    ["{Subj} isn't afraid", "{Subj} {isn't|aren't} afraid"],
    ["{Subj} hasn't moved", "{Subj} {hasn't|haven't} moved"],
    ["{Subj} wasn't ready", "{Subj} {wasn't|weren't} ready"],
    // Adverb between the subject token and the verb.
    ["{Subj} secretly keeps", "{Subj} secretly {keeps|keep}"],
    // Sibilant -sses verbs (thirdPersonToBase 'sses' rule).
    ["{Subj} passes", "{Subj} {passes|pass}"],
    ["{Subj} misses", "{Subj} {misses|miss}"],
    ["{Subj} kisses", "{Subj} {kisses|kiss}"],
    // Coordinated tail: the net is adjacency-only, so it still wraps the
    // IMMEDIATE person-subject verb even when a later coordinated verb has a
    // new (non-person) subject — it must not walk into that tail.
    ["{Subj} runs and dogs bark", "{Subj} {runs|run} and dogs bark"],
    ["{Subj} hides and alarms sound", "{Subj} {hides|hide} and alarms sound"],
    ["{Subj} wins but robots revolt", "{Subj} {wins|win} but robots revolt"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      assert.equal(conj(input), expected);
    });
  }

  it("repairs the exact reported failure", () => {
    const input = "{NAME} caught the Corona virus. {Subj} keeps it locked up in {POSS} back yard.";
    const expected = "{NAME} caught the Corona virus. {Subj} {keeps|keep} it locked up in {POSS} back yard.";
    assert.equal(conj(input), expected);
  });
});

describe("autoConjugatePersonSubjectVerbs — negative (leaves text unchanged)", () => {
  const unchanged = [
    // Past tense / base form — not a 3rd-person-singular present verb.
    "{NAME} caught",
    "{Subj} kept it",
    // Already a conjugation pair — must stay idempotent, never double-wrap.
    "{Subj} {keeps|keep}",
    // Subject is NOT the person → never our concern.
    // {NAME} renders as a literal singular name, not a pronoun, so verbs after
    // it must not become he/she-vs-they pairs.
    "{NAME} has",
    "{NAME} flies",
    "{NAME} pushes",
    "{NAME} always runs",
    "{NAME} gives you the finger",
    "Sharks have a {NAME} Week.",
    "time fears {Obj}",
    // Title-case nouns/labels after {NAME} (uppercase-initial guard).
    "{NAME} News starts now",
    "{NAME} Fitness matters",
    "{NAME} Status changes",
    "{NAME} Series",
    // Lowercase noun stoplist (proves the guard isn't just the uppercase rule).
    "{NAME} news starts now",
    // -ss / -us / -is noun endings.
    "{NAME} fitness wins",
    "{Subj} focus wins",
    "the Corona virus",
    // No whitespace after the token (possessive) — not matched.
    "{NAME}'s legend grows",
  ];
  for (const input of unchanged) {
    it(`leaves "${input}" unchanged`, () => {
      assert.equal(conj(input), input);
    });
  }
});

describe("autoConjugatePersonSubjectVerbs — idempotent", () => {
  it("running twice equals running once", () => {
    const input = "{Subj} keeps it and {NAME} has a {POSS} plan";
    const once = conj(input);
    assert.equal(conj(once), once);
  });
});
