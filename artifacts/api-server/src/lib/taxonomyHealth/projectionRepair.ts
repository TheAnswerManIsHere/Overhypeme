/**
 * Projection-column repair helper.
 *
 * Reads `facts.enrichment` for the given fact, validates it, derives the
 * expected promoted columns via `buildFactEnrichmentColumns`, and updates
 * `primary_archetype` / `subtype` / `overhype_fit` / `adult_suitability`
 * to match. Never touches the JSONB blob.
 *
 * Safe to run in bulk because the source of truth is the existing enrichment
 * — we're only fixing the projection layer.
 */

import { eq } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import { validateEnrichment } from "@workspace/api-zod";
import { buildFactEnrichmentColumns } from "../factEnrichment";
import { logger } from "../logger";

export interface ProjectionRepairOutcome {
  factId: number;
  repaired: boolean;
  before: {
    primaryArchetype: string | null;
    subtype: string | null;
    overhypeFit: string | null;
    adultSuitability: string | null;
  };
  after: {
    primaryArchetype: string | null;
    subtype: string | null;
    overhypeFit: string | null;
    adultSuitability: string | null;
  };
  error?: string;
}

export async function repairFactEnrichmentProjection(
  factId: number,
): Promise<ProjectionRepairOutcome> {
  const [row] = await db
    .select({
      id: factsTable.id,
      enrichment: factsTable.enrichment,
      primaryArchetype: factsTable.primaryArchetype,
      subtype: factsTable.subtype,
      overhypeFit: factsTable.overhypeFit,
      adultSuitability: factsTable.adultSuitability,
    })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);

  if (!row) {
    return {
      factId,
      repaired: false,
      before: emptyColumns(),
      after: emptyColumns(),
      error: "fact_not_found",
    };
  }

  const before = {
    primaryArchetype: row.primaryArchetype,
    subtype: row.subtype,
    overhypeFit: row.overhypeFit,
    adultSuitability: row.adultSuitability,
  };

  if (row.enrichment == null) {
    return {
      factId,
      repaired: false,
      before,
      after: before,
      error: "missing_enrichment",
    };
  }

  const validation = validateEnrichment(row.enrichment);
  if (!validation.ok) {
    return {
      factId,
      repaired: false,
      before,
      after: before,
      error: `invalid_enrichment: ${validation.error}`,
    };
  }

  const projected = buildFactEnrichmentColumns(validation.data);
  const after = {
    primaryArchetype: projected.primaryArchetype,
    subtype: projected.subtype,
    overhypeFit: projected.overhypeFit,
    adultSuitability: projected.adultSuitability,
  };

  if (
    before.primaryArchetype === after.primaryArchetype &&
    before.subtype === after.subtype &&
    before.overhypeFit === after.overhypeFit &&
    before.adultSuitability === after.adultSuitability
  ) {
    return { factId, repaired: false, before, after };
  }

  try {
    await db
      .update(factsTable)
      .set({
        primaryArchetype: after.primaryArchetype,
        subtype: after.subtype,
        overhypeFit: after.overhypeFit,
        adultSuitability: after.adultSuitability,
      })
      .where(eq(factsTable.id, factId));
    return { factId, repaired: true, before, after };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, factId }, "[projectionRepair] update failed");
    return { factId, repaired: false, before, after, error: msg };
  }
}

function emptyColumns(): {
  primaryArchetype: string | null;
  subtype: string | null;
  overhypeFit: string | null;
  adultSuitability: string | null;
} {
  return {
    primaryArchetype: null,
    subtype: null,
    overhypeFit: null,
    adultSuitability: null,
  };
}
