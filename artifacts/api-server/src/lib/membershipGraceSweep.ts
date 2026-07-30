/**
 * The grace convergence sweep — the cheap half of what used to live alongside
 * reconciliation.
 *
 * A `past_due` subscription keeps qualifying until its grace deadline, and the
 * read path enforces that deadline correctly on every read via
 * `effectiveTierExpr`. But the STORED `users.membership_tier` only changes when
 * something writes it, so a user whose deadline passes with no further event
 * sits with a stale stored value: authorization is right, the column is wrong.
 * This walks those users and recomputes them.
 *
 * **Convergence, not enforcement**, and the distinction is the whole design. If
 * this sweep dies, nobody keeps access past their deadline — the read path
 * already demoted them. What degrades is the accuracy of a projection, which is
 * why it is safe to run this cheaply and to let it fail loudly rather than
 * building a guarantee on top of a background job being healthy.
 *
 * It makes no Stripe calls, takes no leases, and mutates one user at a time, so
 * it carries none of the machinery reconciliation needed. That is exactly why it
 * stayed when reconciliation was deferred (PR #287): it repairs a projection,
 * not provider state.
 */

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, isNotNull, lt } from "drizzle-orm";

import { recomputeMembership } from "./membershipSources.js";

export async function sweepExpiredGrace(
  opts: { asOf?: Date; limit?: number } = {},
): Promise<{ examined: number; converged: number }> {
  const asOf = opts.asOf ?? new Date();

  const lapsed = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.membershipTier, "legendary"),
        isNotNull(usersTable.membershipValidUntil),
        lt(usersTable.membershipValidUntil, asOf),
      ),
    )
    .limit(opts.limit ?? 500);

  let converged = 0;
  for (const user of lapsed) {
    const result = await db.transaction((tx) =>
      recomputeMembership(tx, user.id, {
        asOf,
        transitionEvent: { event: "grace_expired" },
      }),
    );
    if (result?.changed) converged += 1;
  }

  return { examined: lapsed.length, converged };
}
