/**
 * Reference research validator unit tests.
 *
 * Exercises validateReferenceResearchResult against the wire schema + the
 * business rules: non-empty explanation/visualImplication, visual-guidance
 * heuristic, high-confidence-needs-sources rule for public references,
 * forbidden-directive rejection (real logo / brand mark / full fact text /
 * hashtags). Pure unit tests — no DB, no LLM, no IO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateReferenceResearchResult,
  computeCanAutoApplyToEmptyFields,
  type ReferenceResearchResultWire,
} from "@workspace/api-zod";

const VALID_VISUAL_IMPLICATION =
  "Show an elegant boutique fashion-retail setting with velvet curtain, soft lighting, runway-style staging.";

function baseResult(overrides: Partial<ReferenceResearchResultWire> = {}): ReferenceResearchResultWire {
  return {
    explanation:
      "Victoria's Secret is a well-known lingerie and fashion retailer. The phrase plays on the brand name as a pun.",
    visualImplication: VALID_VISUAL_IMPLICATION,
    confidence: "high",
    sources: [
      {
        title: "Victoria's Secret — Wikipedia",
        url: "https://en.wikipedia.org/wiki/Victoria%27s_Secret",
        sourceType: "encyclopedic",
        summary: "Background on the brand and its retail format.",
      },
    ],
    researchNotes: "Brand-name pun; preserve secret/mystery vibe + fashion-retail context.",
    ambiguityWarnings: [],
    ...overrides,
  };
}

describe("validateReferenceResearchResult", () => {
  it("accepts a valid public-reference result with sources", () => {
    const r = validateReferenceResearchResult(baseResult(), {
      referenceType: "brand_or_cultural_reference",
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("rejects empty explanation", () => {
    const r = validateReferenceResearchResult(baseResult({ explanation: "   " }), {
      referenceType: "brand_or_cultural_reference",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /explanation/);
  });

  it("rejects empty visualImplication", () => {
    const r = validateReferenceResearchResult(baseResult({ visualImplication: "" }), {
      referenceType: "brand_or_cultural_reference",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /visualImplication/);
  });

  it("rejects a visualImplication that is just a definition (no visual guidance)", () => {
    const r = validateReferenceResearchResult(
      baseResult({
        visualImplication:
          "Apple is a technology company that makes phones and computers.",
      }),
      { referenceType: "brand_or_cultural_reference" },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /visual guidance/);
  });

  it("rejects high confidence on a public reference without sources", () => {
    const r = validateReferenceResearchResult(
      baseResult({ confidence: "high", sources: [] }),
      { referenceType: "brand_or_cultural_reference" },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /source/);
  });

  it("accepts medium confidence on a public reference without sources", () => {
    const r = validateReferenceResearchResult(
      baseResult({ confidence: "medium", sources: [] }),
      { referenceType: "brand_or_cultural_reference" },
    );
    assert.equal(r.ok, true);
  });

  it("accepts high confidence on a professional/insider reference without sources", () => {
    const r = validateReferenceResearchResult(
      baseResult({ sources: [] }),
      { referenceType: "professional_or_insider_reference" },
    );
    // Insider references aren't in the public set; the rule doesn't apply.
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("rejects when explanation tells the image to render a real logo", () => {
    const r = validateReferenceResearchResult(
      baseResult({
        explanation:
          "Render the real Apple logo prominently to identify the brand.",
      }),
      { referenceType: "brand_or_cultural_reference" },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /forbidden/);
  });

  it("rejects when visualImplication tells the image to render the full fact text", () => {
    const r = validateReferenceResearchResult(
      baseResult({
        visualImplication: "Render the full fact text across the image and show a runway.",
      }),
      { referenceType: "brand_or_cultural_reference" },
    );
    assert.equal(r.ok, false);
  });
});

// #672: the forbidden-content check must judge each mention of a forbidden
// noun by what is said about it, not by whether a render verb and the noun
// both appear anywhere in the field. Telling the image model to AVOID logos is
// the guidance the system prompt asks for, not a violation.
describe("validateReferenceResearchResult — forbidden directives (#672)", () => {
  const check = (visualImplication: string) =>
    validateReferenceResearchResult(baseResult({ visualImplication }), { referenceType: "brand" });

  // Sol's live answer for "{NAME} rides a Peloton to the moon" (2026-10-13), rejected before the fix.
  const SOL_PELOTON =
    "Show {NAME} as the heroic central rider, confidently pedaling a stationary exercise bike through space toward a large, cratered moon, with Earth receding behind them. Preserve recognizable exercise-bike features—a fixed support base, flywheel, handlebars, and mounted workout screen—so the absurdity of stationary equipment traveling is clear. Use a motion trail to suggest that {NAME}'s pedaling drives the journey. Show actual lunar travel, NOT an ordinary indoor workout with a moon image on the screen, NOT a road bicycle, and NOT a cyclist riding within a racing peloton. Avoid logos, brand marks, readable fact text, and hashtags.";

  it("accepts guidance that tells the image model to avoid forbidden content", () => {
    for (const text of [
      SOL_PELOTON,
      "Show a gleaming boutique storefront. Avoid the brand logo.",
      "Show the runner mid-stride; do not show any logo or hashtag.",
      "Display a neon-lit arcade with no logos, no brand marks and no hashtags.",
      "Show the shoe's silhouette without the logo.",
      "Use a stadium setting. Never render the full fact text.",
      "Show a coffee cup, but don't display the logo anywhere.",
    ]) {
      const r = check(text);
      assert.equal(r.ok, true, `${text}\n→ ${r.ok ? "" : r.error}`);
    }
  });

  it("rejects guidance that tells the image model to render forbidden content, singular or plural", () => {
    for (const text of [
      "Render the real Apple logo prominently to identify the brand.",
      "Show the Nike logos across the jersey.",
      "Display hashtags floating in the sky above the runner.",
      "Use the official brand mark on the storefront sign.",
      "Avoid clutter, but show the Peloton logo on the bike.",
      "Show a runway. Render the full fact text across the bottom.",
    ]) {
      // In the explanation, so only the forbidden-directive rule can reject it.
      const r = validateReferenceResearchResult(baseResult({ explanation: text }), { referenceType: "brand" });
      assert.equal(r.ok, false, text);
      if (!r.ok) assert.match(r.error, /forbidden/);
    }
  });
});

describe("computeCanAutoApplyToEmptyFields", () => {
  it("returns true for high confidence + sources + no warnings", () => {
    const auto = computeCanAutoApplyToEmptyFields(baseResult(), "brand_or_cultural_reference");
    assert.equal(auto, true);
  });

  it("returns false for low confidence", () => {
    const auto = computeCanAutoApplyToEmptyFields(
      baseResult({ confidence: "low" }),
      "brand_or_cultural_reference",
    );
    assert.equal(auto, false);
  });

  it("returns false when ambiguity warnings exist", () => {
    const auto = computeCanAutoApplyToEmptyFields(
      baseResult({ ambiguityWarnings: ["Could mean fruit or brand"] }),
      "brand_or_cultural_reference",
    );
    assert.equal(auto, false);
  });

  it("returns false for public references without sources", () => {
    const auto = computeCanAutoApplyToEmptyFields(
      baseResult({ confidence: "medium", sources: [] }),
      "brand_or_cultural_reference",
    );
    assert.equal(auto, false);
  });

  it("returns true for insider references without sources at medium confidence", () => {
    const auto = computeCanAutoApplyToEmptyFields(
      baseResult({ confidence: "medium", sources: [] }),
      "professional_or_insider_reference",
    );
    assert.equal(auto, true);
  });
});
