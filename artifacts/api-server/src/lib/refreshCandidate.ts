/**
 * @purpose Find the open refresh candidate of a fact, if any. Its own module so the gag store and the refresh promotion can both read it without importing each other.
 * @subsystem taxonomy-enrichment
 */
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factEnrichmentVersionsTable } from "@workspace/db/schema";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The fact's in-flight refresh candidate (status `candidate`), with the review it belongs to. */
export async function findInFlightRefreshCandidate(
  factId: number,
  tx: DbTx | typeof db = db,
): Promise<{ candidateVersionId: number; reviewId: number | null } | null> {
  const [row] = await tx
    .select({
      id: factEnrichmentVersionsTable.id,
      sourceReviewId: factEnrichmentVersionsTable.sourceReviewId,
    })
    .from(factEnrichmentVersionsTable)
    .where(and(
      eq(factEnrichmentVersionsTable.factId, factId),
      eq(factEnrichmentVersionsTable.status, "candidate"),
    ))
    .limit(1);
  return row ? { candidateVersionId: row.id, reviewId: row.sourceReviewId } : null;
}
