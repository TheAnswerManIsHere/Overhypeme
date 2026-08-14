/**
 * The canonical answer to "is this account really an admin?"
 * ────────────────────────────────────────────────────────────────────────────
 * There are THREE grant mechanisms, and they have always been three:
 *
 *   1. the stored `users.is_admin` column,
 *   2. the `ADMIN_USER_IDS` env allowlist (`auth.ts`),
 *   3. the `BOOTSTRAP_ADMIN_EMAIL` hardcoded bootstrap.
 *
 * `authMiddleware` honours all three when it builds `req.user.isRealAdmin`.
 * Everywhere else in the codebase that asked the question asked it of the
 * stored column alone, which meant an env- or bootstrap-granted admin could
 * pass every gate in the request path and then be invisible to the queries that
 * decide who gets paged, who may change their own notification settings, and —
 * most dangerously — how many admins are left.
 *
 * This module is the single definition. `authMiddleware` computes the
 * per-request answer; this computes the SQL-side answer for the population
 * queries that cannot go through a request.
 *
 * NOTE: this is the PRIVILEGE rail, not the entitlement rail. Operational
 * privilege never honours the "view as user" toggle — view-as-user changes what
 * an admin can do, never who gets paged or who counts as an admin. Feature
 * entitlements are `featureAccess.ts`'s job and deliberately DO honour it.
 */

import { type Request } from "express";
import { usersTable } from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { BOOTSTRAP_ADMIN_EMAIL, isAdminByEmail } from "./auth";

/** The ids in ADMIN_USER_IDS, read at call time so tests can vary the env. */
function adminUserIds(): string[] {
  return (
    process.env["ADMIN_USER_IDS"]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * A SQL predicate matching every account that is really an admin, by any of the
 * three mechanisms. Mirrors `authMiddleware`'s `isRealAdmin` exactly — if these
 * two ever disagree, a guard protects a different population than the one that
 * can actually log in.
 */
export function isRealAdminSql(): SQL {
  const ids = adminUserIds();
  const clauses: SQL[] = [eq(usersTable.isAdmin, true)];

  if (ids.length > 0) {
    // `inArray`, not `= ANY(${ids})`: drizzle binds a JS array as a single
    // parameter, so the ANY form reaches Postgres as a scalar and the clause
    // silently matches nothing — which would make env-granted admins invisible
    // to the very count that decides whether the last admin may be removed.
    clauses.push(inArray(usersTable.id, ids));
  }

  // Case-insensitive, matching `isAdminByEmail`'s `toLowerCase()` comparison.
  clauses.push(
    and(
      isNotNull(usersTable.email),
      sql`lower(${usersTable.email}) = lower(${BOOTSTRAP_ADMIN_EMAIL})`,
    )!,
  );

  return or(...clauses)!;
}

/**
 * The predicate for admins who can actually reach the console right now.
 *
 * `authMiddleware` only resolves users with `is_active = true`, so an inactive
 * account is not a reachable admin no matter how it was granted. Any count used
 * to decide "is there still an admin left" must filter the same way, or it will
 * happily approve deactivating the last one.
 */
export function isReachableAdminSql(): SQL {
  return and(isRealAdminSql(), eq(usersTable.isActive, true))!;
}

/**
 * The row-level answer, for batch projections that have already fetched the
 * user rows and must not issue a query per subject. Same three mechanisms,
 * evaluated in JS rather than SQL.
 */
export function isRealAdminRow(row: {
  id: string;
  email: string | null;
  isAdmin: boolean | null;
}): boolean {
  return !!(row.isAdmin || adminUserIds().includes(row.id) || isAdminByEmail(row.email));
}

/**
 * The per-request answer. Prefer this over reading `req.user.isAdmin`, which is
 * toggle-aware and therefore wrong for operational privilege, and over
 * re-selecting `users.is_admin`, which sees only one of the three mechanisms.
 */
export function isRealAdminRequest(req: Request): boolean {
  return req.isAuthenticated() && !!req.user.isRealAdmin;
}
