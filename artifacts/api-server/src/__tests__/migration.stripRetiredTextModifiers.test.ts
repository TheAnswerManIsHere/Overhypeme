/**
 * Fixture test for migration 0080_strip_retired_text_modifiers.
 *
 * The migration scrubs the retired text/brand modifier catalog lines
 * (no_readable_text / avoid_readable_ui / avoid_real_logos) out of the
 * admin-configurable classifier prompt in admin_config.value / debug_value.
 * It seeds the fact_enrichment_system row with crafted values covering: a single
 * retired line present, all three present, admin edits preserved, NULL debug_value
 * preserved, and the independent debug_value scrub path — then asserts each is
 * cleaned and idempotent. The original row is saved and restored.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0080_strip_retired_text_modifiers.sql"),
  "utf8",
);

const KEY = "fact_enrichment_system";

let existed = false;
let savedValue = "";
let savedDebug: string | null = null;

before(async () => {
  const [row] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  if (row) {
    existed = true;
    savedValue = row.value;
    savedDebug = row.debugValue;
  } else {
    await db.insert(adminConfigTable).values({
      key: KEY,
      value: "placeholder",
      dataType: "string",
      label: "test",
    } as typeof adminConfigTable.$inferInsert);
  }
});

after(async () => {
  if (existed) {
    await db.update(adminConfigTable).set({ value: savedValue, debugValue: savedDebug }).where(eq(adminConfigTable.key, KEY));
  } else {
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  }
});

async function setRow(value: string, debugValue: string | null): Promise<void> {
  await db.update(adminConfigTable).set({ value, debugValue }).where(eq(adminConfigTable.key, KEY));
}

async function readRow(): Promise<{ value: string; debugValue: string | null }> {
  const [row] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  return { value: row.value, debugValue: row.debugValue };
}

describe("migration 0080 — strip retired text modifiers from the classifier prompt", () => {
  const cases: Array<{
    name: string;
    value: string;
    debugValue: string | null;
    expectValue: string;
    expectDebug: string | null;
  }> = [
    {
      name: "only no_readable_text present",
      value: "catalog:\n- no_readable_text\n- some_other\n",
      debugValue: null,
      expectValue: "catalog:\n- some_other\n",
      expectDebug: null,
    },
    {
      name: "only avoid_real_logos present",
      value: "catalog:\n- avoid_real_logos\n- keep\n",
      debugValue: null,
      expectValue: "catalog:\n- keep\n",
      expectDebug: null,
    },
    {
      name: "only avoid_readable_ui present",
      value: "catalog:\n- avoid_readable_ui\n- keep\n",
      debugValue: null,
      expectValue: "catalog:\n- keep\n",
      expectDebug: null,
    },
    {
      name: "all three present, admin edits around them preserved",
      value: "MY ADMIN EDIT\n- no_readable_text\n- avoid_real_logos\n- avoid_readable_ui\n- keep_this\n",
      debugValue: null,
      expectValue: "MY ADMIN EDIT\n- keep_this\n",
      expectDebug: null,
    },
    {
      name: "NULL debug_value is preserved while value is scrubbed",
      value: "- no_readable_text\n- keep\n",
      debugValue: null,
      expectValue: "- keep\n",
      expectDebug: null,
    },
    {
      name: "debug_value is scrubbed independently of value",
      value: "- keep_value\n",
      debugValue: "- no_readable_text\n- keep_debug\n",
      expectValue: "- keep_value\n",
      expectDebug: "- keep_debug\n",
    },
  ];

  it("scrubs every case correctly and is idempotent", async () => {
    for (const c of cases) {
      await setRow(c.value, c.debugValue);
      await db.execute(sql.raw(MIGRATION_SQL));
      let row = await readRow();
      assert.equal(row.value, c.expectValue, `${c.name}: value`);
      assert.equal(row.debugValue, c.expectDebug, `${c.name}: debug_value`);

      // Idempotent: a second run makes no further change.
      await db.execute(sql.raw(MIGRATION_SQL));
      row = await readRow();
      assert.equal(row.value, c.expectValue, `${c.name}: value (idempotent)`);
      assert.equal(row.debugValue, c.expectDebug, `${c.name}: debug_value (idempotent)`);
    }
  });
});
