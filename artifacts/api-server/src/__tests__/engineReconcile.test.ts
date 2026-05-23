/**
 * Boot-time engine reconciliation tests.
 *
 * Confirms the two-tier strategy works:
 *   - Code-owned fields (paramSchema, allowed sets, label, etc.) are
 *     overwritten on every reconciliation.
 *   - Admin-tunable fields (isActive, isDefault, defaults, pricing) are
 *     preserved across reconciliations once first persisted.
 *   - Soft-deleted rows stay soft-deleted.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { enginesTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { reconcileEngines, ALL_ENGINES } from "../lib/engines";
import { clearEngineCaches } from "../lib/engineInterpreter";

const SEEDED_IDS = ALL_ENGINES.map((e) => e.id);

/** Snapshot the current engine rows. Used to restore state across tests. */
async function snapshot() {
  return db.select().from(enginesTable).where(inArray(enginesTable.id, SEEDED_IDS));
}

async function restore(rows: Awaited<ReturnType<typeof snapshot>>) {
  // Wipe everything we seeded then put the snapshot back.
  await db.delete(enginesTable).where(inArray(enginesTable.id, SEEDED_IDS));
  if (rows.length > 0) {
    // drizzle's .values() typing is strict; we insert via the row shape we
    // already pulled from the DB so the types line up.
    await db.insert(enginesTable).values(rows as never);
  }
  clearEngineCaches();
}

let baselineRows: Awaited<ReturnType<typeof snapshot>> = [];

before(async () => {
  baselineRows = await snapshot();
});

after(async () => {
  await restore(baselineRows);
});

beforeEach(async () => {
  await restore(baselineRows);
});

describe("reconcileEngines", () => {
  it("upserts every code-defined engine into the table", async () => {
    // Wipe so we hit the insert branch for every engine.
    await db.delete(enginesTable).where(inArray(enginesTable.id, SEEDED_IDS));

    const result = await reconcileEngines();

    assert.equal(result.inserted.length, ALL_ENGINES.length);
    assert.equal(result.updated.length, 0);
    assert.equal(result.preservedSoftDeleted.length, 0);

    const rows = await snapshot();
    assert.equal(rows.length, ALL_ENGINES.length);
  });

  it("preserves admin-edited isActive across reconciliations", async () => {
    // Toggle isActive on the default Veo Lite engine.
    await db
      .update(enginesTable)
      .set({ isActive: false })
      .where(eq(enginesTable.id, "veo-3.1-lite"));

    await reconcileEngines();

    const [row] = await db
      .select({ isActive: enginesTable.isActive })
      .from(enginesTable)
      .where(eq(enginesTable.id, "veo-3.1-lite"));
    assert.equal(row?.isActive, false, "admin edit to isActive should survive reconciliation");
  });

  it("preserves admin-edited defaultResolution across reconciliations", async () => {
    // Pretend an admin bumped Grok's default resolution to 720p.
    await db
      .update(enginesTable)
      .set({ defaultResolution: "720p" })
      .where(eq(enginesTable.id, "grok-imagine"));

    await reconcileEngines();

    const [row] = await db
      .select({ defaultResolution: enginesTable.defaultResolution })
      .from(enginesTable)
      .where(eq(enginesTable.id, "grok-imagine"));
    assert.equal(row?.defaultResolution, "720p");
  });

  it("overwrites paramSchema even when admin tunables are preserved", async () => {
    // Sabotage paramSchema directly (simulating drift from code).
    await db
      .update(enginesTable)
      .set({ paramSchema: { params: [{ name: "garbage", from: "garbage", type: "string" }] } })
      .where(eq(enginesTable.id, "veo-3.1-lite"));

    await reconcileEngines();

    const [row] = await db
      .select({ paramSchema: enginesTable.paramSchema })
      .from(enginesTable)
      .where(eq(enginesTable.id, "veo-3.1-lite"));
    const schema = row?.paramSchema as { params?: Array<{ name: string }> } | null;
    assert.ok(schema?.params, "paramSchema should be present after reconciliation");
    const names = schema.params.map((p) => p.name);
    assert.ok(names.includes("image_url"), "code paramSchema overwrote drifted DB version");
    assert.ok(!names.includes("garbage"), "drifted entry was removed");
    assert.ok(!names.includes("generate_audio"), "Veo Lite paramSchema must NOT include generate_audio");
  });

  it("preserves the deletedAt tombstone across reconciliations", async () => {
    const now = new Date();
    await db
      .update(enginesTable)
      .set({ deletedAt: now })
      .where(eq(enginesTable.id, "grok-imagine"));

    const result = await reconcileEngines();
    assert.ok(result.preservedSoftDeleted.includes("grok-imagine"));

    const [row] = await db
      .select({ deletedAt: enginesTable.deletedAt })
      .from(enginesTable)
      .where(eq(enginesTable.id, "grok-imagine"));
    assert.ok(row?.deletedAt instanceof Date);
  });

  it("still refreshes the paramSchema on a soft-deleted row", async () => {
    // Soft-delete + drift the paramSchema. Reconcile. Expect the schema to
    // come back to code while deletedAt stays set.
    await db
      .update(enginesTable)
      .set({
        deletedAt: new Date(),
        paramSchema: { params: [{ name: "stale", from: "stale", type: "string" }] },
      })
      .where(eq(enginesTable.id, "kling-v3-standard"));

    await reconcileEngines();

    const [row] = await db
      .select({
        paramSchema: enginesTable.paramSchema,
        deletedAt: enginesTable.deletedAt,
      })
      .from(enginesTable)
      .where(eq(enginesTable.id, "kling-v3-standard"));
    const schema = row?.paramSchema as { params?: Array<{ name: string }> } | null;
    const names = schema?.params?.map((p) => p.name) ?? [];
    // Kling v3 uses start_image_url (not image_url) — the rename is the
    // canary that the production schema was actually re-applied.
    assert.ok(names.includes("start_image_url"), "schema was refreshed on tombstoned row");
    assert.ok(row?.deletedAt != null, "tombstone preserved");
  });

  it("is idempotent — running twice changes nothing", async () => {
    await reconcileEngines();
    const before = await snapshot();

    await reconcileEngines();
    const after = await snapshot();

    assert.equal(before.length, after.length);
    for (const beforeRow of before) {
      const afterRow = after.find((r) => r.id === beforeRow.id);
      assert.ok(afterRow);
      // Everything except updatedAt should be byte-identical.
      assert.deepEqual(
        { ...beforeRow, updatedAt: null },
        { ...afterRow, updatedAt: null },
      );
    }
  });
});
