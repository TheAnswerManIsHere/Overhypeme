/**
 * "There must always be an admin who can log in."
 * ────────────────────────────────────────────────────────────────────────────
 * Stated over the INVARIANT, not over a list of endpoints: no sequence of
 * PATCH/DELETE operations, including concurrent ones, may reduce the number of
 * accounts that can actually reach the admin console to zero.
 *
 * Three things this has to get right, each of which a simpler guard gets wrong:
 *
 * 1. WHAT COUNTS AS AN ADMIN. Over all three grant mechanisms and restricted to
 *    `is_active = true` — see `adminIdentity.ts`. Counting `is_admin = true`
 *    alone, which is what `/admin/administrators` did, undercounts env- and
 *    bootstrap-granted admins and would let the guard pass while zeroing the
 *    real population.
 *
 * 2. WHAT COUNTS AS REMOVING ONE. Demotion, deactivation, and deletion are the
 *    obvious three. An EMAIL CHANGE is the fourth and the easy one to miss:
 *    `authMiddleware` derives real-admin status partly from the email, so
 *    changing the last bootstrap-email-only admin's address removes their admin
 *    status without touching `is_admin` or `is_active`.
 *
 * 3. SERIALIZATION. A transaction alone does not deliver this. At READ
 *    COMMITTED, two transactions demoting DIFFERENT admin rows both read a
 *    count of two, both conclude they are safe, and both commit — the rows they
 *    write don't overlap, so nothing serializes them. Hence a
 *    transaction-scoped advisory lock taken on the same connection as the count
 *    and the write. It must be transaction-scoped: a session-level lock could
 *    outlive its transaction under this app's connection pooling.
 *
 * @purpose Last-admin guard: under a transaction-scoped advisory lock it refuses a demotion, suspension, deletion or bootstrap-boundary email change that would leave no active reachable admin, and exports a self-demotion check; used by the admin user routes, suspension, the deletion engine and email-change verification.
 * @subsystem accounts-auth
 */

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { ADVISORY_LOCK_KEYS } from "./advisoryLockKeys";
import { isAdminByEmail } from "./auth";
import { isReachableAdminSql } from "./adminIdentity";

const ADMIN_POPULATION_LOCK_KEY = ADVISORY_LOCK_KEYS.adminPopulation;

export class AdminLockoutError extends Error {
  public readonly code = "last_admin";
  constructor(message = "This would remove the last account that can reach the admin console.") {
    super(message);
    this.name = "AdminLockoutError";
  }
}

export class SelfDemotionError extends Error {
  public readonly code = "self_demotion";
  constructor(message = "You cannot remove your own admin access.") {
    super(message);
    this.name = "SelfDemotionError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Does this email change cross the bootstrap boundary in either direction?
 *
 * Running the guard in the *granting* direction as well is deliberate and
 * cheap: it costs one count, and it means the rule is "any crossing" rather
 * than a direction the next reader has to reason about.
 */
export function crossesBootstrapBoundary(
  currentEmail: string | null | undefined,
  nextEmail: string | null | undefined,
): boolean {
  return isAdminByEmail(currentEmail) !== isAdminByEmail(nextEmail);
}

/**
 * Takes the transaction-scoped population lock. Re-entrant within one
 * transaction, so a caller that reads target state under this lock and then
 * calls `assertAdminPopulationSurvives` (which re-acquires it) pays no second
 * wait.
 *
 * Exported so a caller that must DECIDE whether this update removes admin
 * access — not just count survivors afterward — can take the lock BEFORE
 * reading the target row. Round 4 of PR #425's review found a caller that read
 * the target's email/isAdmin before opening its transaction at all: a
 * concurrent admin-mutating transaction could change that row between the
 * read and the lock, making the removal decision itself stale, independent of
 * the count this module already protects.
 */
export async function acquireAdminPopulationLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_POPULATION_LOCK_KEY})`);
}

/**
 * Takes the population lock and counts the admins who would remain if the
 * target were removed. Throws when that count is zero.
 *
 * MUST be called inside the same transaction as the mutation it guards, or the
 * lock protects nothing.
 */
export async function assertAdminPopulationSurvives(tx: Tx, targetUserId: string): Promise<void> {
  await acquireAdminPopulationLock(tx);

  const { rows } = await tx.execute<{ remaining: string | number }>(sql`
    SELECT count(*) AS remaining FROM ${usersTable}
    WHERE ${and(isReachableAdminSql(), ne(usersTable.id, targetUserId))}
  `);

  if (Number(rows[0]?.remaining ?? 0) < 1) {
    throw new AdminLockoutError();
  }
}

/** Refuses an admin removing their own access, before anything else runs. */
export function assertNotSelfDemotion(actorId: string | undefined, targetUserId: string): void {
  if (actorId && actorId === targetUserId) {
    throw new SelfDemotionError();
  }
}

/**
 * Runs `mutate` under the population guard, in one transaction.
 *
 * Used by `PATCH /admin/users/:id`, where the update IS the removal, so no
 * separate reservation is needed — the lock, the count, and the write are the
 * same transaction.
 */
export async function withAdminPopulationGuard<T>(
  targetUserId: string,
  mutate: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await assertAdminPopulationSurvives(tx, targetUserId);
    return mutate(tx);
  });
}

/** Maps a guard failure onto its HTTP shape. Returns false if `err` isn't one. */
export function respondToGuardError(
  err: unknown,
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
): boolean {
  if (err instanceof AdminLockoutError) {
    res.status(409).json({ error: err.code, message: err.message });
    return true;
  }
  if (err instanceof SelfDemotionError) {
    res.status(409).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}
