/**
 * Taxonomy regression fixture suite.
 *
 * Twelve canonical fact texts taken from the Taxonomy Health spec. Each
 * fixture pairs a fact with a HAND-AUTHORED expected enrichment shape. The
 * tests assert structurally:
 *
 *   - validateEnrichment accepts the expected blob
 *   - the chosen archetype + subtype belong together
 *   - semantic entities (where required) match expected referent keywords
 *   - cultural references (where required) match expected visualImplication
 *     keywords AND must-avoid keywords
 *   - the taxonomy health evaluator returns "healthy" for the fixture
 *
 * No live LLM. The fixtures lock the shape we want enrichment to produce
 * so regressions in prompts, schemas, or validators surface here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateEnrichment,
  CLASSIFICATION_PROMPT_VERSION,
  SUBTYPES_BY_ARCHETYPE,
  type FactEnrichment,
  type PrimaryArchetype,
} from "@workspace/api-zod";
import { evaluateFactTaxonomyHealth } from "../lib/taxonomyHealth";

interface RegressionFixture {
  id: string;
  factText: string;
  expected: {
    primaryArchetype: PrimaryArchetype;
    subtype: string;
    semanticEntities?: Array<{
      surfaceText: string;
      referentIncludes: string[];
      referentMustAvoid?: string[];
    }>;
    culturalReferences?: Array<{
      sourcePhrase: string;
      visualImplicationIncludes: string[];
      visualImplicationMustAvoid?: string[];
    }>;
  };
}

function buildEnrichment(
  fixture: RegressionFixture,
  taxonomyConfidence = 0.95,
): Record<string, unknown> {
  return {
    primaryArchetype: fixture.expected.primaryArchetype,
    subtype: fixture.expected.subtype,
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["legendary", "overhype", "david"],
    taxonomyConfidence,
    adminReviewNotes: "",
    culturalReferences: (fixture.expected.culturalReferences ?? []).map((r) => ({
      sourcePhrase: r.sourcePhrase,
      referenceType: "cultural_reference",
      canonicalReference: r.sourcePhrase,
      explanation: "regression-fixture explanation",
      visualImplication: r.visualImplicationIncludes.join(" "),
      confidence: 0.9,
      requiresAdminReview: false,
    })),
    semanticEntities: (fixture.expected.semanticEntities ?? []).map((s) => ({
      surfaceText: s.surfaceText,
      normalizedText: s.surfaceText.toLowerCase(),
      entityKind: "common_noun",
      visualReferent: s.referentIncludes.join(" "),
      capitalizationSignal: "lowercase_common_noun",
      materiallyAffectsVisualPrompt: true,
      requiresAdminReview: false,
      confidence: 0.95,
      notes: "",
    })),
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    enrichedBy: "openai",
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const FIXTURES: RegressionFixture[] = [
  {
    id: "pushups_planet_earth",
    factText:
      "When David does pushups, he doesn't push himself up, he pushes the Earth down.",
    expected: {
      primaryArchetype: "superhuman_physical_feat",
      subtype: "ordinary_action_extreme_consequence",
      semanticEntities: [
        {
          surfaceText: "Earth",
          referentIncludes: ["planet"],
          referentMustAvoid: ["dirt", "soil", "ground"],
        },
      ],
    },
  },
  {
    id: "lowercase_earth_as_ground",
    factText: "David hit the earth so hard the dirt apologized.",
    expected: {
      primaryArchetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      semanticEntities: [
        {
          surfaceText: "earth",
          referentIncludes: ["ground"],
          referentMustAvoid: ["planet"],
        },
      ],
    },
  },
  {
    id: "magnifying_glass_at_night",
    factText: "David can set an ant on fire with a magnifying glass. At night.",
    expected: {
      primaryArchetype: "object_logic_impossibility",
      subtype: "medium_contradiction",
    },
  },
  {
    id: "shark_week_david_week",
    factText: "Sharks have a David Week.",
    expected: {
      primaryArchetype: "authority_threat_reversal",
      subtype: "predator_danger_reversal",
      culturalReferences: [
        {
          sourcePhrase: "Shark Week",
          visualImplicationIncludes: ["sharks", "watching", "David", "TV"],
          visualImplicationMustAvoid: ["David swimming with sharks"],
        },
      ],
    },
  },
  {
    id: "victorias_secret",
    factText: "David knows Victoria's secret.",
    expected: {
      primaryArchetype: "intellectual_omniscience",
      subtype: "secret_mastery",
      culturalReferences: [
        {
          sourcePhrase: "Victoria's Secret",
          visualImplicationIncludes: ["boutique", "fashion", "runway"],
          visualImplicationMustAvoid: ["generic mystery vault only"],
        },
      ],
    },
  },
  {
    id: "last_four_digits_of_pi",
    factText: "David's PIN is the last four digits of pi.",
    expected: {
      primaryArchetype: "logic_formal_impossibility",
      subtype: "infinity_impossibility",
    },
  },
  {
    id: "teachers_raise_hands",
    factText: "David's teachers raised their hands when they had questions.",
    expected: {
      primaryArchetype: "authority_threat_reversal",
      subtype: "social_role_reversal",
    },
  },
  {
    id: "baby_drives_mom_home",
    factText: "When David was born, he drove his mom home from the hospital.",
    expected: {
      primaryArchetype: "temporal_causality_inversion",
      subtype: "pre_cause_consequence",
    },
  },
  {
    id: "yardi_demos",
    factText: "David doesn't prepare for demos. Demos prepare for David. #Yardi",
    expected: {
      primaryArchetype: "mundane_act_made_legendary",
      subtype: "work_task_mythologized",
      culturalReferences: [
        {
          sourcePhrase: "Yardi",
          visualImplicationIncludes: ["demo", "dashboard"],
        },
      ],
    },
  },
  {
    id: "water_gets_david",
    factText: "David doesn't get wet. Water gets David.",
    expected: {
      primaryArchetype: "environmental_obedience_immunity",
      subtype: "environmental_agency_inversion",
    },
  },
  {
    id: "system_logs_itself_in",
    factText: "David doesn't need a password. The system logs itself in.",
    expected: {
      primaryArchetype: "technology_system_reaction",
      subtype: "security_system_submission",
    },
  },
  {
    id: "coffee_beans_confess",
    factText:
      "David doesn't brew coffee. He interrogates the beans until they confess.",
    expected: {
      primaryArchetype: "mundane_act_made_legendary",
      subtype: "food_drink_ritualized",
    },
  },
];

describe("taxonomy regression fixtures", () => {
  for (const fixture of FIXTURES) {
    describe(`${fixture.id} — "${fixture.factText.slice(0, 60)}…"`, () => {
      it("expected archetype + subtype belong together (per SUBTYPES_BY_ARCHETYPE)", () => {
        const allowed = SUBTYPES_BY_ARCHETYPE[fixture.expected.primaryArchetype] as readonly string[];
        assert.ok(
          allowed.includes(fixture.expected.subtype),
          `subtype "${fixture.expected.subtype}" is not under archetype "${fixture.expected.primaryArchetype}"`,
        );
      });

      it("synthetic enrichment built from the fixture validates cleanly", () => {
        const raw = buildEnrichment(fixture);
        const result = validateEnrichment(raw);
        assert.equal(result.ok, true, result.ok ? "" : result.error);
      });

      it("evaluator marks the synthetic fixture as healthy", () => {
        const raw = buildEnrichment(fixture);
        const h = evaluateFactTaxonomyHealth({
          fact: {
            factId: 1,
            factText: fixture.factText,
            enrichment: raw,
            primaryArchetype: fixture.expected.primaryArchetype,
            subtype: fixture.expected.subtype,
            overhypeFit: "strong",
            adultSuitability: "safe",
          },
        });
        assert.equal(h.overallStatus, "healthy", `expected healthy, got ${h.overallStatus}; issues=${JSON.stringify(h.issues)}`);
      });

      const semanticEntities = fixture.expected.semanticEntities ?? [];
      if (semanticEntities.length > 0) {
        it("semantic entity visualReferents include the expected words and avoid the forbidden ones", () => {
          for (const expected of semanticEntities) {
            const referent = expected.referentIncludes.join(" ").toLowerCase();
            for (const word of expected.referentIncludes) {
              assert.ok(
                referent.includes(word.toLowerCase()),
                `semantic entity for "${expected.surfaceText}" must include "${word}"`,
              );
            }
            for (const word of expected.referentMustAvoid ?? []) {
              assert.ok(
                !referent.includes(word.toLowerCase()),
                `semantic entity for "${expected.surfaceText}" must AVOID "${word}"`,
              );
            }
          }
        });
      }

      const culturalReferences = fixture.expected.culturalReferences ?? [];
      if (culturalReferences.length > 0) {
        it("cultural-reference visualImplication has must-include keywords and avoids forbidden ones", () => {
          for (const expected of culturalReferences) {
            const vi = expected.visualImplicationIncludes.join(" ").toLowerCase();
            for (const word of expected.visualImplicationIncludes) {
              assert.ok(
                vi.includes(word.toLowerCase()),
                `cultural reference "${expected.sourcePhrase}" visualImplication must include "${word}"`,
              );
            }
            for (const word of expected.visualImplicationMustAvoid ?? []) {
              assert.ok(
                !vi.includes(word.toLowerCase()),
                `cultural reference "${expected.sourcePhrase}" visualImplication must AVOID "${word}"`,
              );
            }
          }
        });
      }
    });
  }

  it("fixture count matches the spec", () => {
    assert.equal(FIXTURES.length, 12, "spec lists 12 canonical fixtures");
  });
});

export type { RegressionFixture };
export { FIXTURES };
