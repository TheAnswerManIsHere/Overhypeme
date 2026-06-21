/**
 * Audit-history writer for manual taxonomy-enrichment overrides.
 *
 * Rows are written from the override endpoints (set / update / reset /
 * auto_linked) and from re-enrichment (baseline_reenriched, only on a
 * not-changed → changed transition). Accepts an optional transaction executor so
 * a PUT/DELETE can record history atomically with the override write.
 */

import { db } from "@workspace/db";
import {
  enrichmentOverrideHistoryTable,
  type InsertEnrichmentOverrideHistory,
} from "@workspace/db/schema";

// The transaction type, inferred from the db.transaction callback parameter.
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OverrideHistoryAction =
  | "set"
  | "update"
  | "reset"
  | "auto_linked"
  | "baseline_reenriched";

export async function recordOverrideHistory(
  rows: InsertEnrichmentOverrideHistory[],
  executor: DbExecutor = db,
): Promise<void> {
  if (rows.length === 0) return;
  await executor.insert(enrichmentOverrideHistoryTable).values(rows);
}
