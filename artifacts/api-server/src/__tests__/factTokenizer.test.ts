import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  postProcessTokenizedTemplate,
  stripUnknownTokens,
  TOKENIZER_MODEL,
  TOKENIZER_REASONING_EFFORT,
  TOKENIZER_ALLOWED_MODELS,
} from "../lib/factTokenizer.js";
import { validateTemplate } from "../lib/templateGrammar.js";

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
});
