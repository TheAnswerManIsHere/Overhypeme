// Backfilling round 1's render times from fal's request history (David,
// 2026-11-10: "Backfill them please."): fills only empty cells matched by fal
// request id, never overwrites a time the app recorded, and changes nothing
// on a second run.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "@workspace/db";
import { comparisonCellsTable, comparisonPanelsTable, comparisonSetsTable, enginesTable, factsTable, usersTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { codeDefinitionToRow } from "../lib/engines/reconcile.js";
import { createComparisonSet } from "../lib/comparison/sets.js";
import { backfillTimings, parseTimings } from "../lib/comparison/backfillTiming.js";
import { VALID_ENRICHMENT } from "./helpers/stubPlanner.js";

const P = `t-cbt-${randomUUID().slice(0, 6)}`;
const engineIds: string[] = [];
let factId = 0;
const adminId = `${P}-admin`;
let cells: Array<{ id: number }> = [];

before(async () => {
  for (const src of ["flux-3", "flux-3-edit"]) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${P}-${def.imageMode}`;
    await db.insert(enginesTable).values({ ...codeDefinitionToRow(def), id, family: P, isDefault: false });
    engineIds.push(id);
  }
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
  const [fact] = await db.insert(factsTable).values({ text: `${P} {NAME} lifts a mountain`, isActive: false, enrichment: VALID_ENRICHMENT as never }).returning({ id: factsTable.id });
  factId = fact!.id;
  const { setId } = await createComparisonSet({ label: `${P} set`, round: 1, factIds: [factId], scenarioKeys: ["generic_t2i"], lookStyleIds: ["none"], engineFamilies: [P] }, adminId);
  const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
  cells = await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id)));
});

after(async () => {
  await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P}%`));
  await db.delete(factsTable).where(eq(factsTable.id, factId));
  await db.delete(enginesTable).where(inArray(enginesTable.id, engineIds));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("backfilling render times from fal", () => {
  it("fills an untimed cell by request id, leaves a timed one, ignores unknown ids, and is idempotent", async () => {
    const [cell] = cells;
    assert.ok(cell);
    await db.update(comparisonCellsTable).set({ falRequestId: `${P}-req-a`, state: "rendered" }).where(eq(comparisonCellsTable.id, cell.id));
    const rows = parseTimings([
      { request_id: `${P}-req-a`, sent_at: "2026-11-10T20:00:00.000Z", ended_at: "2026-11-10T20:00:42.500Z" },
      { request_id: `${P}-unknown`, sent_at: "2026-11-10T20:00:00.000Z", ended_at: "2026-11-10T20:00:10.000Z" },
    ]);

    const dry = await backfillTimings(rows, false);
    assert.deepEqual(dry, { filled: 1, alreadyTimed: 0, unmatched: 1 });
    const [untouched] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, cell.id));
    assert.equal(untouched!.submittedAt, null, "a dry run writes nothing");

    assert.deepEqual(await backfillTimings(rows, true), { filled: 1, alreadyTimed: 0, unmatched: 1 });
    const [filled] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, cell.id));
    assert.equal(filled!.submittedAt!.toISOString(), "2026-11-10T20:00:00.000Z");
    assert.equal(filled!.completedAt!.toISOString(), "2026-11-10T20:00:42.500Z");

    assert.deepEqual(await backfillTimings(rows, true), { filled: 0, alreadyTimed: 1, unmatched: 1 }, "a second run changes nothing");
  });

  it("refuses a malformed row rather than writing a wrong time", () => {
    assert.throws(() => parseTimings([{ request_id: "x", sent_at: "2026-11-10T20:00:10Z", ended_at: "2026-11-10T20:00:00Z" }]), /malformed/);
    assert.throws(() => parseTimings({}), /JSON array/);
  });

  it("the shipped round 1 file parses: 85 distinct requests", () => {
    const rows = parseTimings(JSON.parse(readFileSync(new URL("../../scripts/data/comparison-round1-fal-timing.json", import.meta.url), "utf8")));
    assert.equal(rows.length, 85);
    assert.equal(new Set(rows.map((r) => r.request_id)).size, 85);
  });
});
