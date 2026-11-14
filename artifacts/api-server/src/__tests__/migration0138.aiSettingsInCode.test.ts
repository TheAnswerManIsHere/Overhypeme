/**
 * Migration 0138 (decisions.md 2026-11-14, the stored AI settings and the
 * engines table are deleted): it captures every retired AI-setting row and
 * every engines row into feature_permissions_migration_log before deleting
 * them (.agents/memory/retirement-migration-captures-admin-curated-rows.md),
 * leaves every other setting alone, drops the table, and a second run is a
 * no-op that captures nothing.
 *
 * The test database is built past 0138, so the table and rows are already
 * gone; the test recreates the state 0138 runs on (a minimal pre-0138 engines
 * table and two retired rows), as the Repl's dev database holds it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

import { createLegacyEnginesTable, dropLegacyEnginesTable, insertLegacyEngine } from "./helpers/legacyEnginesTable.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0138_ai_settings_in_code.sql"),
  "utf8",
);
const LOG = "0138_ai_settings_in_code";
const KEEP = "t_0138_unrelated_setting";

async function config(key: string): Promise<string | null> {
  const r = await db.execute(sql`SELECT value FROM admin_config WHERE key = ${key}`);
  return (r.rows[0] as { value: string } | undefined)?.value ?? null;
}

async function captures(): Promise<Array<{ admin_config: Array<Record<string, unknown>>; engines: Array<Record<string, unknown>> }>> {
  const r = await db.execute(sql`SELECT deleted_rows FROM feature_permissions_migration_log WHERE migration_name = ${LOG} ORDER BY id`);
  return (r.rows as Array<{ deleted_rows: never }>).map((x) => x.deleted_rows);
}

async function cleanup() {
  await dropLegacyEnginesTable();
  await db.execute(sql`DELETE FROM feature_permissions_migration_log WHERE migration_name = ${LOG}`);
  await db.execute(sql`DELETE FROM admin_config WHERE key IN (${KEEP}, 'fal_safety_tolerance_pulid', 'fact_visual_concepts_system')`);
}

const seedRow = (key: string, value: string) => db.execute(sql`
  INSERT INTO admin_config (key, value, data_type, label, description, is_public)
  VALUES (${key}, ${value}, 'string', ${key}, 'test', false)`);

describe("migration 0138: the stored AI settings and the engines table", () => {
  before(async () => {
    await cleanup();
    await createLegacyEnginesTable();
    await insertLegacyEngine("t-0138-engine", "image", "fal-ai/t-0138");
    await seedRow("fal_safety_tolerance_pulid", "3");
    await seedRow("fact_visual_concepts_system", "an admin's edited prompt");
    await seedRow(KEEP, "kept");
  });
  after(cleanup);

  it("captures the retired rows and every engine row, then deletes them and drops the table", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    const [log, ...extra] = await captures();
    assert.equal(extra.length, 0, "one log row");
    const byKey = new Map(log!.admin_config.map((r) => [r["key"], r["value"]]));
    assert.equal(byKey.get("fal_safety_tolerance_pulid"), "3", "an edited value is captured as it was");
    assert.equal(byKey.get("fact_visual_concepts_system"), "an admin's edited prompt");
    assert.ok(!byKey.has(KEEP), "an unrelated setting is not captured");
    assert.deepEqual(log!.engines.map((e) => [e["id"], e["endpoint_id"]]), [["t-0138-engine", "fal-ai/t-0138"]]);

    assert.equal(await config("fal_safety_tolerance_pulid"), null);
    assert.equal(await config("fact_visual_concepts_system"), null);
    assert.equal(await config(KEEP), "kept", "an unrelated setting survives");
    const t = await db.execute(sql`SELECT to_regclass('engines') AS t`);
    assert.equal((t.rows[0] as { t: string | null }).t, null, "the engines table is dropped");
  });

  it("a second run captures nothing and changes nothing", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    assert.equal((await captures()).length, 1, "no second log row");
    assert.equal(await config(KEEP), "kept");
  });
});
