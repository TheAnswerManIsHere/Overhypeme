// What fal actually charged for each comparison picture (David, 2026-11-11:
// "Please backfill all the generations with the actual costs."): read by fal
// request id, summed per request, never overwritten, and averaged per picture
// drawn on the results.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { comparisonCellsTable, comparisonPanelsTable, comparisonSetsTable, factsTable, usersTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { createComparisonSet } from "../lib/comparison/sets.js";
import { parseBillingEvents, syncBilledCosts, type BillingFetcher } from "../lib/comparison/billedCost.js";
import { getComparisonResults } from "../lib/comparison/judging.js";
import { VALID_ENRICHMENT } from "./helpers/stubPlanner.js";
import { testEngineRow } from "./helpers/testEngines.js";
import { clearEngineCaches } from "../lib/engineInterpreter.js";

const P = `t-cbc-${randomUUID().slice(0, 6)}`;
const engineIds: string[] = [];
let factId = 0;
const adminId = `${P}-admin`;
let cells: Array<{ id: number }> = [];
let setId = 0;

before(async () => {
  for (const src of ["flux-3", "flux-3-edit"]) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${P}-${def.imageMode}`;
    testEngineRow(def, id, P);
    engineIds.push(id);
  }
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
  const [fact] = await db.insert(factsTable).values({ text: `${P} {NAME} lifts a mountain`, isActive: false, enrichment: VALID_ENRICHMENT as never }).returning({ id: factsTable.id });
  factId = fact!.id;
  ({ setId } = await createComparisonSet({ label: `${P} set`, round: 1, factIds: [factId], scenarioKeys: ["generic_t2i", "i2i_male_default"], lookStyleIds: ["none"], engineFamilies: [P] }, adminId));
  const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
  cells = await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id)));
});

after(async () => {
  await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P}%`));
  await db.delete(factsTable).where(eq(factsTable.id, factId));
  clearEngineCaches();
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("reading fal's bills onto comparison cells", () => {
  it("fills an unbilled cell by request id, waits for one fal has not billed, and is idempotent", async () => {
    const [a, b] = cells;
    assert.ok(a && b);
    await db.update(comparisonCellsTable).set({ falRequestId: `${P}-req-a`, state: "rendered", submittedAt: new Date("2026-11-10T20:00:00Z") }).where(eq(comparisonCellsTable.id, a.id));
    await db.update(comparisonCellsTable).set({ falRequestId: `${P}-req-b`, state: "rendered" }).where(eq(comparisonCellsTable.id, b.id));
    const windows: string[][] = [];
    const fetcher: BillingFetcher = async (start, end) => {
      windows.push([start, end]);
      return parseBillingEvents({ billing_events: [
        { request_id: `${P}-req-a`, cost_total: 0.03 },
        { request_id: `${P}-req-a`, cost_total: 0.0105 },
        { request_id: `${P}-someone-else`, cost_total: 9 },
      ], next_cursor: null }).events;
    };
    const now = new Date("2026-11-11T12:00:00Z");

    assert.deepEqual(await syncBilledCosts(fetcher, { setIds: [setId], apply: false, now }), { waiting: 2, filled: 1, notYetBilled: 1 });
    const [dry] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, a.id));
    assert.equal(dry!.billedUsd, null, "a dry run writes nothing");
    assert.deepEqual(windows[0], ["2026-11-09T20:00:00.000Z", "2026-11-11T12:00:00.000Z"], "the window opens a day before the first request");

    assert.deepEqual(await syncBilledCosts(fetcher, { setIds: [setId], apply: true, now }), { waiting: 2, filled: 1, notYetBilled: 1 });
    const [filled] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, a.id));
    assert.equal(Number(filled!.billedUsd), 0.0405, "a request's billing events are summed");

    assert.deepEqual(await syncBilledCosts(fetcher, { setIds: [setId], apply: true, now }), { waiting: 1, filled: 0, notYetBilled: 1 }, "a billed cell is not read again");

    const results = await getComparisonResults([setId]);
    const row = Object.values(results!.ranking).flat().find((r) => r.engineId === filled!.engineId)!;
    assert.deepEqual([row.billedUsdPerImage, row.billedMinUsd, row.billedMaxUsd, row.billedTotalUsd, row.billed], [0.0405, 0.0405, 0.0405, 0.0405, 1]);
  });

  it("refuses a malformed answer rather than writing a wrong cost", () => {
    assert.throws(() => parseBillingEvents({ error: { type: "authorization_error" } }), /no billing_events/);
    assert.throws(() => parseBillingEvents({ billing_events: [{ request_id: "x", cost_total: "0.04" }] }), /malformed/);
    assert.throws(() => parseBillingEvents({ billing_events: [{ request_id: "x", cost_total: -1 }] }), /malformed/);
  });
});
