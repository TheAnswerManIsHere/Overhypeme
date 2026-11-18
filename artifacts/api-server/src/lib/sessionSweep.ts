/**
 * @purpose Deletes sign-in sessions past their expiry in bounded batches, so a session nobody presents again does not stay until its account is deleted (launch Phase 14, increment 6); run hourly while the process is up and daily by the maintenance call.
 * @subsystem accounts-auth
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface SessionSweepResult {
  deleted: number;
  batches: number;
  budgetExhausted: boolean;
}

/**
 * Until this sweep, an expired session was deleted only when its own cookie
 * came back (`getSession`), at sign-out, or with its account; a guest's
 * session, with no account, stayed for ever. Batches take their rows with
 * SKIP LOCKED so a concurrent sign-in touching a row is never blocked.
 */
export async function sweepExpiredSessions(
  opts: { now?: Date; batchSize?: number; maxBatches?: number } = {},
): Promise<SessionSweepResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 5000;
  const maxBatches = opts.maxBatches ?? 200;
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const result = await db.execute(sql`
      WITH victims AS (
        SELECT sid FROM sessions WHERE expire < ${now} LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      ), removed AS (
        DELETE FROM sessions WHERE sid IN (SELECT sid FROM victims) RETURNING 1
      )
      SELECT COUNT(*)::int AS deleted FROM removed
    `);
    const n = Number((result.rows[0] as { deleted?: number } | undefined)?.deleted ?? 0);
    batches += 1;
    deleted += n;
    if (n < batchSize) return { deleted, batches, budgetExhausted: false };
  }
  return { deleted, batches, budgetExhausted: true };
}
