import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandSubjectContractionsForBackfill } from "../lib/expandSubjectContractionBackfill.js";
import { validateTemplate } from "../lib/templateGrammar.js";

describe("expandSubjectContractionsForBackfill", () => {
  it("expands the legacy {He's} token", () => {
    assert.equal(
      expandSubjectContractionsForBackfill("{He's} unstoppable"),
      "{Subj} {is|are} unstoppable",
    );
  });

  it("expands the legacy {he's} token", () => {
    assert.equal(
      expandSubjectContractionsForBackfill("everyone knows {he's} unstoppable"),
      "everyone knows {SUBJ} {is|are} unstoppable",
    );
  });

  it("expands the current {Subj}'s contraction", () => {
    assert.equal(
      expandSubjectContractionsForBackfill("{Subj}'s unstoppable"),
      "{Subj} {is|are} unstoppable",
    );
  });

  it("expands the current {SUBJ}'s contraction", () => {
    assert.equal(
      expandSubjectContractionsForBackfill("everyone knows {SUBJ}'s unstoppable"),
      "everyone knows {SUBJ} {is|are} unstoppable",
    );
  });

  it("expands a mixed row with more than one contraction form", () => {
    assert.equal(
      expandSubjectContractionsForBackfill("{He's} unstoppable, and {SUBJ}'s fast, {he's} also strong."),
      "{Subj} {is|are} unstoppable, and {SUBJ} {is|are} fast, {SUBJ} {is|are} also strong.",
    );
  });

  it("leaves a row with no contraction unchanged", () => {
    const input = "{NAME} caught the Corona virus. {Subj} {keeps|keep} it locked up in {POSS} back yard.";
    assert.equal(expandSubjectContractionsForBackfill(input), input);
  });

  it("leaves an already-expanded pair unchanged", () => {
    const input = "{Subj} {is|are} unstoppable";
    assert.equal(expandSubjectContractionsForBackfill(input), input);
  });

  it("is idempotent", () => {
    const inputs = [
      "{He's} unstoppable",
      "{he's} unstoppable",
      "{Subj}'s unstoppable",
      "{SUBJ}'s unstoppable",
      "{He's} unstoppable, and {SUBJ}'s fast, {he's} also strong.",
    ];
    for (const input of inputs) {
      const once = expandSubjectContractionsForBackfill(input);
      assert.equal(expandSubjectContractionsForBackfill(once), once);
    }
  });

  it("produces output that always passes validateTemplate", () => {
    const inputs = [
      "{He's} unstoppable",
      "{he's} unstoppable",
      "{Subj}'s unstoppable",
      "{SUBJ}'s unstoppable",
      "{NAME} caught the virus. {He's} keeping it locked up in {POSS} back yard.",
    ];
    for (const input of inputs) {
      const output = expandSubjectContractionsForBackfill(input);
      assert.deepEqual(validateTemplate(output), { valid: true }, `expected "${output}" to be a valid template`);
    }
  });

  // Codex review finding: the legacy {He's} token needs the same has/is
  // disambiguation as the current {Subj}'s contraction, or backfilling old
  // rows like "{He's} got the keys" would produce "They are got the keys".
  it("expands the legacy {He's} token to {has|have} when followed by a has-only word", () => {
    assert.equal(
      expandSubjectContractionsForBackfill("{He's} got the keys"),
      "{Subj} {has|have} got the keys",
    );
    assert.equal(
      expandSubjectContractionsForBackfill("{he's} been there before"),
      "{SUBJ} {has|have} been there before",
    );
  });

  it("still defaults the legacy token to the copula for ambiguous/unrelated words", () => {
    assert.equal(expandSubjectContractionsForBackfill("{He's} unstoppable"), "{Subj} {is|are} unstoppable");
  });
});
