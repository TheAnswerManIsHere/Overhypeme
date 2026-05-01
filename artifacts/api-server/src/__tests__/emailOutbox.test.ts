import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { emailOutboxTable, adminConfigTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import {
  sendEmail,
  emailOutboxTick,
  recoverStuckSendingRows,
  purgeTerminalEmailRows,
  RETRY_DELAYS_MS,
  isEnabled,
} from "../lib/email.js";
import { bustConfigCache } from "../lib/adminConfig.js";
import { TEST_KIND_PREFIX } from "./helpers/testConstants.js";


const TEST_TAG = `${TEST_KIND_PREFIX}t248`;

/**
 * Kind used for rows that purge tests explicitly expect to be deleted.
 * Must NOT start with TEST_KIND_PREFIX so that purgeTerminalEmailRows calls
 * passing TEST_KIND_PREFIX as excludeKindPrefix still delete these rows.
 */
const PURGE_TEST_KIND = "purge:t248";

async function insertOutboxRow(overrides: Partial<{
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  updatedAt: Date;
  createdAt: Date;
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
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  }).returning();
  return row!;
}

async function insertPurgeableRow(overrides: Partial<{
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  updatedAt: Date;
  createdAt: Date;
}> = {}) {
  const [row] = await db.insert(emailOutboxTable).values({
    to:            "test@example.com",
    subject:       "Test subject",
    text:          "Test body",
    html:          "<p>Test body</p>",
    kind:          PURGE_TEST_KIND,
    status:        overrides.status ?? "pending",
    attempts:      overrides.attempts ?? 0,
    maxAttempts:   overrides.maxAttempts ?? 5,
    nextAttemptAt: overrides.nextAttemptAt ?? new Date(),
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
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
  await db.delete(emailOutboxTable).where(eq(emailOutboxTable.kind, PURGE_TEST_KIND));
}


const alwaysOk: () => Promise<{ ok: boolean; error?: string }> =
  async () => ({ ok: true });

const alwaysFail: () => Promise<{ ok: boolean; error?: string }> =
  async () => ({ ok: false, error: "simulated delivery failure" });

const RETENTION_CONFIG_KEY = "email_outbox_retention_days";

async function setRetentionDays(days: number): Promise<void> {
  await db
    .insert(adminConfigTable)
    .values({
      key:      RETENTION_CONFIG_KEY,
      value:    String(days),
      dataType: "integer",
      label:    "Email outbox retention days (test)",
    })
    .onConflictDoUpdate({
      target: adminConfigTable.key,
      set:    { value: String(days) },
    });
  bustConfigCache();
}

async function removeRetentionConfig(): Promise<void> {
  await db.delete(adminConfigTable).where(eq(adminConfigTable.key, RETENTION_CONFIG_KEY));
  bustConfigCache();
}

const RETRY_CONFIG_KEYS = [
  "email_max_attempts",
  "email_retry_delay_1_ms",
  "email_retry_delay_2_ms",
  "email_retry_delay_3_ms",
  "email_retry_delay_4_ms",
] as const;

async function setRetryConfigValue(key: typeof RETRY_CONFIG_KEYS[number], value: number): Promise<void> {
  await db
    .insert(adminConfigTable)
    .values({
      key,
      value:    String(value),
      dataType: "integer",
      label:    `${key} (test override)`,
    })
    .onConflictDoUpdate({
      target: adminConfigTable.key,
      set:    { value: String(value) },
    });
  bustConfigCache();
}

async function removeRetryConfigs(): Promise<void> {
  for (const key of RETRY_CONFIG_KEYS) {
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, key));
  }
  bustConfigCache();
}

describe("email outbox engine", () => {
  // Clean up our own test rows before the suite starts, and after it finishes.
  // We do NOT truncate the entire outbox here to avoid racing with other
  // concurrent test files (e.g. adminEmailQueue.delete.test.ts) that also
  // insert into email_outbox.
  before(async () => {
    await cleanupTestRows();
  });

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
    // Clean up only our own kind-tagged rows before each tick test.
    // We intentionally avoid a full-outbox truncation here because this file
    // runs concurrently with adminEmailQueue.delete.test.ts; a global
    // DELETE would race with that file's INSERT/DELETE assertions.
    beforeEach(async () => { await cleanupTestRows(); });

    it("delivers a pending row: marks delivered and increments attempts", async () => {
      const row = await insertOutboxRow({ status: "pending", attempts: 0 });

      await emailOutboxTick(db, alwaysOk, new Date(), TEST_KIND_PREFIX);

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist after delivery");
      assert.equal(updated!.status, "delivered");
      assert.equal(updated!.attempts, 1);
    });

    it("failed delivery: row retried with correct delay (attempt 1 → 5 min)", async () => {
      const row = await insertOutboxRow({ status: "pending", attempts: 0, maxAttempts: 5 });
      const before = Date.now();

      await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

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

      await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

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

      await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

      const updated = await getRow(row.id);
      assert.ok(updated, "Row must still exist");
      assert.equal(updated!.status, "abandoned");
      assert.equal(updated!.attempts, 5);
      assert.ok(updated!.lastError, "lastError should be set on abandonment");
    });

    it("skips rows where nextAttemptAt is in the future", async () => {
      const futureTime = new Date(Date.now() + 10 * 60_000);
      // Use a unique subject so we can identify our row in the delivery function even if
      // other pending rows (e.g. from concurrent async notifications) are present.
      const uniqueSubject = `Future-skip-test-${Date.now()}`;
      const [ourRow] = await db.insert(emailOutboxTable).values({
        to:            "test@example.com",
        subject:       uniqueSubject,
        text:          "Test body",
        html:          "<p>Test body</p>",
        kind:          TEST_TAG,
        status:        "pending",
        attempts:      0,
        maxAttempts:   5,
        nextAttemptAt: futureTime,
      }).returning();

      let ourRowDelivered = false;
      const trackingDeliver = async (row: { subject: string }) => {
        if (row.subject === uniqueSubject) ourRowDelivered = true;
        return { ok: true as const };
      };

      await emailOutboxTick(db, trackingDeliver, new Date(), TEST_KIND_PREFIX);

      assert.equal(ourRowDelivered, false, "Delivery should not be called for our future-dated row");

      const updated = await getRow(ourRow!.id);
      assert.ok(updated, "Future-dated row must still exist");
      assert.equal(updated!.status, "pending", "Future row should still be pending");
    });

    it("purges old terminal rows as a side effect of the tick", async () => {
      await setRetentionDays(30);
      try {
        const oldDate    = new Date(Date.now() - 40 * 24 * 3_600_000);
        const futureTime = new Date(Date.now() + 10 * 60_000);

        // Rows to be purged use PURGE_TEST_KIND (not protected by excludeKindPrefix)
        const oldDelivered    = await insertPurgeableRow({ status: "delivered", createdAt: oldDate });
        const oldAbandoned    = await insertPurgeableRow({ status: "abandoned", createdAt: oldDate });
        // Rows that must survive use TEST_TAG (protected by excludeKindPrefix, also not old/non-terminal)
        const recentDelivered = await insertOutboxRow({ status: "delivered" });
        // Pending row with a future nextAttemptAt: tick skips it, purge must also ignore it
        const skippedPending  = await insertOutboxRow({ status: "pending",   createdAt: oldDate, nextAttemptAt: futureTime });

        await emailOutboxTick(db, alwaysOk, new Date(), TEST_KIND_PREFIX);

        assert.equal(await getRow(oldDelivered.id),    null, "Old delivered row should be purged by tick");
        assert.equal(await getRow(oldAbandoned.id),    null, "Old abandoned row should be purged by tick");
        assert.ok(  await getRow(recentDelivered.id),        "Recent delivered row must not be purged");
        assert.ok(  await getRow(skippedPending.id),         "Old pending row must never be purged even when old");
      } finally {
        await removeRetentionConfig();
      }
    });

    it("does not purge any rows when retention is disabled (0) during a tick", async () => {
      await setRetentionDays(0);
      try {
        const oldDate = new Date(Date.now() - 40 * 24 * 3_600_000);
        const oldDelivered = await insertPurgeableRow({ status: "delivered", createdAt: oldDate });

        await emailOutboxTick(db, alwaysOk, new Date(), TEST_KIND_PREFIX);

        assert.ok(await getRow(oldDelivered.id), "Old delivered row must survive when retention is disabled");
      } finally {
        await removeRetentionConfig();
      }
    });

    describe("configurable retry behaviour", () => {
      afterEach(async () => {
        await cleanupTestRows();
        await removeRetryConfigs();
      });

      it("honours a lower email_max_attempts — abandons after fewer failures", async () => {
        await setRetryConfigValue("email_max_attempts", 2);

        const row = await insertOutboxRow({ status: "pending", attempts: 1, maxAttempts: 5 });

        await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

        const updated = await getRow(row.id);
        assert.ok(updated, "Row must still exist");
        assert.equal(updated!.status, "abandoned", "Row should be abandoned when attempts reaches config maxAttempts (2)");
        assert.equal(updated!.attempts, 2);
      });

      it("honours a higher email_max_attempts — does not abandon before the configured limit", async () => {
        await setRetryConfigValue("email_max_attempts", 10);

        const row = await insertOutboxRow({ status: "pending", attempts: 4, maxAttempts: 5 });

        await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

        const updated = await getRow(row.id);
        assert.ok(updated, "Row must still exist");
        assert.equal(updated!.status, "pending", "Row should still be pending when attempts (5) is below config maxAttempts (10)");
        assert.equal(updated!.attempts, 5);
      });

      it("honours a custom email_retry_delay_1_ms — sets nextAttemptAt using the configured delay", async () => {
        const customDelayMs = 60_000;
        await setRetryConfigValue("email_retry_delay_1_ms", customDelayMs);

        const row = await insertOutboxRow({ status: "pending", attempts: 0, maxAttempts: 5 });
        const before = Date.now();

        await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

        const updated = await getRow(row.id);
        assert.ok(updated, "Row must still exist");
        assert.equal(updated!.status, "pending");
        assert.equal(updated!.attempts, 1);

        const actualDelay = updated!.nextAttemptAt.getTime() - before;
        assert.ok(
          Math.abs(actualDelay - customDelayMs) < 5_000,
          `nextAttemptAt delay should be ~${customDelayMs}ms (custom delay_1), got ${actualDelay}ms`,
        );
      });

      it("honours a custom email_retry_delay_2_ms — sets nextAttemptAt using the configured delay for attempt 2", async () => {
        const customDelayMs = 120_000;
        await setRetryConfigValue("email_retry_delay_2_ms", customDelayMs);

        const row = await insertOutboxRow({ status: "pending", attempts: 1, maxAttempts: 5 });
        const before = Date.now();

        await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

        const updated = await getRow(row.id);
        assert.ok(updated, "Row must still exist");
        assert.equal(updated!.status, "pending");
        assert.equal(updated!.attempts, 2);

        const actualDelay = updated!.nextAttemptAt.getTime() - before;
        assert.ok(
          Math.abs(actualDelay - customDelayMs) < 5_000,
          `nextAttemptAt delay should be ~${customDelayMs}ms (custom delay_2), got ${actualDelay}ms`,
        );
      });

      it("picks up a new email_max_attempts value after bustConfigCache", async () => {
        await setRetryConfigValue("email_max_attempts", 10);

        const row = await insertOutboxRow({ status: "pending", attempts: 4, maxAttempts: 5 });

        await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

        const afterFirstTick = await getRow(row.id);
        assert.ok(afterFirstTick, "Row must exist after first tick");
        assert.equal(afterFirstTick!.status, "pending", "Row should still be pending with maxAttempts=10");

        await setRetryConfigValue("email_max_attempts", 5);

        await db.update(emailOutboxTable)
          .set({ status: "pending", nextAttemptAt: new Date() })
          .where(eq(emailOutboxTable.id, row.id));

        await emailOutboxTick(db, alwaysFail, new Date(), TEST_KIND_PREFIX);

        const afterSecondTick = await getRow(row.id);
        assert.ok(afterSecondTick, "Row must exist after second tick");
        assert.equal(afterSecondTick!.status, "abandoned", "Row should be abandoned after config bust reduces maxAttempts to 5");
      });
    });
  });

  describe("purgeTerminalEmailRows()", () => {
    // Use kind-based cleanup so we don't race with other concurrent test files
    // that also insert into email_outbox. Count assertions are avoided for the
    // same reason; we assert on specific row IDs instead.
    beforeEach(async () => { await cleanupTestRows(); });
    afterEach(async () => {
      await cleanupTestRows();
      await removeRetentionConfig();
    });

    it("deletes a delivered row older than the retention window", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 3_600_000);
      await setRetentionDays(30);
      const row = await insertPurgeableRow({ status: "delivered", createdAt: oldDate });

      await purgeTerminalEmailRows(db, new Date(), TEST_KIND_PREFIX);

      assert.equal(await getRow(row.id), null, "Delivered row older than retention should be deleted");
    });

    it("deletes an abandoned row older than the retention window", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 3_600_000);
      await setRetentionDays(30);
      const row = await insertPurgeableRow({ status: "abandoned", createdAt: oldDate });

      await purgeTerminalEmailRows(db, new Date(), TEST_KIND_PREFIX);

      assert.equal(await getRow(row.id), null, "Abandoned row older than retention should be deleted");
    });

    it("does not delete a delivered row within the retention window", async () => {
      const recentDate = new Date(Date.now() - 10 * 24 * 3_600_000);
      await setRetentionDays(30);
      const row = await insertOutboxRow({ status: "delivered", createdAt: recentDate });

      await purgeTerminalEmailRows(db, new Date(), TEST_KIND_PREFIX);

      const remaining = await getRow(row.id);
      assert.ok(remaining, "Delivered row within retention window should still exist");
      assert.equal(remaining!.status, "delivered");
    });

    it("does not delete a pending row regardless of age", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 3_600_000);
      await setRetentionDays(30);
      const row = await insertOutboxRow({ status: "pending", createdAt: oldDate });

      await purgeTerminalEmailRows(db, new Date(), TEST_KIND_PREFIX);

      const remaining = await getRow(row.id);
      assert.ok(remaining, "Old pending row should still exist");
      assert.equal(remaining!.status, "pending");
    });

    it("does not delete a sending row regardless of age", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 3_600_000);
      await setRetentionDays(30);
      const row = await insertOutboxRow({ status: "sending", createdAt: oldDate });

      await purgeTerminalEmailRows(db, new Date(), TEST_KIND_PREFIX);

      const remaining = await getRow(row.id);
      assert.ok(remaining, "Old sending row should still exist");
      assert.equal(remaining!.status, "sending");
    });

    it("returns 0 and deletes nothing when retention is set to 0", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 3_600_000);
      await setRetentionDays(0);
      const row = await insertPurgeableRow({ status: "delivered", createdAt: oldDate });

      const deleted = await purgeTerminalEmailRows(db, new Date(), TEST_KIND_PREFIX);

      assert.equal(deleted, 0, "retention=0 must disable purging entirely — function must return 0 immediately");
      const remaining = await getRow(row.id);
      assert.ok(remaining, "Row must not be deleted when retention is disabled");
    });

    it("purges only terminal rows when mixed statuses exist", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 3_600_000);
      await setRetentionDays(30);

      const deliveredRow = await insertPurgeableRow({ status: "delivered", createdAt: oldDate });
      const abandonedRow = await insertPurgeableRow({ status: "abandoned", createdAt: oldDate });
      const pendingRow   = await insertOutboxRow({ status: "pending",   createdAt: oldDate });
      const sendingRow   = await insertOutboxRow({ status: "sending",   createdAt: oldDate });

      await purgeTerminalEmailRows(db, new Date(), TEST_KIND_PREFIX);

      assert.equal(await getRow(deliveredRow.id), null, "delivered row should be gone");
      assert.equal(await getRow(abandonedRow.id), null, "abandoned row should be gone");
      assert.ok(await getRow(pendingRow.id),  "pending row must survive");
      assert.ok(await getRow(sendingRow.id),  "sending row must survive");
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
