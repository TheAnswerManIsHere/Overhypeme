import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { emailOutboxTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import {
  sendEmail,
  emailOutboxTick,
  recoverStuckSendingRows,
  RETRY_DELAYS_MS,
  isEnabled,
} from "../lib/email.js";

const TEST_TAG = "t248_test";

async function insertOutboxRow(overrides: Partial<{
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  updatedAt: Date;
}> = {}) {
  const [row] = await db.insert(emailOutboxTable).values({
    to:            "test@example.com",
    subject:       "Test subject",
    text:          "Test body",
    html:          "<p>Test body</p>",
    kind:          TEST_TAG,
    status:        overrides.status ?? "pending",
    attempts:      overrides.attempts ?? 0,
    maxAttempts:   overrides.maxAttempts ?? 5,
    nextAttemptAt: overrides.nextAttemptAt ?? new Date(),
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
  }).returning();
  return row!;
}

async function getRow(id: number) {
  const [row] = await db
    .select()
    .from(emailOutboxTable)
    .where(eq(emailOutboxTable.id, id));
  return row ?? null;
}

async function cleanupTestRows() {
  await db.delete(emailOutboxTable).where(eq(emailOutboxTable.kind, TEST_TAG));
}

/** Wipe the entire outbox. Called once before the suite starts so rows left
 *  over from other test files (e.g. webhook integration tests that call
 *  sendEmail() with a real RESEND_API_KEY) don't fill the LIMIT 10 window
 *  and push our test rows out. */
async function truncateOutbox() {
  await db.delete(emailOutboxTable);
}

const alwaysOk: () => Promise<{ ok: boolean; error?: string }> =
  async () => ({ ok: true });

const alwaysFail: () => Promise<{ ok: boolean; error?: string }> =
  async () => ({ ok: false, error: "simulated delivery failure" });

describe("email outbox engine", () => {
  // Wipe the entire outbox once before the suite so that rows left over from
  // other test files (e.g. webhook integration tests that call sendEmail() with
  // a real RESEND_API_KEY) don't occupy the LIMIT 10 window and crowd out our
  // single-row test inserts.
  before(async () => {
    await truncateOutbox();
  });

  // Always clean up after all tests.
  after(async () => {
    await cleanupTestRows();
  });

  describe("sendEmail()", () => {
    before(async () => { await cleanupTestRows(); });

    it("dev mode: does not insert into outbox (no RESEND_API_KEY)", async () => {
      if (isEnabled()) {
        // If RESEND_API_KEY is set in the test environment, skip this test.
        return;
      }

      const beforeRows = await db
        .select()
        .from(emailOutboxTable)
        .where(eq(emailOutboxTable.kind, TEST_TAG));

      await sendEmail({
        to:      "dev@example.com",
        subject: "Dev mode test",
        text:    "Should not be inserted",
        kind:    TEST_TAG,
      });

      const afterRows = await db
        .select()
        .from(emailOutboxTable)
        .where(eq(emailOutboxTable.kind, TEST_TAG));

      assert.equal(afterRows.length, beforeRows.length, "sendEmail() in dev mode must not insert any outbox rows");
    });

    it("prod mode: inserts a pending row into the outbox", async () => {
      if (!isEnabled()) {
        // Test requires prod mode — skip if no RESEND_API_KEY.
        return;
      }

      const kindTag = `t248_prodmode_${Date.now()}`;
      await sendEmail({
        to:      "prod@example.com",
        subject: "Prod mode test",
        text:    "Should be inserted",
        kind:    kindTag,
      });

      const rows = await db
        .select()
        .from(emailOutboxTable)
        .where(eq(emailOutboxTable.kind, kindTag));

      assert.equal(rows.length, 1, "sendEmail() in prod mode must insert exactly one outbox row");
      assert.equal(rows[0]!.status, "pending");
      assert.equal(rows[0]!.to, "prod@example.com");
      assert.equal(rows[0]!.subject, "Prod mode test");
      assert.equal(rows[0]!.attempts, 0);

      await db.delete(emailOutboxTable).where(eq(emailOutboxTable.kind, kindTag));
    });
  });

  describe("emailOutboxTick()", () => {
    // Each test starts with a clean outbox so global pending rows don't
    // interfere with per-row assertions.
    beforeEach(async () => { await cleanupTestRows(); });

    it("delivers a pending row: marks delivered and increments attempts", async () => {
      const row = await insertOutboxRow({ status: "pending", attempts: 0 });

      await emailOutboxTick(db, alwaysOk, new Date());

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist after delivery");
      assert.equal(updated!.status, "delivered");
      assert.equal(updated!.attempts, 1);
    });

    it("failed delivery: row retried with correct delay (attempt 1 → 5 min)", async () => {
      const row = await insertOutboxRow({ status: "pending", attempts: 0, maxAttempts: 5 });
      const before = Date.now();

      await emailOutboxTick(db, alwaysFail, new Date());

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist");
      assert.equal(updated!.status, "pending", "Row should be pending after first failure");
      assert.equal(updated!.attempts, 1);
      assert.equal(updated!.lastError, "simulated delivery failure");

      const delay = updated!.nextAttemptAt.getTime() - before;
      const expectedDelay = RETRY_DELAYS_MS[1]!;
      assert.ok(
        Math.abs(delay - expectedDelay) < 5_000,
        `nextAttemptAt delay should be ~${expectedDelay}ms, got ${delay}ms`,
      );
    });

    it("failed delivery: row retried with correct delay (attempt 2 → 30 min)", async () => {
      const row = await insertOutboxRow({ status: "pending", attempts: 1, maxAttempts: 5 });
      const before = Date.now();

      await emailOutboxTick(db, alwaysFail, new Date());

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist");
      assert.equal(updated!.status, "pending");
      assert.equal(updated!.attempts, 2);

      const delay = updated!.nextAttemptAt.getTime() - before;
      const expectedDelay = RETRY_DELAYS_MS[2]!;
      assert.ok(
        Math.abs(delay - expectedDelay) < 5_000,
        `nextAttemptAt delay should be ~${expectedDelay}ms, got ${delay}ms`,
      );
    });

    it("abandons a row after maxAttempts exhausted", async () => {
      const row = await insertOutboxRow({ status: "pending", attempts: 4, maxAttempts: 5 });

      await emailOutboxTick(db, alwaysFail, new Date());

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist");
      assert.equal(updated!.status, "abandoned");
      assert.equal(updated!.attempts, 5);
      assert.ok(updated!.lastError, "lastError should be set on abandonment");
    });

    it("skips rows where nextAttemptAt is in the future", async () => {
      const futureTime = new Date(Date.now() + 10 * 60_000);
      const row = await insertOutboxRow({ status: "pending", nextAttemptAt: futureTime });

      let deliverCalled = false;
      const trackingDeliver = async () => {
        deliverCalled = true;
        return { ok: true };
      };

      await emailOutboxTick(db, trackingDeliver, new Date());

      assert.equal(deliverCalled, false, "Delivery should not be called for future rows");

      const updated = await getRow(row.id);
      assert.equal(updated!.status, "pending", "Future row should still be pending");
    });
  });

  describe("recoverStuckSendingRows()", () => {
    beforeEach(async () => { await cleanupTestRows(); });

    it("resets sending rows older than cutoff back to pending", async () => {
      const staleTime = new Date(Date.now() - 10 * 60_000);
      const row = await insertOutboxRow({
        status:    "sending",
        updatedAt: staleTime,
      });

      await recoverStuckSendingRows(db, 5);

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist");
      assert.equal(updated!.status, "pending", "Stale sending row should be reset to pending");
    });

    it("does not reset sending rows updated within the cutoff window", async () => {
      const recentTime = new Date(Date.now() - 60_000);
      const row = await insertOutboxRow({
        status:    "sending",
        updatedAt: recentTime,
      });

      await recoverStuckSendingRows(db, 5);

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist");
      assert.equal(updated!.status, "sending", "Recent sending row should remain in sending status");
    });
  });
});
