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
};

// Same fields, but subtype belongs to a DIFFERENT archetype.
const SUBTYPE_MISMATCH = { ...VALID, subtype: "social_role_reversal" };

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
