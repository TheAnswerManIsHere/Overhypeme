import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  postProcessTokenizedTemplate,
  stripUnknownTokens,
  TOKENIZER_MODEL,
  TOKENIZER_REASONING_EFFORT,
  TOKENIZER_ALLOWED_MODELS,
  collapseNameSubjectConjugationPairs,
} from "../lib/factTokenizer.js";
import { validateTemplate, collapseIdenticalConjugationBranches } from "../lib/templateGrammar.js";

describe("factTokenizer — tokenizer model policy", () => {
  it("defaults to gpt-5.4-mini with low reasoning", () => {
    assert.equal(TOKENIZER_MODEL, "gpt-5.4-mini");
    assert.equal(TOKENIZER_REASONING_EFFORT, "low");
  });

  it("keeps the default model in the code-owned allowlist", () => {
    assert.ok(TOKENIZER_ALLOWED_MODELS.has(TOKENIZER_MODEL));
    // gpt-5.5 stays available as the documented escalation.
    assert.ok(TOKENIZER_ALLOWED_MODELS.has("gpt-5.5"));
  });
});

describe("factTokenizer — stripUnknownTokens", () => {
  it("strips braces from hallucinated non-tokens", () => {
    assert.equal(stripUnknownTokens("{When} {NAME} laughs"), "When {NAME} laughs");
  });

  it("preserves valid simple tokens — including {NAME_POSSESSIVE} (no allowlist drift)", () => {
    const t = "{NAME_POSSESSIVE} legend keeps growing.";
    assert.equal(stripUnknownTokens(t), t);
  });

  it("preserves conjugation pairs", () => {
    assert.equal(stripUnknownTokens("{Subj} {keeps|keep} it"), "{Subj} {keeps|keep} it");
  });
});

describe("factTokenizer — postProcessTokenizedTemplate", () => {
  it("collapses a name-subject conjugation pair, flags nameCollapsed, and touches no other flag", () => {
    const { template, nameCollapsed, conjugated, collapsed } = postProcessTokenizedTemplate(
      "When {NAME} {gives|give} you the finger, {Subj} {is|are} telling you how many seconds you have left to live.",
    );
    assert.equal(
      template,
      "When {NAME} gives you the finger, {Subj} {is|are} telling you how many seconds you have left to live.",
    );
    assert.equal(nameCollapsed, true);
    assert.equal(conjugated, false);
    assert.equal(collapsed, false);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("reports nameCollapsed=false when no name-subject pair exists", () => {
    const { nameCollapsed } = postProcessTokenizedTemplate("{Subj} {keeps|keep} it");
    assert.equal(nameCollapsed, false);
  });

  it("conjugates a missed person-subject verb and flags it", () => {
    const { template, conjugated } = postProcessTokenizedTemplate(
      "{NAME} caught the Corona virus. {Subj} keeps it locked up in {POSS} back yard.",
    );
    assert.equal(
      template,
      "{NAME} caught the Corona virus. {Subj} {keeps|keep} it locked up in {POSS} back yard.",
    );
    assert.equal(conjugated, true);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("preserves {NAME_POSSESSIVE} and does not conjugate when no subject token precedes the verb", () => {
    const { template, conjugated } = postProcessTokenizedTemplate("{NAME_POSSESSIVE} legend keeps growing.");
    assert.equal(template, "{NAME_POSSESSIVE} legend keeps growing.");
    assert.equal(conjugated, false);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("reports conjugated=false when the template is already correct", () => {
    const { template, conjugated } = postProcessTokenizedTemplate("{Subj} {keeps|keep} it");
    assert.equal(template, "{Subj} {keeps|keep} it");
    assert.equal(conjugated, false);
  });

  it("collapses an identical conjugation branch and flags it WITHOUT touching `conjugated`", () => {
    const { template, conjugated, collapsed } = postProcessTokenizedTemplate(
      "{Subj} {can|can} fill up an electric car at a gas station.",
    );
    assert.equal(template, "{Subj} can fill up an electric car at a gas station.");
    // The collapse is its own pass — the auto-conjugation net did nothing here.
    assert.equal(conjugated, false);
    assert.equal(collapsed, true);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("leaves a legitimate conjugation pair untouched (collapsed=false)", () => {
    const { template, collapsed } = postProcessTokenizedTemplate("{Subj} {is|are} unstoppable");
    assert.equal(template, "{Subj} {is|are} unstoppable");
    assert.equal(collapsed, false);
  });
});

describe("factTokenizer — collapseNameSubjectConjugationPairs", () => {
  it("keeps the singular branch for verbs directly following {NAME}", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("When {NAME} {gives|give} you the finger"),
      "When {NAME} gives you the finger",
    );
  });

  it("handles a skippable adverb between {NAME} and the pair", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} always {runs|run} toward danger"),
      "{NAME} always runs toward danger",
    );
  });

  it("leaves pronoun-subject pairs untouched", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{Subj} {gives|give} you the finger"),
      "{Subj} {gives|give} you the finger",
    );
  });

  // Coordination: every verb sharing the {NAME} subject must collapse, whether
  // the first verb was wrapped or already plain.
  it("collapses coordinated pairs sharing the {NAME} subject", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} {runs|run} and {hides|hide}"),
      "{NAME} runs and hides",
    );
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} never {sleeps|sleep} and never {eats|eat}"),
      "{NAME} never sleeps and never eats",
    );
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} runs and {hides|hide}"),
      "{NAME} runs and hides",
    );
  });

  it("stops the coordination chain at a pronoun subject token", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} {runs|run} or {SUBJ} {hides|hide}"),
      "{NAME} runs or {SUBJ} {hides|hide}",
    );
  });

  // Documented limitation: an object between coordinated verbs ends the chain,
  // so a later {NAME}-subject pair is left as-is (same adjacency reach as the
  // conjugation net).
  it("does not reach a pair separated from {NAME} by an object", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} eats cake and {drinks|drink} soda"),
      "{NAME} eats cake and {drinks|drink} soda",
    );
  });

  // Name possessives are not {NAME}-subject positions.
  it("never fires after possessive forms of the name", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME_POSSESSIVE} dog {barks|bark}"),
      "{NAME_POSSESSIVE} dog {barks|bark}",
    );
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME}'s dog {barks|bark}"),
      "{NAME}'s dog {barks|bark}",
    );
  });

  it("leaves non-person subjects alone", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("Sharks have a {NAME} Week."),
      "Sharks have a {NAME} Week.",
    );
  });

  it("is idempotent (running twice equals running once)", () => {
    const inputs = [
      "When {NAME} {gives|give} you the finger",
      "{NAME} {runs|run} and {hides|hide}",
      "{NAME} runs and {hides|hide}",
      "{NAME} {runs|run} or {SUBJ} {hides|hide}",
    ];
    for (const input of inputs) {
      const once = collapseNameSubjectConjugationPairs(input);
      assert.equal(collapseNameSubjectConjugationPairs(once), once);
    }
  });
});

describe("templateGrammar — collapseIdenticalConjugationBranches", () => {
  it("collapses identical branches to plain text", () => {
    assert.equal(collapseIdenticalConjugationBranches("{NAME} {can|can} fly"), "{NAME} can fly");
    assert.equal(collapseIdenticalConjugationBranches("{Subj} {won't|won't} stop"), "{Subj} won't stop");
  });

  it("collapses multiple duplicates in one template", () => {
    assert.equal(
      collapseIdenticalConjugationBranches("{NAME} {can|can} and {will|will} win"),
      "{NAME} can and will win",
    );
  });

  it("leaves legitimate (non-identical) pairs untouched", () => {
    for (const t of ["{Subj} {is|are} here", "{Subj} {has|have} it", "{NAME} {keeps|keep} going"]) {
      assert.equal(collapseIdenticalConjugationBranches(t), t);
    }
  });

  it("is idempotent and a no-op on empty/plain input", () => {
    const once = collapseIdenticalConjugationBranches("{NAME} {can|can} fly");
    assert.equal(collapseIdenticalConjugationBranches(once), once);
    assert.equal(collapseIdenticalConjugationBranches(""), "");
    assert.equal(collapseIdenticalConjugationBranches("plain text only"), "plain text only");
  });
});
