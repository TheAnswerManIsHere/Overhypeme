/**
 * Phase-4 retention job: deletes `transient_renders` rows older than the
 * configured TTL (`transient_renders.retention_days`, default 30 days).
 *
 * The audit table grows fast under load — every preview/download call writes
 * one row. Rows past the retention window are no longer useful for either
 * abuse detection (those queries look at the last 24 h) or per-user
 * analytics (those export to a separate warehouse), so they can be safely
 * dropped to keep the table cheap to scan.
 *
 * Scheduled hourly from `src/index.ts` via the same self-rescheduling
 * `setTimeout` pattern used by `scheduleDailyFactJob`.
 */

import { db } from "@workspace/db";
import { transientRendersTable } from "@workspace/db/schema";
import { lt, sql } from "drizzle-orm";
import { getConfigInt } from "../lib/adminConfig";
import { logger } from "../lib/logger";

export const DEFAULT_RETENTION_DAYS = 30;

export interface PurgerResult {
  deleted: number;
  retentionDays: number;
  cutoff: string;
}

export async function runTransientRenderPurger(): Promise<PurgerResult> {
  const retentionDays = await getConfigInt("transient_renders.retention_days", DEFAULT_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await db
    .delete(transientRendersTable)
    .where(lt(transientRendersTable.createdAt, cutoff))
    .returning({ id: transientRendersTable.id });

  const deleted = result.length;
  if (deleted > 0) {
    logger.info({ deleted, retentionDays, cutoff: cutoff.toISOString() }, "transient_renders purged");
  }
  return { deleted, retentionDays, cutoff: cutoff.toISOString() };
}

/**
 * Test seam: count of rows currently in the table. Used by the integration
 * test to assert pre/post-purge state.
 */
export async function countTransientRenders(): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM ${transientRendersTable}`);
  return Number(result.rows[0]?.count ?? "0");
}
