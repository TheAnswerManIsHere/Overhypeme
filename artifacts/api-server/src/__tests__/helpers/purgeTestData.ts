/**
 * purgeTestData — FK-safe sweep of test-created rows from the test database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The api-server test suite runs against an **isolated test database**
 * (${PGDATABASE}_test), never the development database. This sweep is invoked
 * as a pre-sweep and post-sweep around the sharded run (see
 * run-tests-sharded.sh) to clean up any rows left over from a previously
 * interrupted run, so every run starts from a clean state.
 *
 * Because tests run on an isolated database, these sweeps no longer protect
 * development data. They are a quality-of-life tool: they ensure a crashed or
 * SIGKILL'd run does not leave behind stale rows that would confuse the next
 * run's assertions.
 *
 * HOW IT IDENTIFIES TEST ROWS
 * ---------------------------
 * The purge uses the t-prefix convention to find rows within the test database:
 *   • Test user ids begin with `t` (real UUIDs are hex-only: 0-9a-f).
 *   • Facts inserted without a submitter use text starting with `t`.
 * Deletions proceed strictly child-before-parent so FK constraints are never
 * violated, even when previous runs left orphaned child rows.
 *
 * NOTE FOR TEST AUTHORS
 * ----------------------
 * The t-prefix convention (t-prefixed user ids, t-prefixed null-submitter fact
 * text) still applies so this purge can identify and remove your test rows from
 * the test database between runs. Without it, stale rows from an interrupted
 * run could cause spurious failures in the next run's assertions.
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
  membershipEntitlementsTable,
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

  // One table now, and one delete. `entitlement_source_disputes` cascades off it.
  await del("membership_entitlements", () =>
    db
      .delete(membershipEntitlementsTable)
      .where(
        or(
          like(membershipEntitlementsTable.userId, TEST_LIKE),
          like(membershipEntitlementsTable.grantedByAdminId, TEST_LIKE),
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
