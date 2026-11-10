/**
 * @purpose The one thing that removes image provenance records (plan docs/plans/PLAN_IMAGE_TRACING.md, Data Model): when `image_provenance.retention_days` is above 0, records older than that are deleted, with any generation request older than it that no remaining record names. At 0, the default, nothing is ever deleted (David, 2026-11-10: records are kept indefinitely).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigInt } from "../lib/adminConfig";
import { logger } from "../lib/logger";

export const PROVENANCE_RETENTION_KEY = "image_provenance.retention_days";

export interface ProvenancePurgeResult {
  retentionDays: number;
  deletedRecords: number;
  deletedRequests: number;
}

export async function runProvenanceRetentionPurge(): Promise<ProvenancePurgeResult> {
  const retentionDays = await getConfigInt(PROVENANCE_RETENTION_KEY, 0);
  if (!(retentionDays > 0)) return { retentionDays: 0, deletedRecords: 0, deletedRequests: 0 };
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const records = await db.execute(sql`DELETE FROM image_provenance WHERE created_at < ${cutoff} RETURNING id`);
  const requests = await db.execute(sql`
    DELETE FROM image_generation_requests r
    WHERE r.created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM image_provenance p WHERE p.generation_request_id = r.id)
    RETURNING r.id`);
  const result = { retentionDays, deletedRecords: records.rows.length, deletedRequests: requests.rows.length };
  if (result.deletedRecords || result.deletedRequests) logger.info(result, "image provenance retention purge");
  return result;
}
