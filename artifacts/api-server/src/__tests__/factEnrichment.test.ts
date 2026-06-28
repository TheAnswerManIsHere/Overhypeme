/**
 * Tests for the fact-enrichment (visual taxonomy) layer.
 *
 * Unit-tests the shared validation/normalization (@workspace/api-zod) and the
 * service's parse → validate → corrective-retry orchestration (no live network,
 * model caller injected). One DB-backed test confirms a fact and its variant
 * each store their own independent enrichment.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  validateEnrichment,
  normalizeHashtag,
  type FactEnrichment,
} from "@workspace/api-zod";
import {
  enrichFactWithModel,
  buildFactEnrichmentColumns,
  stripDeniedHashtags,
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
  suggestedHashtags: ["strength", "pushups", "earth", "legendary"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
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

const INPUT: EnrichInput = { factText: "{SUBJ} pushes the Earth down.", status: "new_fact" };

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

describe("validateEnrichment — hashtags", () => {
  it("normalizes hashtags to lowercase alphanumeric", () => {
    const r = validateEnrichment({ ...VALID, suggestedHashtags: ["#Strength", "Push Ups!", "EARTH"] });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.data.suggestedHashtags, ["strength", "pushups", "earth"]);
  });

  it("rejects fewer than 3 hashtags (after normalization)", () => {
    const r = validateEnrichment({ ...VALID, suggestedHashtags: ["one", "two"] });
    assert.equal(r.ok, false);
  });

  it("rejects more than 8 hashtags", () => {
    const r = validateEnrichment({ ...VALID, suggestedHashtags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] });
    assert.equal(r.ok, false);
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

describe("buildFactEnrichmentColumns", () => {
  it("derives promoted columns from the blob", () => {
    const cols = buildFactEnrichmentColumns(VALID);
    assert.equal(cols.primaryArchetype, "superhuman_physical_feat");
    assert.equal(cols.subtype, "force_scaled_action");
    assert.equal(cols.overhypeFit, "strong");
    assert.equal(cols.adultSuitability, "safe");
    assert.deepEqual(cols.enrichment, VALID);
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

  it("strips subject-name / app-name hashtags without a retry when enough real tags remain", async () => {
    let calls = 0;
    // Model returns the subject name + the app name (various forms) plus real tags.
    const withDenied = {
      ...VALID,
      suggestedHashtags: ["Alex", "#Overhype.me", "overhype", "strength", "legendary", "earth"],
    };
    const result = await enrichFactWithModel(INPUT, async () => { calls++; return JSON.stringify(withDenied); });
    assert.equal(calls, 1, "no retry needed — 3+ real tags survived");
    assert.deepEqual(result.suggestedHashtags, ["strength", "legendary", "earth"]);
  });

  it("re-runs the model when stripping denied hashtags drops below the minimum of 3", async () => {
    let calls = 0;
    const result = await enrichFactWithModel(INPUT, async () => {
      calls++;
      // First call: only one real tag survives the strip → forces a retry.
      if (calls === 1) return JSON.stringify({ ...VALID, suggestedHashtags: ["electriccar", "alex", "overhype"] });
      // Retry: the model now supplies enough allowed discovery tags.
      return JSON.stringify({ ...VALID, suggestedHashtags: ["electriccar", "innovation", "engineering"] });
    });
    assert.equal(calls, 2, "stripping below 3 triggered exactly one corrective retry");
    assert.deepEqual(result.suggestedHashtags, ["electriccar", "innovation", "engineering"]);
  });
});

describe("stripDeniedHashtags", () => {
  it("removes the subject name and the app name in any casing/punctuation, keeps real tags", () => {
    assert.deepEqual(
      stripDeniedHashtags(["Alex", "alex", "Overhype", "overhype.me", "OverhypeMe", "strength", "earth"]),
      ["strength", "earth"],
    );
  });
  it("is a no-op when nothing is denied", () => {
    assert.deepEqual(stripDeniedHashtags(["strength", "legendary", "earth"]), ["strength", "legendary", "earth"]);
  });
});

describe("facts table — fact + variant store independent enrichment", () => {
  const insertedIds: number[] = [];

  after(async () => {
    if (insertedIds.length) await db.delete(factsTable).where(inArray(factsTable.id, insertedIds));
  });

  it("persists distinct enrichment on a parent fact and its variant", async () => {
    const parentEnrichment: FactEnrichment = { ...VALID };
    const variantEnrichment: FactEnrichment = {
      ...VALID,
      primaryArchetype: "object_logic_impossibility",
      subtype: "mechanical_contradiction",
      overhypeFit: "questionable",
      adultSuitability: "requires_review",
      suggestedHashtags: ["impossible", "doors", "legendary"],
    };

    const [parent] = await db.insert(factsTable).values({
      text: "t_enrich parent fact",
      ...buildFactEnrichmentColumns(parentEnrichment),
    }).returning();
    insertedIds.push(parent.id);

    const [variant] = await db.insert(factsTable).values({
      text: "t_enrich variant fact",
      parentId: parent.id,
      ...buildFactEnrichmentColumns(variantEnrichment),
    }).returning();
    insertedIds.push(variant.id);

    const [pRow] = await db.select().from(factsTable).where(eq(factsTable.id, parent.id));
    const [vRow] = await db.select().from(factsTable).where(eq(factsTable.id, variant.id));

    assert.equal(pRow.primaryArchetype, "superhuman_physical_feat");
    assert.equal(vRow.primaryArchetype, "object_logic_impossibility");
    assert.equal(vRow.parentId, parent.id);
    assert.notDeepEqual(pRow.enrichment, vRow.enrichment);
    assert.equal((vRow.enrichment as FactEnrichment).adultSuitability, "requires_review");
  });
});
