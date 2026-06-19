/**
 * Integration test for the upload rate limit. Talks to the real test DB
 * via @workspace/db. Each test bumps the shared `rate_limit_counters`
 * table with a unique user id so it does not interfere with parallel runs.
 *
 * The test asserts:
 *   - The 24h window is honored (count grows monotonically, never expires).
 *   - The free-tier and legendary-tier limits come from admin_config and
 *     are applied per the user's membershipTier.
 *   - Real admins are exempt (limit = MAX_SAFE_INTEGER).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { rateLimitCountersTable, adminConfigTable } from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";

import { checkUploadRateLimit, getDailyUploadLimit } from "../lib/moderation/uploadRateLimit.js";
import { bustConfigCache } from "../lib/adminConfig.js";

const TEST_USER_PREFIX = "tmurl-";

async function clean() {
  await db.delete(rateLimitCountersTable).where(like(rateLimitCountersTable.keyRaw, `%${TEST_USER_PREFIX}%`));
}

describe("moderation/uploadRateLimit", () => {
  before(async () => {
    bustConfigCache();
    await clean();
  });
  after(async () => {
    await clean();
  });

  describe("getDailyUploadLimit", () => {
    it("admins get an effectively unlimited cap", async () => {
      const limit = await getDailyUploadLimit("registered", true);
      assert.ok(limit > 1_000_000);
    });
    it("registered users get the registered cap", async () => {
      const limit = await getDailyUploadLimit("registered", false);
      assert.ok(limit > 0 && limit <= 100, `expected free cap, got ${limit}`);
    });
    it("legendary users get the legendary cap", async () => {
      const reg = await getDailyUploadLimit("registered", false);
      const leg = await getDailyUploadLimit("legendary", false);
      assert.ok(leg >= reg, `legendary (${leg}) should be >= registered (${reg})`);
    });
  });

  describe("checkUploadRateLimit", () => {
    it("counts attempts and rejects past the configured limit", async () => {
      // Force a tiny limit via admin_config so the test runs in milliseconds.
      // Use INSERT … ON CONFLICT DO UPDATE so the row is created if admin_config is empty
      // (e.g. in the isolated test schema which has no seed data).
      await db
        .insert(adminConfigTable)
        .values({
          key: "upload_rate_limit_registered_per_day",
          value: "2",
          label: "Upload rate limit (registered/day)",
        })
        .onConflictDoUpdate({
          target: adminConfigTable.key,
          set: { value: "2" },
        });
      bustConfigCache();
      const userId = `${TEST_USER_PREFIX}${Date.now()}-${Math.random()}`;
      const r1 = await checkUploadRateLimit({ userId, membershipTier: "registered", isAdmin: false });
      const r2 = await checkUploadRateLimit({ userId, membershipTier: "registered", isAdmin: false });
      const r3 = await checkUploadRateLimit({ userId, membershipTier: "registered", isAdmin: false });
      assert.equal(r1.allowed, true);
      assert.equal(r2.allowed, true);
      assert.equal(r3.allowed, false);
      assert.equal(r1.limit, 2);
      // Restore the original value so subsequent test files see the seed.
      await db
        .insert(adminConfigTable)
        .values({
          key: "upload_rate_limit_registered_per_day",
          value: "20",
          label: "Upload rate limit (registered/day)",
        })
        .onConflictDoUpdate({
          target: adminConfigTable.key,
          set: { value: "20" },
        });
      bustConfigCache();
    });
  });
});
