/**
 * @purpose The one thing that removes image provenance records (plan docs/plans/PLAN_IMAGE_TRACING.md, Data Model): when `image_provenance.retention_days` is above 0, records older than that are deleted, with any generation request older than it that no remaining record names. At 0, the default, nothing is ever deleted (David, 2026-11-10: records are kept indefinitely).
 */
import { db, imageGenerationRequestsTable, imageProvenanceTable } from "@workspace/db";
import { and, eq, lt, notExists } from "drizzle-orm";
import { getConfigInt } from "../lib/adminConfig";
import { logger } from "../lib/logger";

export const PROVENANCE_RETENTION_KEY = "image_provenance.retention_days";

interface ProvenancePurgeResult {
  retentionDays: number;
  deletedRecords: number;
  deletedRequests: number;
}

export async function runProvenanceRetentionPurge(): Promise<ProvenancePurgeResult> {
  const retentionDays = await getConfigInt(PROVENANCE_RETENTION_KEY, 0);
  if (!(retentionDays > 0)) return { retentionDays: 0, deletedRecords: 0, deletedRequests: 0 };
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const records = await db.delete(imageProvenanceTable)
    .where(lt(imageProvenanceTable.createdAt, cutoff))
    .returning({ id: imageProvenanceTable.id });
  const requests = await db.delete(imageGenerationRequestsTable)
    .where(and(
      lt(imageGenerationRequestsTable.createdAt, cutoff),
      notExists(db.select({ one: imageProvenanceTable.id }).from(imageProvenanceTable)
        .where(eq(imageProvenanceTable.generationRequestId, imageGenerationRequestsTable.id))),
    ))
    .returning({ id: imageGenerationRequestsTable.id });
  const result = { retentionDays, deletedRecords: records.length, deletedRequests: requests.length };
  if (result.deletedRecords || result.deletedRequests) logger.info(result, "image provenance retention purge");
  return result;
}
