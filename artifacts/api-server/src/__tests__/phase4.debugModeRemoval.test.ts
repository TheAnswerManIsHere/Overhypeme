/**
 * Launch Phase 4, removal 8 — Debug mode is gone (#744; plan
 * docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
 *
 * Pins three things:
 *   1. Migration 0108 REFUSES while debug_mode_active is "true", naming the
 *      settings whose debug value would stop applying, and changes nothing.
 *   2. With the flag off it captures every debug value and the flag row into
 *      feature_permissions_migration_log, deletes the flag row, drops both
 *      columns, and a re-run is a no-op.
 *   3. The config getters read `value`, and the toggle's key is no longer a
 *      setting the config route can write.
 *
 * The test database is built by a schema push before migrate, so the debug
 * columns are already absent here. The migration cases put them back first,
 * which is the state the Repl's dev database is in when 0108 runs there.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { adminConfigTable, featurePermissionsMigrationLogTable, usersTable } from "@workspace/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { bustConfigCache, getConfigInt, getConfigString, getConfigStringWithSource } from "../lib/adminConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0108_retire_debug_mode.sql"),
  "utf8",
);
const MIGRATION_NAME = "0108_retire_debug_mode";

const PREFIX = "t_p4r8_";
const OVERRIDDEN = `${PREFIX}overridden`;
const LABEL_ONLY = `${PREFIX}label_only`;
const PLAIN = `${PREFIX}plain`;
const KEYS = [OVERRIDDEN, LABEL_ONLY, PLAIN, "debug_mode_active"];

let adminSid: string;
let adminId: string;

async function debugColumns(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'admin_config'
       AND column_name IN ('debug_value', 'debug_value_label')
     ORDER BY column_name`);
  return (res.rows as Array<{ column_name: string }>).map((r) => r.column_name);
}

async function logRows() {
  return db
    .select({ deletedRows: featurePermissionsMigrationLogTable.deletedRows })
    .from(featurePermissionsMigrationLogTable)
    .where(eq(featurePermissionsMigrationLogTable.migrationName, MIGRATION_NAME));
}

/** The pre-0108 state: both columns present, the flag row, and three settings. */
async function seedPreMigrationState(flag: "true" | "false") {
  await db.execute(sql`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS debug_value text`);
  await db.execute(sql`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS debug_value_label text`);
  await db.execute(sql`
    INSERT INTO admin_config (key, value, data_type, label, description, is_public)
    VALUES ('debug_mode_active', ${flag}, 'boolean', 'Debug Mode Active', 'toggle', false)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await db.execute(sql`
    INSERT INTO admin_config (key, value, debug_value, debug_value_label, data_type, label, is_public) VALUES
      (${OVERRIDDEN}, '1000', '100', NULL, 'integer', 'overridden', false),
      (${LABEL_ONLY}, 'a', NULL, 'stale label', 'string', 'label only', false),
      (${PLAIN}, '7', NULL, NULL, 'integer', 'plain', false)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, debug_value = EXCLUDED.debug_value,
      debug_value_label = EXCLUDED.debug_value_label`);
}

async function cleanup() {
  await db.delete(featurePermissionsMigrationLogTable).where(eq(featurePermissionsMigrationLogTable.migrationName, MIGRATION_NAME));
  await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, KEYS));
  await db.execute(sql`ALTER TABLE admin_config DROP COLUMN IF EXISTS debug_value`);
  await db.execute(sql`ALTER TABLE admin_config DROP COLUMN IF EXISTS debug_value_label`);
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
  bustConfigCache();
}

before(async () => {
  await cleanup();
  adminId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary", captchaVerified: true });
  const data: SessionData = {
    user: { id: adminId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
    captchaVerified: true,
  };
  adminSid = await createSession(data, adminId);
});

after(cleanup);

describe("migration 0108 retires Debug mode", () => {
  it("refuses while Debug mode is on, names the overridden settings, and changes nothing", async () => {
    await seedPreMigrationState("true");

    await assert.rejects(
      db.execute(sql.raw(MIGRATION_SQL)),
      (err: unknown) => {
        // drizzle wraps the driver's error; Postgres's own message is the cause.
        const e = err as { message?: string; cause?: { message?: string } };
        const message = `${e.message ?? ""} ${e.cause?.message ?? ""}`;
        assert.match(message, /refusing to remove Debug mode/);
        assert.match(message, new RegExp(OVERRIDDEN));
        return true;
      },
    );

    assert.deepEqual(await debugColumns(), ["debug_value", "debug_value_label"], "the columns are still there");
    const [flag] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable).where(eq(adminConfigTable.key, "debug_mode_active"));
    assert.equal(flag?.value, "true", "the flag row is untouched");
    assert.equal((await logRows()).length, 0, "nothing is captured");
  });

  it("with Debug mode off, captures the debug values and the flag row, deletes the flag, and drops the columns", async () => {
    await seedPreMigrationState("false");

    await db.execute(sql.raw(MIGRATION_SQL));

    assert.deepEqual(await debugColumns(), [], "both columns are dropped");
    const flag = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, "debug_mode_active"));
    assert.equal(flag.length, 0, "the debug_mode_active row is deleted");
    const [overridden] = await db.select({ value: adminConfigTable.value }).from(adminConfigTable).where(eq(adminConfigTable.key, OVERRIDDEN));
    assert.equal(overridden.value, "1000", "a setting keeps its standard value");

    const logs = await logRows();
    assert.equal(logs.length, 1, "one capture row");
    const captured = logs[0].deletedRows as {
      debug_overrides: Array<{ key: string; value: string; debug_value: string | null; debug_value_label: string | null }>;
      debug_mode_active: { key: string; value: string } | null;
    };
    const ours = captured.debug_overrides.filter((r) => r.key.startsWith(PREFIX));
    assert.deepEqual(
      ours.map((r) => [r.key, r.value, r.debug_value, r.debug_value_label]),
      [
        [LABEL_ONLY, "a", null, "stale label"],
        [OVERRIDDEN, "1000", "100", null],
      ],
      "every row with a debug value or label is captured whole; a plain row is not",
    );
    assert.deepEqual([captured.debug_mode_active?.key, captured.debug_mode_active?.value], ["debug_mode_active", "false"]);
  });

  it("is a no-op on a second run", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.equal((await logRows()).length, 1, "a re-run writes no second capture row");
    assert.deepEqual(await debugColumns(), []);
  });
});

describe("after Debug mode, a setting has one value", () => {
  it("every getter reads value, and the provenance source is the stored value", async () => {
    bustConfigCache();
    assert.equal(await getConfigInt(OVERRIDDEN, -1), 1000);
    assert.equal(await getConfigString(OVERRIDDEN, "x"), "1000");
    assert.deepEqual(await getConfigStringWithSource(OVERRIDDEN, "x"), { value: "1000", source: "admin_config_value" });
  });

  it("the old toggle is not a setting the config route can write", async () => {
    const res = await request(createApp())
      .patch("/api/admin/config/debug_mode_active")
      .set("Authorization", `Bearer ${adminSid}`)
      .send({ value: "true" });
    assert.equal(res.status, 404);
  });

  it("the config list carries no debug fields", async () => {
    bustConfigCache();
    const res = await request(createApp()).get("/api/admin/config").set("Authorization", `Bearer ${adminSid}`);
    assert.equal(res.status, 200);
    const rows = res.body as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.key === OVERRIDDEN);
    assert.ok(row, "the setting is listed");
    assert.equal("debugValue" in row, false);
    assert.equal("debugValueLabel" in row, false);
    assert.equal(rows.some((r) => r.key === "debug_mode_active"), false);
  });
});
