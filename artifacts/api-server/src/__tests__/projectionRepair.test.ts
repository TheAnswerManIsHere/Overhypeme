/**
 * Projection-repair helper test.
 *
 * Inserts a fact row with deliberately mismatched promoted columns, calls
 * the helper, and verifies the columns are realigned to match the JSONB
 * enrichment. Cleans up after.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db, factsTable, usersTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";

import { repairFactEnrichmentProjection } from "../lib/taxonomyHealth/projectionRepair";

const USER_PREFIX = "tproj-";
const FACT_TEXT_PREFIX = "TPROJ_REPAIR_TEST_";

async function createUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@example.test`,
    profileImageUrl: null,
    isAdmin: false,
  });
  return id;
}

function VALID_ENRICHMENT() {
  return {
    primaryArchetype: "object_logic_impossibility" as const,
    subtype: "medium_contradiction" as const,
    modifiers: [],
    visualLiteralness: "literal_dramatization" as const,
    visualComplexity: "medium" as const,
    overhypeFit: "strong" as const,
    adultSuitability: "safe" as const,
    adultSuitabilityNotes: "",
    suggestedHashtags: ["pencils", "ant", "magnifying"],
    taxonomyConfidence: 0.95,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
  };
}

describe("repairFactEnrichmentProjection", () => {
  let userId: string;
  let factId: number;
  const insertedFactIds: number[] = [];

  before(async () => {
    userId = await createUser();
  });

  after(async () => {
    if (insertedFactIds.length > 0) {
      for (const id of insertedFactIds) {
        await db.delete(factsTable).where(eq(factsTable.id, id));
      }
    }
    await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  });

  it("repairs mismatched promoted columns from the JSONB blob", async () => {
    const enrichment = VALID_ENRICHMENT();
    const [inserted] = await db
      .insert(factsTable)
      .values({
        text: `${FACT_TEXT_PREFIX}${randomUUID()}`,
        submittedById: userId,
        enrichment,
        // Intentional mismatch with the blob — derive should reset these.
        primaryArchetype: "superhuman_physical_feat",
        subtype: "force_scaled_action",
        overhypeFit: "questionable",
        adultSuitability: "requires_review",
      })
      .returning({ id: factsTable.id });
    factId = inserted!.id;
    insertedFactIds.push(factId);

    const outcome = await repairFactEnrichmentProjection(factId);
    assert.equal(outcome.repaired, true);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.before.primaryArchetype, "superhuman_physical_feat");
    assert.equal(outcome.after.primaryArchetype, "object_logic_impossibility");
    assert.equal(outcome.after.subtype, "medium_contradiction");
    assert.equal(outcome.after.overhypeFit, "strong");
    assert.equal(outcome.after.adultSuitability, "safe");

    // Confirm DB state matches the repair.
    const [row] = await db
      .select({
        archetype: factsTable.primaryArchetype,
        subtype: factsTable.subtype,
        fit: factsTable.overhypeFit,
        adult: factsTable.adultSuitability,
      })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .limit(1);
    assert.equal(row?.archetype, "object_logic_impossibility");
    assert.equal(row?.subtype, "medium_contradiction");
    assert.equal(row?.fit, "strong");
    assert.equal(row?.adult, "safe");
  });

  it("returns repaired=false when columns already match", async () => {
    const outcome = await repairFactEnrichmentProjection(factId);
    assert.equal(outcome.repaired, false);
    assert.equal(outcome.error, undefined);
  });

  it("returns missing_enrichment for a fact with no blob", async () => {
    const [inserted] = await db
      .insert(factsTable)
      .values({
        text: `${FACT_TEXT_PREFIX}${randomUUID()}`,
        submittedById: userId,
        enrichment: null,
      })
      .returning({ id: factsTable.id });
    const id = inserted!.id;
    insertedFactIds.push(id);

    const outcome = await repairFactEnrichmentProjection(id);
    assert.equal(outcome.repaired, false);
    assert.equal(outcome.error, "missing_enrichment");
  });

  it("returns invalid_enrichment when the blob fails validation", async () => {
    const broken = { ...VALID_ENRICHMENT(), subtype: "not_a_real_subtype" };
    const [inserted] = await db
      .insert(factsTable)
      .values({
        text: `${FACT_TEXT_PREFIX}${randomUUID()}`,
        submittedById: userId,
        enrichment: broken,
      })
      .returning({ id: factsTable.id });
    const id = inserted!.id;
    insertedFactIds.push(id);

    const outcome = await repairFactEnrichmentProjection(id);
    assert.equal(outcome.repaired, false);
    assert.match(outcome.error ?? "", /invalid_enrichment/);
  });

  it("returns fact_not_found for an unknown id", async () => {
    const outcome = await repairFactEnrichmentProjection(2_147_483_000);
    assert.equal(outcome.repaired, false);
    assert.equal(outcome.error, "fact_not_found");
  });
});
