/**
 * Tests for the fact-enrichment (visual taxonomy) layer.
 *
 * Unit-tests the shared validation/normalization (@workspace/api-zod) and the
 * service's parse → validate → corrective-retry orchestration (no live network,
 * model caller injected). One DB-backed test confirms two facts each store
 * their own enrichment columns.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  validateEnrichment,
  normalizeHashtag,
  factEnrichmentWireSchema,
  type FactEnrichment,
} from "@workspace/api-zod";
import {
  enrichFactWithModel,
  taxonomyColumns,
  EnrichmentError,
  type EnrichInput,
} from "../lib/factEnrichment.js";

const VALID: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["clear_causal_relationship", "single_subject_focus"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
  characters: [],
};

// Same fields, but subtype belongs to a DIFFERENT archetype.
const SUBTYPE_MISMATCH = { ...VALID, subtype: "social_role_reversal" };

const EARTH_ENTITY = {
  surfaceText: "Earth",
  normalizedText: "earth",
  entityKind: "celestial_body" as const,
  visualReferent: "the planet Earth",
  capitalizationSignal: "capitalized_named_entity" as const,
  materiallyAffectsVisualPrompt: true,
  requiresAdminReview: false,
  confidence: 0.95,
  notes: "",
};
// The personalized subject leaking through as a named entity (the bug).
const ALEX_SUBJECT_ENTITY = {
  surfaceText: "Alex",
  normalizedText: "alex",
  entityKind: "named_entity" as const,
  visualReferent: "a person",
  capitalizationSignal: "capitalized_named_entity" as const,
  materiallyAffectsVisualPrompt: true,
  requiresAdminReview: false,
  confidence: 0.9,
  notes: "",
};

const INPUT: EnrichInput = { factText: "{SUBJ} pushes the Earth down." };

describe("validateEnrichment — archetype/subtype pairing", () => {
  it("accepts a valid archetype/subtype pair", () => {
    const r = validateEnrichment(VALID);
    assert.equal(r.ok, true);
  });

  it("rejects a subtype that does not belong to the archetype", () => {
    const r = validateEnrichment(SUBTYPE_MISMATCH);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.subtypeMismatch, true);
  });

  it("rejects an unknown archetype", () => {
    const r = validateEnrichment({ ...VALID, primaryArchetype: "not_a_real_archetype" });
    assert.equal(r.ok, false);
  });
});

// Regression (David, 2026-11-24): hashtags are generated once, by the submit
// form's suggester where the submitter reviews them. Enrichment generated a
// second set, which carried the placeholder name into tags like "alexpower".
describe("validateEnrichment — enrichment generates no hashtags", () => {
  it("accepts a classification with no suggestedHashtags at all", () => {
    const r = validateEnrichment(VALID);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) assert.equal(r.data.suggestedHashtags, undefined);
  });

  it("still accepts a pre-v8 stored blob that carries suggestedHashtags", () => {
    const r = validateEnrichment({ ...VALID, suggestedHashtags: ["strength", "alexpower"] });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("the model's structured-output schema has no suggestedHashtags key", () => {
    assert.equal("suggestedHashtags" in factEnrichmentWireSchema.shape, false);
  });

  it("normalizeHashtag strips # and punctuation", () => {
    assert.equal(normalizeHashtag("#Legendary!"), "legendary");
    assert.equal(normalizeHashtag("Push Ups"), "pushups");
  });
});

describe("validateEnrichment — required fields & confidence", () => {
  it("rejects missing required fields", () => {
    const { overhypeFit, ...partial } = VALID;
    void overhypeFit;
    assert.equal(validateEnrichment(partial).ok, false);
  });

  it("rejects taxonomyConfidence outside 0..1", () => {
    assert.equal(validateEnrichment({ ...VALID, taxonomyConfidence: 1.5 }).ok, false);
    assert.equal(validateEnrichment({ ...VALID, taxonomyConfidence: -0.1 }).ok, false);
  });
});

describe("validateEnrichment — semantic entities (capitalization-aware referents)", () => {
  const MATERIAL_EARTH = {
    surfaceText: "Earth",
    normalizedText: "earth",
    entityKind: "celestial_body" as const,
    visualReferent: "the planet Earth",
    capitalizationSignal: "capitalized_named_entity" as const,
    materiallyAffectsVisualPrompt: true,
    requiresAdminReview: false,
    confidence: 0.95,
    notes: "Capitalized Earth + 'the Earth' phrase → the planet, not soil.",
  };
  const MATERIAL_LOWER_EARTH = {
    surfaceText: "earth",
    normalizedText: "earth",
    entityKind: "common_noun" as const,
    visualReferent: "ground, dirt, soil, or terrain beneath the subject",
    capitalizationSignal: "lowercase_common_noun" as const,
    materiallyAffectsVisualPrompt: true,
    requiresAdminReview: false,
    confidence: 0.9,
    notes: "Lowercase earth + dirt context → soil.",
  };

  it("accepts empty semanticEntities array", () => {
    const r = validateEnrichment({ ...VALID, semanticEntities: [] });
    assert.equal(r.ok, true);
  });

  it("accepts a valid semantic entity entry", () => {
    const r = validateEnrichment({ ...VALID, semanticEntities: [MATERIAL_EARTH] });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("accepts two distinct entries for the same surface text in different casings", () => {
    const r = validateEnrichment({
      ...VALID,
      semanticEntities: [
        { ...MATERIAL_EARTH, surfaceText: "Earth" },
        { ...MATERIAL_LOWER_EARTH, surfaceText: "earth" },
      ],
    });
    assert.equal(r.ok, true);
  });

  it("rejects confidence outside [0,1]", () => {
    const r = validateEnrichment({
      ...VALID,
      semanticEntities: [{ ...MATERIAL_EARTH, confidence: 1.5 }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects unknown entityKind", () => {
    const r = validateEnrichment({
      ...VALID,
      semanticEntities: [{ ...MATERIAL_EARTH, entityKind: "not_a_real_kind" }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects unknown capitalizationSignal", () => {
    const r = validateEnrichment({
      ...VALID,
      semanticEntities: [{ ...MATERIAL_EARTH, capitalizationSignal: "shouting" }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects empty surfaceText / visualReferent", () => {
    const r1 = validateEnrichment({
      ...VALID,
      semanticEntities: [{ ...MATERIAL_EARTH, surfaceText: "" }],
    });
    assert.equal(r1.ok, false);
    const r2 = validateEnrichment({
      ...VALID,
      semanticEntities: [{ ...MATERIAL_EARTH, visualReferent: "   " }],
    });
    assert.equal(r2.ok, false);
  });

  it("accepts the sentence-initial ambiguous case with requiresAdminReview=true", () => {
    const r = validateEnrichment({
      ...VALID,
      semanticEntities: [
        {
          ...MATERIAL_EARTH,
          capitalizationSignal: "sentence_initial_ambiguous",
          requiresAdminReview: true,
          confidence: 0.7,
          notes: "Sentence-initial; pushup idiom suggests planet.",
        },
      ],
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("accepts a brand entity with requiresAdminReview=true", () => {
    const r = validateEnrichment({
      ...VALID,
      semanticEntities: [
        {
          surfaceText: "Apple",
          normalizedText: "apple",
          entityKind: "brand_or_cultural_reference",
          visualReferent: "the Apple technology brand or company",
          capitalizationSignal: "capitalized_named_entity",
          materiallyAffectsVisualPrompt: true,
          requiresAdminReview: true,
          confidence: 0.9,
          notes: "Capitalized Apple changing its logo → the brand.",
        },
      ],
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("normalizes missing semanticEntities to []", () => {
    const { semanticEntities: _drop, ...withoutField } = { ...VALID };
    const r = validateEnrichment(withoutField);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.data.semanticEntities, []);
  });
});

describe("taxonomyColumns", () => {
  it("writes the blob and its AI baseline, and no projection columns (2.1b)", () => {
    const cols = taxonomyColumns(VALID);
    assert.deepEqual(Object.keys(cols).sort(), ["enrichment", "enrichmentAiDerived"]);
    assert.deepEqual(cols.enrichment, VALID);
    assert.deepEqual(cols.enrichmentAiDerived, VALID);
  });
});

describe("enrichFactWithModel — orchestration", () => {
  it("returns the result without retry when the first response is valid", async () => {
    let calls = 0;
    const result = await enrichFactWithModel(INPUT, async () => {
      calls++;
      return JSON.stringify(VALID);
    });
    assert.equal(calls, 1);
    assert.equal(result.primaryArchetype, "superhuman_physical_feat");
    assert.equal(result.enrichedBy, "openai");
    assert.equal(result.taxonomyVersion, "v1");
  });

  it("retries once with a corrective message and succeeds", async () => {
    let calls = 0;
    const result = await enrichFactWithModel(INPUT, async () => {
      calls++;
      return JSON.stringify(calls === 1 ? SUBTYPE_MISMATCH : VALID);
    });
    assert.equal(calls, 2);
    assert.equal(result.subtype, "force_scaled_action");
  });

  it("throws EnrichmentError when still invalid after the retry", async () => {
    let calls = 0;
    await assert.rejects(
      () => enrichFactWithModel(INPUT, async () => { calls++; return JSON.stringify(SUBTYPE_MISMATCH); }),
      (err: unknown) => err instanceof EnrichmentError,
    );
    assert.equal(calls, 2);
  });

  it("treats unparseable JSON as a validation failure (retries then throws)", async () => {
    let calls = 0;
    await assert.rejects(
      () => enrichFactWithModel(INPUT, async () => { calls++; return "not json"; }),
      (err: unknown) => err instanceof EnrichmentError,
    );
    assert.equal(calls, 2);
  });

  it("strips the personalized subject from semanticEntities while keeping real referents", async () => {
    const polluted = { ...VALID, semanticEntities: [EARTH_ENTITY, ALEX_SUBJECT_ENTITY] };
    const result = await enrichFactWithModel(INPUT, async () => JSON.stringify(polluted));
    const surfaces = result.semanticEntities.map((e) => e.surfaceText);
    assert.deepEqual(surfaces, ["Earth"], JSON.stringify(result.semanticEntities));
  });
});

describe("facts table — each fact stores its own enrichment", () => {
  const insertedIds: number[] = [];

  after(async () => {
    if (insertedIds.length) await db.delete(factsTable).where(inArray(factsTable.id, insertedIds));
  });

  it("persists distinct enrichment on two facts", async () => {
    const firstEnrichment: FactEnrichment = { ...VALID };
    const secondEnrichment: FactEnrichment = {
      ...VALID,
      primaryArchetype: "object_logic_impossibility",
      subtype: "mechanical_contradiction",
      overhypeFit: "questionable",
      adultSuitability: "requires_review",
      suggestedHashtags: ["impossible", "doors", "legendary"],
    };

    const [first] = await db.insert(factsTable).values({
      text: "t_enrich first fact",
      enrichment: firstEnrichment,
    }).returning();
    insertedIds.push(first.id);

    const [second] = await db.insert(factsTable).values({
      text: "t_enrich second fact",
      enrichment: secondEnrichment,
    }).returning();
    insertedIds.push(second.id);

    const [aRow] = await db.select().from(factsTable).where(eq(factsTable.id, first.id));
    const [bRow] = await db.select().from(factsTable).where(eq(factsTable.id, second.id));

    assert.equal((aRow.enrichment as FactEnrichment).primaryArchetype, "superhuman_physical_feat");
    assert.equal((bRow.enrichment as FactEnrichment).primaryArchetype, "object_logic_impossibility");
    assert.notDeepEqual(aRow.enrichment, bRow.enrichment);
    assert.equal((bRow.enrichment as FactEnrichment).adultSuitability, "requires_review");
  });
});
