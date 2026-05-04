import { describe, it, expect } from "vitest";
import { renderFact, tokenizeFact, hasPronouns } from "@/lib/render-fact";

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
