/**
 * purgeTestData — the single, authoritative, FK-safe sweep of all test-created
 * rows from the database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The api-server test suite runs against the *real* development database (there
 * is no isolated test DB). Every test inserts rows prefixed with a recognisable
 * marker and is supposed to delete them again in its own `after()` hook.
 *
 * Two failure modes caused test rows to accumulate indefinitely:
 *
 *   1. FK-unsafe per-file cleanup. A file deleted its users with a broad
 *      `DELETE FROM users WHERE id LIKE 'prefix%'` but deleted child rows
 *      (memes, activity-feed, …) only by the ids it tracked in-memory. Any
 *      orphan child row — left by a previous run — made the parent delete
 *      violate a foreign-key constraint, so the whole cleanup aborted and *more*
 *      rows leaked on every subsequent run.
 *
 *   2. The runner has a hard wall-clock kill (`with-time-limit.sh`). When it
 *      fires mid-run, `after()` hooks never execute, so that run's rows survive.
 *
 * This helper fixes both by (a) deleting strictly child-before-parent so it can
 * never hit an FK violation, and (b) being invoked as a global *pre-sweep* and
 * *post-sweep* around the whole sharded run (see run-tests-sharded.sh). The
 * pre-sweep means even a hard-killed previous run is healed before the next run
 * starts: the database holds test rows only *during* an active run, never after.
 *
 * SAFETY
 * ------
 * Real user ids are UUIDs (hex only — `0-9a-f`), which can never begin with the
 * letter `t`. Every test user id, by convention, begins with `t`. So
 * `users.id LIKE 't%'` matches all test users and zero real users. We only ever
 * delete rows reachable from a test user (or a test-submitted fact); real seed
 * data is never touched.
 */

import { db } from "@workspace/db";
import {
  usersTable,
  memesTable,
  factsTable,
  commentsTable,
  activityFeedTable,
  affiliateClicksTable,
  pendingReviewsTable,
  subscriptionsTable,
  lifetimeEntitlementsTable,
  membershipHistoryTable,
  externalLinksTable,
  stripeCheckoutRequestLedgerTable,
} from "@workspace/db/schema";
import { and, isNull, like, or } from "drizzle-orm";

/** Marker every test user id begins with. UUIDs (real users) never start with `t`. */
export const TEST_USER_ID_PREFIX = "t";

const TEST_LIKE = `${TEST_USER_ID_PREFIX}%`;

export interface PurgeResult {
  /** Rows deleted, keyed by table name. Tables with zero deletions are omitted. */
  deleted: Record<string, number>;
}

/**
 * Delete every row reachable from a test user, child-before-parent, then the
 * test users themselves. Ordering is exhaustive over the user-referencing FKs
 * that are NOT declared `onDelete: cascade`/`set null` in the schema — those are
 * the only ones that can block a `DELETE FROM users`.
 *
 * Cascade FKs (auth/session rows, reactions, ratings, search history, share
 * intents, user-ai-images, user-fact-preferences) are cleaned automatically when
 * the user row is removed. Set-null FKs (memes.userId, moderation, image-prompt-
 * attempts, admin-config, transient-renders) never block deletion, so they are
 * intentionally left alone. The non-cascade tables purged below are the complete
 * set of user-referencing FKs without onDelete in the schema.
 */
export async function purgeTestData(): Promise<PurgeResult> {
  const deleted: Record<string, number> = {};

  const del = async (
    name: string,
    run: () => Promise<{ rowCount: number | null }>,
  ): Promise<void> => {
    const res = await run();
    const n = res.rowCount ?? 0;
    if (n > 0) deleted[name] = n;
  };

  // ── Children of test USERS (non-cascade FKs that would block user deletion) ──
  await del("memes", () =>
    db.delete(memesTable).where(like(memesTable.createdById, TEST_LIKE)),
  );

  await del("pending_reviews", () =>
    db
      .delete(pendingReviewsTable)
      .where(
        or(
          like(pendingReviewsTable.submittedById, TEST_LIKE),
          like(pendingReviewsTable.reviewedById, TEST_LIKE),
        ),
      ),
  );

  await del("subscriptions", () =>
    db.delete(subscriptionsTable).where(like(subscriptionsTable.userId, TEST_LIKE)),
  );

  await del("lifetime_entitlements", () =>
    db
      .delete(lifetimeEntitlementsTable)
      .where(
        or(
          like(lifetimeEntitlementsTable.userId, TEST_LIKE),
          like(lifetimeEntitlementsTable.grantedByAdminId, TEST_LIKE),
        ),
      ),
  );

  await del("membership_history", () =>
    db
      .delete(membershipHistoryTable)
      .where(
        or(
          like(membershipHistoryTable.userId, TEST_LIKE),
          like(membershipHistoryTable.performedByAdminId, TEST_LIKE),
        ),
      ),
  );

  await del("comments", () =>
    db.delete(commentsTable).where(like(commentsTable.authorId, TEST_LIKE)),
  );

  await del("activity_feed", () =>
    db.delete(activityFeedTable).where(like(activityFeedTable.userId, TEST_LIKE)),
  );

  await del("affiliate_clicks", () =>
    db.delete(affiliateClicksTable).where(like(affiliateClicksTable.userId, TEST_LIKE)),
  );

  await del("external_links", () =>
    db.delete(externalLinksTable).where(like(externalLinksTable.addedById, TEST_LIKE)),
  );

  await del("stripe_checkout_request_ledger", () =>
    db
      .delete(stripeCheckoutRequestLedgerTable)
      .where(like(stripeCheckoutRequestLedgerTable.userId, TEST_LIKE)),
  );

  // Facts inserted directly by test files (no submitter) are identified by their
  // text prefix. Every test file that inserts facts without a submitter uses a
  // text prefix starting with `t` (e.g. `t-cmr-fact-`, `t-ipp-fact-`,
  // `t_p4s_fact_`, `t-vj-fact`, …). Real facts with null submitter start with
  // `{NAME}`, `When`, `Firearms`, etc. — never a bare `t`. This sweep runs after
  // memes are purged above so no memes.factId FK can block it.
  await del("facts_by_text_prefix", () =>
    db.delete(factsTable).where(
      and(isNull(factsTable.submittedById), like(factsTable.text, "t%")),
    ),
  );

  // Facts SUBMITTED by a test user are themselves test data.
  await del("facts", () =>
    db.delete(factsTable).where(like(factsTable.submittedById, TEST_LIKE)),
  );

  // ── Finally the test users (cascade/set-null children handled by the DB) ──
  await del("users", () =>
    db.delete(usersTable).where(like(usersTable.id, TEST_LIKE)),
  );

  return { deleted };
}

/**
 * CLI entry: `node --import tsx/esm src/__tests__/helpers/purgeTestData.ts`.
 * Used by run-tests-sharded.sh for the pre-/post-run sweeps and runnable by hand.
 */
async function main(): Promise<void> {
  const { closePool } = await import("@workspace/db");
  try {
    const { deleted } = await purgeTestData();
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total === 0) {
      console.log("[purge-test-data] clean — no test rows found");
    } else {
      const detail = Object.entries(deleted)
        .map(([t, n]) => `${t}=${n}`)
        .join(" ");
      console.log(`[purge-test-data] removed ${total} test rows (${detail})`);
    }
  } finally {
    await closePool();
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[purge-test-data] failed:", err);
    process.exit(1);
  });
}
