/**
 * Integration tests for lib/activity.ts.
 *
 * Tests talk to the real test DB. A dedicated test user (prefixed "t_act_")
 * is created once for the suite and removed in the after() hook.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, activityFeedTable } from "@workspace/db/schema";
import { eq, and, gte } from "drizzle-orm";

import { logActivity, type ActivityType } from "../lib/activity.js";


const TEST_USER_ID = `t_act_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const SUITE_START = new Date();

async function setupUser(): Promise<void> {
  await db.insert(usersTable).values({
    id: TEST_USER_ID,
    email: `${TEST_USER_ID}@test.local`,
    isActive: true,
  }).onConflictDoNothing();
}

async function cleanup(): Promise<void> {
  await db.delete(activityFeedTable).where(eq(activityFeedTable.userId, TEST_USER_ID));
  await db.delete(usersTable).where(eq(usersTable.id, TEST_USER_ID));
}

before(async () => {
  await cleanup();
  await setupUser();
});

after(cleanup);

async function getRecentEntries(actionType?: ActivityType) {
  const rows = await db
    .select()
    .from(activityFeedTable)
    .where(
      and(
        eq(activityFeedTable.userId, TEST_USER_ID),
        gte(activityFeedTable.createdAt, SUITE_START),
      ),
    );
  return actionType ? rows.filter((r) => r.actionType === actionType) : rows;
}

describe("logActivity", () => {
  it("inserts a row into activity_feed with correct fields", async () => {
    await logActivity({
      userId: TEST_USER_ID,
      actionType: "fact_submitted",
      message: "Test fact submitted",
      metadata: { factId: 42 },
    });

    const rows = await getRecentEntries("fact_submitted");
    assert.ok(rows.length >= 1, "at least one fact_submitted row should exist");
    const row = rows.find((r) => r.message === "Test fact submitted");
    assert.ok(row, "row with correct message should be present");
    assert.equal(row.userId, TEST_USER_ID);
    assert.equal(row.actionType, "fact_submitted");
    assert.deepEqual(row.metadata, { factId: 42 });
    assert.equal(row.read, false);
  });

  it("works for every supported activity type without throwing", async () => {
    const types: ActivityType[] = [
      "fact_submitted", "fact_approved", "duplicate_flagged",
      "review_submitted", "review_approved", "review_rejected",
      "comment_posted", "comment_approved", "comment_rejected",
      "vote_cast", "system_message",
    ];
    for (const actionType of types) {
      await assert.doesNotReject(
        () => logActivity({ userId: TEST_USER_ID, actionType, message: `test ${actionType}` }),
        `logActivity should not throw for type: ${actionType}`,
      );
    }
  });

  it("works without metadata (metadata is optional)", async () => {
    await logActivity({
      userId: TEST_USER_ID,
      actionType: "vote_cast",
      message: "No metadata call",
    });

    const rows = await getRecentEntries("vote_cast");
    const row = rows.find((r) => r.message === "No metadata call");
    assert.ok(row, "row should be inserted even without metadata");
    assert.equal(row.metadata, null);
  });

  it("does not throw when the DB write would fail due to bad userId", async () => {
    // logActivity is fire-and-forget: it swallows errors rather than propagating them.
    await assert.doesNotReject(
      () =>
        logActivity({
          userId: "nonexistent_user_that_violates_fk",
          actionType: "system_message",
          message: "Should be swallowed",
        }),
      "logActivity must not throw even when the DB write fails",
    );
  });
});
