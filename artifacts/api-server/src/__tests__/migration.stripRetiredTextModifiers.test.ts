/**
 * Fixture test for migration 0082_strip_retired_text_modifiers.
 *
 * The migration scrubs the retired text/brand modifier catalog lines
 * (no_readable_text / avoid_readable_ui / avoid_real_logos) out of the
 * admin-configurable classifier prompt in admin_config.value (and, while it
 * existed, debug_value — dropped by 0108, so only the value half is replayed
 * here). It seeds the fact_enrichment_system row with crafted values covering:
 * a single retired line present, all three present, and admin edits preserved —
 * then asserts each is cleaned and idempotent. The original row is saved and
 * restored.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

import { withoutDebugValueStatements } from "./helpers/withoutDebugValueStatements.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = withoutDebugValueStatements(readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0082_strip_retired_text_modifiers.sql"),
  "utf8",
));

const KEY = "fact_enrichment_system";

let existed = false;
let savedValue = "";

before(async () => {
  const [row] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  if (row) {
    existed = true;
    savedValue = row.value;
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
    await db.update(adminConfigTable).set({ value: savedValue }).where(eq(adminConfigTable.key, KEY));
  } else {
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  }
});

async function setRow(value: string): Promise<void> {
  await db.update(adminConfigTable).set({ value }).where(eq(adminConfigTable.key, KEY));
}

async function readRow(): Promise<{ value: string }> {
  const [row] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, KEY));
  return { value: row.value };
}

describe("migration 0080 — strip retired text modifiers from the classifier prompt", () => {
  const cases: Array<{
    name: string;
    value: string;
    expectValue: string;
  }> = [
    {
      name: "only no_readable_text present",
      value: "catalog:\n- no_readable_text\n- some_other\n",
      expectValue: "catalog:\n- some_other\n",
    },
    {
      name: "only avoid_real_logos present",
      value: "catalog:\n- avoid_real_logos\n- keep\n",
      expectValue: "catalog:\n- keep\n",
    },
    {
      name: "only avoid_readable_ui present",
      value: "catalog:\n- avoid_readable_ui\n- keep\n",
      expectValue: "catalog:\n- keep\n",
    },
    {
      name: "all three present, admin edits around them preserved",
      value: "MY ADMIN EDIT\n- no_readable_text\n- avoid_real_logos\n- avoid_readable_ui\n- keep_this\n",
      expectValue: "MY ADMIN EDIT\n- keep_this\n",
    },
  ];

  it("scrubs every case correctly and is idempotent", async () => {
    for (const c of cases) {
      await setRow(c.value);
      await db.execute(sql.raw(MIGRATION_SQL));
      let row = await readRow();
      assert.equal(row.value, c.expectValue, `${c.name}: value`);

      // Idempotent: a second run makes no further change.
      await db.execute(sql.raw(MIGRATION_SQL));
      row = await readRow();
      assert.equal(row.value, c.expectValue, `${c.name}: value (idempotent)`);
    }
  });
});
