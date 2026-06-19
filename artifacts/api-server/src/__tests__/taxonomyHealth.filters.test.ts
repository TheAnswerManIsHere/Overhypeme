/**
 * Health-filter predicate tests.
 *
 * `matchesHealthFilter` is the single predicate the summary counts AND the
 * facts list both use, so a card's number can never disagree with the rows it
 * lists. These pure tests pin the two historical bugs:
 *   • "Healthy" returned every row (its filter was "any").
 *   • "Semantic entities need review" counted 1 but listed 8 (count used the
 *     warning-only flag; list used the broad status set incl. cap hints).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFICATION_PROMPT_VERSION,
  SUMMARY_COUNT_TO_FILTER,
  matchesHealthFilter,
  type FactTaxonomyHealth,
  type TaxonomyHealthSummaryCounts,
  type TaxonomyHealthFilter,
} from "@workspace/api-zod";
import { evaluateFactTaxonomyHealth } from "../lib/taxonomyHealth";

function validEnrichment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["a", "b", "c"],
    taxonomyConfidence: 0.95,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    enrichedBy: "openai",
    ...overrides,
  };
}

const MATCHING_COLS = {
  primaryArchetype: "superhuman_physical_feat" as const,
  subtype: "force_scaled_action" as const,
  overhypeFit: "strong" as const,
  adultSuitability: "safe" as const,
};

function evalFact(
  factId: number,
  factText: string,
  enrichment: Record<string, unknown> | null,
): FactTaxonomyHealth {
  return evaluateFactTaxonomyHealth({
    fact: { factId, factText, enrichment, ...MATCHING_COLS },
  });
}

describe("matchesHealthFilter", () => {
  // A fully healthy fact (matching columns, current versions, has a plan).
  const healthy = evalFact(1, "A neutral fact about pencils.", validEnrichment());
  // Healthy overall BUT carries an info-level capitalization hint (text has a
  // cap-sensitive term "sun" and no semantic entities).
  const capHint = evalFact(2, "He stared at the sun.", validEnrichment());
  // No enrichment at all.
  const missing = evalFact(3, "Neutral fact.", null);

  it("healthy matches only overallStatus === 'healthy' (never returns everything)", () => {
    assert.equal(healthy.overallStatus, "healthy");
    assert.equal(matchesHealthFilter(healthy, "healthy"), true);
    assert.equal(matchesHealthFilter(missing, "healthy"), false);
  });

  it("semantic_entities_need_review includes info-level capitalization hints", () => {
    assert.equal(capHint.overallStatus, "healthy"); // info hint doesn't break it
    assert.equal(matchesHealthFilter(capHint, "semantic_entities_need_review"), true);
    // …and the cap-hint fact is overlapping: it's also Healthy.
    assert.equal(matchesHealthFilter(capHint, "healthy"), true);
  });

  it("count and list use the SAME predicate for every card (no divergence)", () => {
    const facts = [healthy, capHint, missing];
    // Tally the summary exactly as the route does — via SUMMARY_COUNT_TO_FILTER.
    const summary = {
      healthy: 0, missingEnrichment: 0, invalidEnrichment: 0, needsAdminReview: 0,
      staleEnrichmentVersion: 0,
      projectionMismatch: 0, incompleteCulturalReferences: 0,
      semanticEntitiesNeedReview: 0, lowConfidence: 0,
    } as Omit<TaxonomyHealthSummaryCounts, "totalFacts">;
    for (const h of facts) {
      for (const [key, filter] of Object.entries(SUMMARY_COUNT_TO_FILTER) as Array<
        [keyof typeof summary, TaxonomyHealthFilter]
      >) {
        if (matchesHealthFilter(h, filter)) summary[key]++;
      }
    }
    // For each card, the count must equal the list length under the same filter.
    for (const [key, filter] of Object.entries(SUMMARY_COUNT_TO_FILTER) as Array<
      [keyof typeof summary, TaxonomyHealthFilter]
    >) {
      const listLen = facts.filter((h) => matchesHealthFilter(h, filter)).length;
      assert.equal(summary[key], listLen, `count/list mismatch for ${key}`);
    }
    // Concrete sanity: 2 healthy (healthy + capHint), 1 semantic, 1 missing.
    assert.equal(summary.healthy, 2);
    assert.equal(summary.semanticEntitiesNeedReview, 1);
    assert.equal(summary.missingEnrichment, 1);
  });
});
