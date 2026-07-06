import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  postProcessTokenizedTemplate,
  stripUnknownTokens,
  TOKENIZER_MODEL,
  TOKENIZER_REASONING_EFFORT,
  TOKENIZER_ALLOWED_MODELS,
  collapseNameSubjectConjugationPairs,
  TOKENIZE_SYSTEM_PROMPT,
} from "../lib/factTokenizer.js";
import {
  validateTemplate,
  collapseIdenticalConjugationBranches,
  applyDeterministicGrammar,
} from "../lib/templateGrammar.js";

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

  it("expands a subject-pronoun contraction and flags contractionExpanded, without touching other flags", () => {
    const { template, nameCollapsed, contractionExpanded, conjugated, collapsed } =
      postProcessTokenizedTemplate("{Subj}'s unstoppable");
    assert.equal(template, "{Subj} {is|are} unstoppable");
    assert.equal(contractionExpanded, true);
    assert.equal(nameCollapsed, false);
    assert.equal(conjugated, false);
    assert.equal(collapsed, false);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("reports contractionExpanded=false when there is no subject contraction", () => {
    const { contractionExpanded } = postProcessTokenizedTemplate("{Subj} keeps it");
    assert.equal(contractionExpanded, false);
  });

  it("parity: postProcessTokenizedTemplate matches applyDeterministicGrammar(stripUnknownTokens(raw))", () => {
    const cases = [
      "When {NAME} {gives|give} you the finger, {Subj} {is|are} telling you how many seconds you have left to live.",
      "{NAME} caught the Corona virus. {Subj} keeps it locked up in {POSS} back yard.",
      "{Subj} {can|can} fill up an electric car at a gas station.",
      "{Subj}'s unstoppable and {NAME} {gives|give} you the finger.",
      "{When} {NAME} laughs",
    ];
    for (const raw of cases) {
      const { template } = postProcessTokenizedTemplate(raw);
      assert.equal(template, applyDeterministicGrammar(stripUnknownTokens(raw)));
    }
  });
});

describe("factTokenizer — TOKENIZE_SYSTEM_PROMPT policy", () => {
  it("instructs the model to never leave a bare subject-pronoun 's contraction", () => {
    assert.match(TOKENIZE_SYSTEM_PROMPT, /never valid English/i);
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{SUBJ\}\s*\{is\|are\}/);
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{SUBJ\}\s*\{has\|have\}/);
  });

  it("includes a coordinated shared-subject example and a new-subject contrast", () => {
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{runs\|run\}\s+and\s+\{hides\|hide\}/);
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{runs\|run\}\s+and\s+dogs\s+bark/);
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

  // The object-separated collapse pass reaches a pair after an intervening
  // object, as long as the pair sits directly after the coordinating
  // conjunction (+ adverbs) — see templateGrammar.test.ts for the full
  // positive/negative/punctuation-boundary coverage of this pass.
  it("reaches a pair separated from {NAME} by an object, when it sits directly after the conjunction", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} eats cake and {drinks|drink} soda"),
      "{NAME} eats cake and drinks soda",
    );
  });

  it("does not reach a pair when a noun sits between the conjunction and the pair", () => {
    const input = "{NAME} eats and dogs {barks|bark}";
    assert.equal(collapseNameSubjectConjugationPairs(input), input);
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
