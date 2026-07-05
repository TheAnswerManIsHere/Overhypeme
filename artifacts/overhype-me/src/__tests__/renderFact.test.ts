import { describe, it, expect } from "vitest";
import { renderFact, renderFactSegments, tokenizeFact, hasPronouns } from "@/lib/render-fact";

// ── renderFact ────────────────────────────────────────────────────────────────

describe("renderFact — {NAME} token", () => {
  it("replaces {NAME} with the provided name", () => {
    expect(renderFact("{NAME} is great", "Alice")).toBe("Alice is great");
  });

  it("falls back to '___' placeholder when name is empty string", () => {
    expect(renderFact("{NAME} did it", "")).toBe("___ did it");
  });

  it("replaces all occurrences of {NAME}", () => {
    expect(renderFact("{NAME} met {NAME}", "Dave")).toBe("Dave met Dave");
  });
});

describe("renderFact — {NAME_POSSESSIVE} token", () => {
  it("renders the possessive of a normal name", () => {
    expect(renderFact("{NAME_POSSESSIVE} legend grows", "Alice")).toBe("Alice's legend grows");
  });

  it("always appends 's, even for a name already ending in s", () => {
    expect(renderFact("{NAME_POSSESSIVE} legend grows", "James")).toBe("James's legend grows");
  });

  it("falls back to the ___'s placeholder when name is empty", () => {
    expect(renderFact("{NAME_POSSESSIVE} legend grows", "")).toBe("___'s legend grows");
  });

  it("replaces all occurrences", () => {
    expect(renderFact("{NAME_POSSESSIVE} and {NAME_POSSESSIVE}", "Sam")).toBe("Sam's and Sam's");
  });
});

describe("renderFactSegments — {NAME} vs {NAME_POSSESSIVE}", () => {
  it("renders {NAME} as a single isName segment", () => {
    expect(renderFactSegments("{NAME} once punched a shark", "Sam", "she/her")).toEqual([
      { text: "Sam", isName: true },
      { text: " once punched a shark", isName: false },
    ]);
  });

  it("renders {NAME_POSSESSIVE} as a single isName segment with the possessive text", () => {
    expect(renderFactSegments("{NAME_POSSESSIVE} legend grows", "James", "he/him")).toEqual([
      { text: "James's", isName: true },
      { text: " legend grows", isName: false },
    ]);
  });

  it("distinguishes {NAME} and {NAME_POSSESSIVE} in the same template", () => {
    expect(renderFactSegments("{NAME} says {NAME_POSSESSIVE} dog barks", "Alex", "he/him")).toEqual([
      { text: "Alex", isName: true },
      { text: " says ", isName: false },
      { text: "Alex's", isName: true },
      { text: " dog barks", isName: false },
    ]);
  });
});

describe("renderFact — indefinite article agreement around {NAME}", () => {
  it("turns 'a {NAME}' into 'an' when the name starts with a vowel", () => {
    expect(renderFact("Sharks have a {NAME} Week", "Alex")).toBe("Sharks have an Alex Week");
  });

  it("keeps 'a {NAME}' as 'a' when the name starts with a consonant", () => {
    expect(renderFact("Sharks have a {NAME} Week", "David")).toBe("Sharks have a David Week");
  });

  it("turns 'an {NAME}' back into 'a' when the name starts with a consonant", () => {
    expect(renderFact("It was an {NAME} moment", "David")).toBe("It was a David moment");
  });

  it("keeps 'an {NAME}' as 'an' when the name starts with a vowel", () => {
    expect(renderFact("It was an {NAME} moment", "Alex")).toBe("It was an Alex moment");
  });

  it("preserves capitalization at sentence start (A → An)", () => {
    expect(renderFact("A {NAME} legend", "Owen")).toBe("An Owen legend");
  });

  it("preserves capitalization at sentence start (An → A)", () => {
    expect(renderFact("An {NAME} legend", "Sam")).toBe("A Sam legend");
  });

  it("is case-insensitive about the name's first letter", () => {
    expect(renderFact("a {NAME}", "emma")).toBe("an emma");
  });

  it("uses 'a' for the empty-name placeholder", () => {
    expect(renderFact("Sharks have a {NAME} Week", "")).toBe("Sharks have a ___ Week");
  });

  it("only touches the article immediately before {NAME}, not other articles", () => {
    expect(renderFact("a unicorn met a {NAME}", "Alex")).toBe("a unicorn met an Alex");
  });

  it("does not treat a trailing 'a' inside a word as an article", () => {
    expect(renderFact("extra {NAME}", "Alex")).toBe("extra Alex");
  });
});

describe("renderFact — pronoun tokens (he/him)", () => {
  const name = "Dave";
  const pronouns = "he/him";

  it("renders {SUBJ} → he", () => expect(renderFact("{SUBJ}", name, pronouns)).toBe("he"));
  it("renders {Subj} → He", () => expect(renderFact("{Subj}", name, pronouns)).toBe("He"));
  it("renders {OBJ} → him", () => expect(renderFact("{OBJ}", name, pronouns)).toBe("him"));
  it("renders {Obj} → Him", () => expect(renderFact("{Obj}", name, pronouns)).toBe("Him"));
  it("renders {POSS} → his", () => expect(renderFact("{POSS}", name, pronouns)).toBe("his"));
  it("renders {Poss} → His", () => expect(renderFact("{Poss}", name, pronouns)).toBe("His"));
  it("renders {POSS_PRO} → his", () => expect(renderFact("{POSS_PRO}", name, pronouns)).toBe("his"));
  it("renders {Poss_Pro} → His", () => expect(renderFact("{Poss_Pro}", name, pronouns)).toBe("His"));
  it("renders {REFL} → himself", () => expect(renderFact("{REFL}", name, pronouns)).toBe("himself"));
  it("renders {Refl} → Himself", () => expect(renderFact("{Refl}", name, pronouns)).toBe("Himself"));
});

describe("renderFact — pronoun tokens (she/her)", () => {
  const name = "Alice";
  const pronouns = "she/her";

  it("renders {SUBJ} → she", () => expect(renderFact("{SUBJ}", name, pronouns)).toBe("she"));
  it("renders {OBJ} → her", () => expect(renderFact("{OBJ}", name, pronouns)).toBe("her"));
  it("renders {POSS} → her", () => expect(renderFact("{POSS}", name, pronouns)).toBe("her"));
  it("renders {POSS_PRO} → hers", () => expect(renderFact("{POSS_PRO}", name, pronouns)).toBe("hers"));
  it("renders {REFL} → herself", () => expect(renderFact("{REFL}", name, pronouns)).toBe("herself"));
});

describe("renderFact — pronoun tokens (they/them)", () => {
  const name = "Sam";
  const pronouns = "they/them";

  it("renders {SUBJ} → they", () => expect(renderFact("{SUBJ}", name, pronouns)).toBe("they"));
  it("renders {OBJ} → them", () => expect(renderFact("{OBJ}", name, pronouns)).toBe("them"));
  it("renders {POSS} → their", () => expect(renderFact("{POSS}", name, pronouns)).toBe("their"));
  it("renders {POSS_PRO} → theirs", () => expect(renderFact("{POSS_PRO}", name, pronouns)).toBe("theirs"));
  it("renders {REFL} → themselves", () => expect(renderFact("{REFL}", name, pronouns)).toBe("themselves"));
});

describe("renderFact — verb conjugation {singular|plural}", () => {
  it("uses singular form for he/him", () => {
    expect(renderFact("{has|have}", "Dave", "he/him")).toBe("has");
    expect(renderFact("{doesn't|don't}", "Dave", "he/him")).toBe("doesn't");
    expect(renderFact("{was|were}", "Dave", "he/him")).toBe("was");
  });

  it("uses singular form for she/her", () => {
    expect(renderFact("{has|have}", "Alice", "she/her")).toBe("has");
  });

  it("uses plural form for they/them", () => {
    expect(renderFact("{has|have}", "Sam", "they/them")).toBe("have");
    expect(renderFact("{doesn't|don't}", "Sam", "they/them")).toBe("don't");
    expect(renderFact("{was|were}", "Sam", "they/them")).toBe("were");
  });

  it("defaults to he/him when no pronouns argument given", () => {
    expect(renderFact("{has|have}", "Dave")).toBe("has");
  });

  // Regression: the reported "They keeps" bug. Once the tokenizer wraps the verb
  // as {keeps|keep}, the renderer must agree the verb with the pronoun's number.
  it("renders the conjugated 'keeps' template correctly for both numbers", () => {
    const template = "{NAME} caught the Corona virus. {Subj} {keeps|keep} it locked up in {POSS} back yard.";
    expect(renderFact(template, "Alex Jordan", "they/them")).toBe(
      "Alex Jordan caught the Corona virus. They keep it locked up in their back yard.",
    );
    expect(renderFact(template, "Alex Jordan", "he/him")).toBe(
      "Alex Jordan caught the Corona virus. He keeps it locked up in his back yard.",
    );
  });
});

describe("renderFact — neopronouns (ze/zir)", () => {
  it("renders ze/zir pronoun set", () => {
    expect(renderFact("{SUBJ}", "Zey", "ze/zir")).toBe("ze");
    expect(renderFact("{OBJ}", "Zey", "ze/zir")).toBe("zir");
    expect(renderFact("{REFL}", "Zey", "ze/zir")).toBe("zirself");
  });

  it("uses singular verb form for ze pronouns", () => {
    expect(renderFact("{has|have}", "Zey", "ze/zir")).toBe("has");
  });
});

describe("renderFact — subject-pronoun contraction ({Subj}'s / {SUBJ}'s / legacy {He's}) never renders 'they's'", () => {
  const cases: Array<[string, string]> = [
    ["he/him", "He's"],
    ["she/her", "She's"],
    ["they/them", "They are"],
  ];

  for (const [pronouns, expectedSubj] of cases) {
    it(`renders {Subj}'s unstoppable → "${expectedSubj} unstoppable" for ${pronouns}`, () => {
      expect(renderFact("{Subj}'s unstoppable", "Dave", pronouns)).toBe(`${expectedSubj} unstoppable`);
    });
  }

  it("renders {SUBJ}'s (lowercase, mid-sentence) correctly for he/him and they/them", () => {
    expect(renderFact("everyone knows {SUBJ}'s unstoppable", "Dave", "he/him")).toBe(
      "everyone knows he's unstoppable",
    );
    expect(renderFact("everyone knows {SUBJ}'s unstoppable", "Sam", "they/them")).toBe(
      "everyone knows they are unstoppable",
    );
  });

  it("handles a curly apostrophe the same as a straight one", () => {
    expect(renderFact("{Subj}’s unstoppable", "Sam", "they/them")).toBe("They are unstoppable");
  });

  it("renders legacy {He's}/{he's} without ever producing 'they's'", () => {
    expect(renderFact("{He's} unstoppable", "Dave", "he/him")).toBe("He's unstoppable");
    expect(renderFact("{he's} unstoppable", "Dave", "he/him")).toBe("he's unstoppable");
    expect(renderFact("{He's} unstoppable", "Sam", "they/them")).toBe("They are unstoppable");
    expect(renderFact("{he's} unstoppable", "Sam", "they/them")).toBe("they are unstoppable");
  });

  it("renders {Subj}'s correctly for a custom plural pronoun set", () => {
    const customPlural = "they|them|their|theirs|themselves|p";
    expect(renderFact("{Subj}'s unstoppable", "Sam", customPlural)).toBe("They are unstoppable");
  });

  it("renders {Subj}'s correctly for a custom singular pronoun set", () => {
    const customSingular = "xe|xem|xyr|xyrs|xemself|s";
    expect(renderFact("{Subj}'s unstoppable", "Alex", customSingular)).toBe("Xe's unstoppable");
  });

  it("never produces the literal string 'they's' across any of the above paths", () => {
    const outputs = [
      renderFact("{Subj}'s unstoppable", "Sam", "they/them"),
      renderFact("{SUBJ}'s unstoppable", "Sam", "they/them"),
      renderFact("{He's} unstoppable", "Sam", "they/them"),
      renderFact("{he's} unstoppable", "Sam", "they/them"),
    ];
    for (const output of outputs) {
      expect(output.toLowerCase()).not.toContain("they's");
    }
  });

  // Codex review finding: for a PLURAL viewer, "'s got"/"'s been"/"'s had"
  // must render "have", not "are" — "They are got the keys" is not English.
  // (For a SINGULAR viewer the bare contraction is always fine either way.)
  describe("has-only-following-word disambiguation", () => {
    it("renders 'have' (not 'are') for they/them when the contraction means has", () => {
      expect(renderFact("{Subj}'s got the keys", "Sam", "they/them")).toBe("They have got the keys");
      expect(renderFact("{SUBJ}'s been there before", "Sam", "they/them")).toBe("they have been there before");
      expect(renderFact("{Subj}'s had enough", "Sam", "they/them")).toBe("They have had enough");
      expect(renderFact("{Subj}'s gotten away with it", "Sam", "they/them")).toBe("They have gotten away with it");
    });

    it("renders the legacy {He's}/{he's} token as 'have' for they/them when it means has", () => {
      expect(renderFact("{He's} got the keys", "Sam", "they/them")).toBe("They have got the keys");
      expect(renderFact("{he's} been there before", "Sam", "they/them")).toBe("they have been there before");
    });

    it("still renders the copula 'are' for they/them on ambiguous/unrelated words", () => {
      expect(renderFact("{Subj}'s unstoppable", "Sam", "they/them")).toBe("They are unstoppable");
      // "done" is genuinely ambiguous — deliberately left on the "are" default.
      expect(renderFact("{Subj}'s done", "Sam", "they/them")).toBe("They are done");
    });

    it("leaves singular sets unaffected (the bare contraction is valid either way)", () => {
      expect(renderFact("{Subj}'s got the keys", "Dave", "he/him")).toBe("He's got the keys");
    });

    it("is case-insensitive for the following word", () => {
      expect(renderFact("{Subj}'s GOT the keys", "Sam", "they/them")).toBe("They have GOT the keys");
    });
  });
});

describe("renderFactSegments — subject-pronoun contraction never renders 'they's'", () => {
  it("expands {Subj}'s for they/them within segments", () => {
    expect(renderFactSegments("{NAME} says {Subj}'s unstoppable", "Sam", "they/them")).toEqual([
      { text: "Sam", isName: true },
      { text: " says They are unstoppable", isName: false },
    ]);
  });

  it("renders 'have' (not 'are') within segments when the contraction means has", () => {
    expect(renderFactSegments("{NAME} says {Subj}'s got the keys", "Sam", "they/them")).toEqual([
      { text: "Sam", isName: true },
      { text: " says They have got the keys", isName: false },
    ]);
  });
});

describe("renderFact — legacy tokens", () => {
  it("replaces {He}/{he} with subject pronoun", () => {
    expect(renderFact("{He} laughed", "Dave", "he/him")).toBe("He laughed");
    expect(renderFact("{he} laughed", "Dave", "he/him")).toBe("he laughed");
  });

  it("replaces {Him}/{him} with object pronoun", () => {
    expect(renderFact("told {Him}", "Dave", "he/him")).toBe("told Him");
    expect(renderFact("told {him}", "Dave", "he/him")).toBe("told him");
  });

  it("replaces {His}/{his} with possessive pronoun", () => {
    expect(renderFact("{His} car", "Dave", "he/him")).toBe("His car");
    expect(renderFact("{his} car", "Dave", "he/him")).toBe("his car");
  });

  it("replaces {Himself}/{himself} with reflexive", () => {
    expect(renderFact("{Himself} said", "Dave", "he/him")).toBe("Himself said");
    expect(renderFact("{himself} said", "Dave", "he/him")).toBe("himself said");
  });
});

describe("renderFact — custom pipe-delimited pronouns", () => {
  it("renders custom pronoun set (xe/xem/xyr)", () => {
    // Custom format: "subj|obj|poss|possPro|refl|s"
    const custom = "xe|xem|xyr|xyrs|xemself|s";
    expect(renderFact("{SUBJ}", "Alex", custom)).toBe("xe");
    expect(renderFact("{OBJ}", "Alex", custom)).toBe("xem");
    expect(renderFact("{POSS}", "Alex", custom)).toBe("xyr");
    expect(renderFact("{POSS_PRO}", "Alex", custom)).toBe("xyrs");
    expect(renderFact("{REFL}", "Alex", custom)).toBe("xemself");
  });

  it("uses singular verb form for custom singular set", () => {
    const custom = "xe|xem|xyr|xyrs|xemself|s";
    expect(renderFact("{has|have}", "Alex", custom)).toBe("has");
  });

  it("uses plural verb form for custom plural set", () => {
    const custom = "they|them|their|theirs|themselves|p";
    expect(renderFact("{has|have}", "Sam", custom)).toBe("have");
  });
});

describe("renderFact — full sentence", () => {
  it("renders a complete tokenized template with he/him", () => {
    const template = "{NAME} {has|have} always been proud of {POSS} work. {Subj} {does|do} {REFL} justice.";
    expect(renderFact(template, "Dave", "he/him")).toBe(
      "Dave has always been proud of his work. He does himself justice.",
    );
  });

  it("renders a complete tokenized template with she/her", () => {
    const template = "{NAME} {has|have} always been proud of {POSS} work. {Subj} {does|do} {REFL} justice.";
    expect(renderFact(template, "Alice", "she/her")).toBe(
      "Alice has always been proud of her work. She does herself justice.",
    );
  });

  it("renders a complete tokenized template with they/them", () => {
    const template = "{NAME} {has|have} always been proud of {POSS} work. {Subj} {do|do} {REFL} justice.";
    expect(renderFact(template, "Sam", "they/them")).toBe(
      "Sam have always been proud of their work. They do themselves justice.",
    );
  });
});

// ── tokenizeFact ─────────────────────────────────────────────────────────────

describe("tokenizeFact", () => {
  it("replaces 'He' with {Subj}", () => {
    expect(tokenizeFact("He ran fast")).toBe("{Subj} ran fast");
  });

  it("replaces 'he' with {SUBJ}", () => {
    expect(tokenizeFact("She said he ran")).toBe("She said {SUBJ} ran");
  });

  it("expands 'He's'/'he's' to the {is|are} pair, never {Subj}'s", () => {
    expect(tokenizeFact("He's unstoppable")).toBe("{Subj} {is|are} unstoppable");
    expect(tokenizeFact("everyone knows he's unstoppable")).toBe(
      "everyone knows {SUBJ} {is|are} unstoppable",
    );
  });

  it("expands 'He's'/'he's' to {has|have} when followed by a has-only word", () => {
    expect(tokenizeFact("He's got the keys")).toBe("{Subj} {has|have} got the keys");
    expect(tokenizeFact("he's been there before")).toBe("{SUBJ} {has|have} been there before");
  });

  it("replaces 'Him' with {Obj}", () => {
    expect(tokenizeFact("Told Him to go")).toBe("Told {Obj} to go");
  });

  it("replaces 'him' with {OBJ}", () => {
    expect(tokenizeFact("told him to go")).toBe("told {OBJ} to go");
  });

  it("replaces 'His' with {Poss}", () => {
    expect(tokenizeFact("His car is fast")).toBe("{Poss} car is fast");
  });

  it("replaces 'his' with {POSS}", () => {
    expect(tokenizeFact("lost his keys")).toBe("lost {POSS} keys");
  });

  it("replaces 'Himself' with {REFL}", () => {
    expect(tokenizeFact("He hurt Himself")).toBe("{Subj} hurt {REFL}");
  });

  it("replaces 'himself' with {REFL}", () => {
    expect(tokenizeFact("he hurt himself")).toBe("{SUBJ} hurt {REFL}");
  });

  it("replaces legacy name tokens", () => {
    expect(tokenizeFact("{First_Name} {Last_Name} is great")).toBe("{NAME} is great");
    expect(tokenizeFact("{First_Name}   {Last_Name} space")).toBe("{NAME} space");
  });

  it("leaves unrelated text unchanged", () => {
    expect(tokenizeFact("no tokens here")).toBe("no tokens here");
  });
});

// ── hasPronouns ───────────────────────────────────────────────────────────────

describe("hasPronouns", () => {
  it("returns true for templates with {SUBJ}", () => {
    expect(hasPronouns("{SUBJ} ran")).toBe(true);
  });

  it("returns true for {singular|plural} verb conjugation", () => {
    expect(hasPronouns("{has|have} done")).toBe(true);
  });

  it("returns true for legacy {he} token", () => {
    expect(hasPronouns("{he} said")).toBe(true);
  });

  it("returns true for {NAME} in a pronoun-containing template", () => {
    expect(hasPronouns("{NAME} and {SUBJ}")).toBe(true);
  });

  it("returns false for plain text with no tokens", () => {
    expect(hasPronouns("no tokens here")).toBe(false);
  });

  it("returns false for a template with only {NAME}", () => {
    // {NAME} alone is not a pronoun — just a name substitution
    expect(hasPronouns("{NAME} is great")).toBe(false);
  });

  it("returns true for neopronoun forms in {OBJ}", () => {
    expect(hasPronouns("{OBJ} helped")).toBe(true);
  });
});
