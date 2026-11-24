/**
 * @purpose Account suspension (launch Phase 5, plan *Suspension*, S19; intent item 8): an admin suspends an account under the admin population lock — never the last administrator who can reach the console — recording when, why and by whom, and every session of the person ends in the same transaction; unsuspending clears the record. Suspension blocks the person, never the catalogue: nothing here touches their content or billing, and `is_active` is never written.
 * @subsystem accounts-auth
 */
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { acquireAdminPopulationLock, assertAdminPopulationSurvives } from "./adminLockoutGuard";
import { isReachableAdminSql } from "./adminIdentity";
import { revokeUserSessions } from "./auth";

/** The longest reason an admin can record (the column's width). */
export const SUSPENSION_REASON_MAX = 500;

export type SuspendOutcome = "suspended" | "already_suspended" | "not_found";

/**
 * Who to tell about a real transition (Issue #1110): the address the account
 * had at the moment of the change, read under the same lock or in the same
 * statement. Null on any outcome that changed nothing, so a repeated request
 * can never produce a second notice.
 */
export type SuspensionRecipient = { email: string | null; firstName: string | null };
export type SuspensionResult<O extends string> = { outcome: O; recipient: SuspensionRecipient | null };

/**
 * Suspends `userId`. Throws `AdminLockoutError` when they are the last
 * administrator who can reach the console. A second suspension of a
 * suspended account changes nothing (its first reason stands).
 */
export async function suspendAccount(userId: string, opts: { by: string | null; reason: string }): Promise<SuspensionResult<SuspendOutcome>> {
  return db.transaction(async (tx): Promise<SuspensionResult<SuspendOutcome>> => {
    await acquireAdminPopulationLock(tx);
    const [user] = await tx
      .select({
        suspendedAt: usersTable.suspendedAt,
        email: usersTable.email,
        firstName: usersTable.firstName,
        reachableAdmin: sql<boolean>`${isReachableAdminSql()}`,
      })
      .from(usersTable).where(eq(usersTable.id, userId)).for("update");
    if (!user) return { outcome: "not_found", recipient: null };
    if (user.suspendedAt) return { outcome: "already_suspended", recipient: null };
    // Only an account that can reach the console can be the last one that can.
    if (user.reachableAdmin) await assertAdminPopulationSurvives(tx, userId);
    await tx.update(usersTable)
      .set({ suspendedAt: new Date(), suspendedReason: opts.reason, suspendedBy: opts.by })
      .where(eq(usersTable.id, userId));
    await revokeUserSessions(tx, userId);
    return { outcome: "suspended", recipient: { email: user.email, firstName: user.firstName } };
  });
}

export type UnsuspendOutcome = "unsuspended" | "not_suspended" | "not_found";

/** Lifts a suspension. The person signs in again; nothing else was changed, so nothing else is restored. */
export async function unsuspendAccount(userId: string): Promise<SuspensionResult<UnsuspendOutcome>> {
  const [lifted] = await db.update(usersTable)
    .set({ suspendedAt: null, suspendedReason: null, suspendedBy: null })
    .where(and(eq(usersTable.id, userId), isNotNull(usersTable.suspendedAt)))
    .returning({ id: usersTable.id, email: usersTable.email, firstName: usersTable.firstName });
  if (lifted) return { outcome: "unsuspended", recipient: { email: lifted.email, firstName: lifted.firstName } };
  const [exists] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId));
  return { outcome: exists ? "not_suspended" : "not_found", recipient: null };
}
