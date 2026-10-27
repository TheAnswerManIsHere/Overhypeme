/**
 * Launch Phase 3, increment 2 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §1, "a second boot preserves everything"): running the server's own database
 * boot steps again on a database that already holds data — the migration
 * runner, ensureSchema() and the engine reconcile, in boot order — keeps the
 * data, keeps an operator's setting, and changes no structure. The worker
 * database this runs on is a copy of one the runner built from the schema
 * baseline, ledger included, so the runner takes its upgrade path, as a
 * restarted production server does.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db, pool, runMigrations, usersTable, adminConfigTable } from "@workspace/db";
import { catalogFingerprint, fingerprintDiff } from "@workspace/db/baseline";
import { eq } from "drizzle-orm";

import { ensureSchema } from "../lib/seed.js";
import { reconcileEngines } from "../lib/engines/index.js";

const userId = `t_p3boot_${randomUUID()}`;
let restore: { key: string; value: string } | null = null;

describe("a second boot on a built database", () => {
  after(async () => {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    if (restore) await db.update(adminConfigTable).set({ value: restore.value }).where(eq(adminConfigTable.key, restore.key));
  });

  it("keeps the data, keeps an operator's setting, and changes no structure", async () => {
    const client = await pool.connect();
    try {
      const schema = (await client.query<{ s: string }>("SELECT current_schema() AS s")).rows[0].s;

      await db.insert(usersTable).values({ id: userId, email: `${userId}@example.test` });
      const [setting] = await db
        .select({ key: adminConfigTable.key, value: adminConfigTable.value })
        .from(adminConfigTable)
        .where(eq(adminConfigTable.dataType, "integer"))
        .limit(1);
      assert.ok(setting, "the baseline seeds integer settings");
      restore = setting;
      const operatorValue = String(Number(setting.value) + 7);
      await db.update(adminConfigTable).set({ value: operatorValue }).where(eq(adminConfigTable.key, setting.key));

      const before = await catalogFingerprint(client, schema);
      await runMigrations();
      await ensureSchema();
      await reconcileEngines();
      const after = await catalogFingerprint(client, schema);

      assert.deepEqual(fingerprintDiff(before, after), { onlyA: [], onlyB: [] }, "the second boot changed structure");
      const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId));
      assert.equal(user?.id, userId, "the second boot lost data");
      const [kept] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable).where(eq(adminConfigTable.key, setting.key));
      assert.equal(kept.value, operatorValue, "the second boot overwrote an operator's setting");
    } finally {
      client.release();
    }
  });
});
