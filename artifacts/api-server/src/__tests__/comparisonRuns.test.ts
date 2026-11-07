// Launch Phase 8, increment 2b: the comparison's runs against the test
// database, with every paid call faked (plan PLAN_PHASE8_ENGINE_EVALUATION.md,
// *Settled Decisions*, "Spend is bounded before dispatch, by reservation").
// Seeds two engine families under a `t-cr-` prefix (GPT, token-billed; FLUX,
// flat), the default planner engine when absent, one enriched fact, and a set
// of two panels (generic_t2i and i2i_male_default, unstyled) — four cells.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  asyncJobsTable,
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonReservationsTable,
  comparisonRunsTable,
  comparisonSetsTable,
  enginesTable,
  factsTable,
  usersTable,
  type ComparisonCell,
} from "@workspace/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";

import adminComparisonRouter from "../routes/adminComparison.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { makeStubPlan, VALID_ENRICHMENT } from "./helpers/stubPlanner.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { codeDefinitionToRow } from "../lib/engines/reconcile.js";
import { DEFAULT_IMAGE_PROMPT_ENGINE_ID } from "../lib/imagePromptConfig.js";
import { __setPlanGeneratorForTest } from "../lib/imagePrompt/preview.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { createComparisonSet } from "../lib/comparison/sets.js";
import { __setComparisonFalForTest, type ComparisonFal } from "../lib/comparison/transport.js";
import {
  __allowComparisonDispatchInCiForTest,
  __setComparisonImageStoreForTest,
  CELL_POLL,
  COMPARISON_PREPARE_QUEUE,
  COMPARISON_RENDER_QUEUE,
  preparePanel,
  renderCell,
  rerunCell,
  retryCellStorage,
} from "../lib/comparison/runs.js";

const P = `t-cr-${randomUUID().slice(0, 6)}`;
const FAMILIES = { gpt: `${P}-gpt`, flux: `${P}-flux` };
const SOURCES: Array<[string, string]> = [
  [FAMILIES.gpt, "gpt-image-2-5"], [FAMILIES.gpt, "gpt-image-2-5-edit"],
  [FAMILIES.flux, "flux-3"], [FAMILIES.flux, "flux-3-edit"],
];
const engineIds: string[] = [];
let seededPlanner = false;
let adminId = "";
let factId = 0;

// Fakes: every submission, status and result, the reference upload and the store.
let submissions: Array<{ endpointId: string; input: Record<string, unknown> }> = [];
let statusScript: string[] = [];
let failStore = false;
let uploadedTypes: string[] = [];
const fakeFal: ComparisonFal = {
  async submit(endpointId, input) {
    submissions.push({ endpointId, input });
    return `req-${submissions.length}`;
  },
  async status() { return statusScript.shift() ?? "COMPLETED"; },
  async result(_e, requestId) { return { images: [{ url: `https://vendor.test/${requestId}.png` }] }; },
};

before(async () => {
  for (const [family, src] of SOURCES) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${family}-${def.imageMode}`;
    await db.insert(enginesTable).values({ ...codeDefinitionToRow(def), id, family, isDefault: false });
    engineIds.push(id);
  }
  const planner = ALL_ENGINES.find((e) => e.id === DEFAULT_IMAGE_PROMPT_ENGINE_ID)!;
  seededPlanner = (await db.insert(enginesTable).values(codeDefinitionToRow(planner)).onConflictDoNothing().returning({ id: enginesTable.id })).length > 0;
  adminId = `${P}-admin`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
  const [fact] = await db.insert(factsTable).values({ text: `${P} {NAME} lifts a mountain`, isActive: false, enrichment: VALID_ENRICHMENT as never }).returning({ id: factsTable.id });
  factId = fact!.id;

});

after(async () => {
  __allowComparisonDispatchInCiForTest(false);
  __setComparisonFalForTest(null);
  __setReferenceFalUploadForTest(null);
  __setComparisonImageStoreForTest(null);
  __setPlanGeneratorForTest(null);
  CELL_POLL.intervalMs = 3_000;
  await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.queue, [COMPARISON_PREPARE_QUEUE, COMPARISON_RENDER_QUEUE]));
  await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P}%`));
  await db.delete(factsTable).where(eq(factsTable.id, factId));
  await db.delete(enginesTable).where(inArray(enginesTable.id, seededPlanner ? [...engineIds, DEFAULT_IMAGE_PROMPT_ENGINE_ID] : engineIds));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

/**
 * Every fake is installed before each test, not once per file: the sharded
 * runner loads all test files into one process, and another file's cleanup
 * resets the shared planner seam between this file's hook and its tests.
 */
function installFakes(): void {
  __allowComparisonDispatchInCiForTest(true);
  __setComparisonFalForTest(fakeFal);
  __setReferenceFalUploadForTest(async (_bytes, contentType) => { uploadedTypes.push(contentType); return `https://fal.test/ref-${uploadedTypes.length}.jpg`; });
  __setComparisonImageStoreForTest(async (cell) => {
    if (failStore) throw new Error("bucket unavailable");
    return `/objects/comparison/cell-${cell.id}.png`;
  });
  __setPlanGeneratorForTest(async (input) => makeStubPlan(
    (input as { subjectRenderMode: string }).subjectRenderMode === "t2i_fallback" ? "t2i_fallback" : "human_identity_i2i",
    "A protagonist lifts a mountain.",
  ) as never);
  CELL_POLL.intervalMs = 0;
}

beforeEach(() => { submissions = []; statusScript = []; failStore = false; installFakes(); });

async function newSet(label: string): Promise<number> {
  const { setId } = await createComparisonSet({
    label: `${P} ${label}`, round: 1, factIds: [factId],
    scenarioKeys: ["generic_t2i", "i2i_male_default"], lookStyleIds: ["none"],
    engineFamilies: [FAMILIES.gpt, FAMILIES.flux],
  }, adminId);
  return setId;
}

const app = () => buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);

async function start(setId: number, kind: "prepare" | "render", weekRemainingUsd = 25) {
  return request(app()).post(`/api/admin/comparison/sets/${setId}/runs`).send({ kind, weekRemainingUsd });
}

/** Run every queued job of a run through its handler, as the worker would. */
async function drain(runId: number): Promise<void> {
  const jobs = await db.select().from(asyncJobsTable).where(inArray(asyncJobsTable.queue, [COMPARISON_PREPARE_QUEUE, COMPARISON_RENDER_QUEUE]));
  for (const job of jobs) {
    const payload = job.payload as { runId: number; panelId?: number; cellId?: number; reservationId: number };
    if (payload.runId !== runId) continue;
    if (job.queue === COMPARISON_PREPARE_QUEUE) await preparePanel(payload as never);
    else await renderCell(payload as never);
  }
}

/** Every string anywhere in a request body, so a URL is compared whole, never as a substring. */
function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

async function reservations(runId: number) {
  return db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.runId, runId));
}

async function cellsOf(setId: number): Promise<Array<ComparisonCell & { family: string }>> {
  const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
  const cells = await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id)));
  return cells.map((c) => ({ ...c, family: c.engineId.startsWith(FAMILIES.gpt) ? "gpt" : "flux" }));
}

describe("starting a comparison run", () => {
  it("never runs in CI without the test allowance", async () => {
    const setId = await newSet("ci");
    const previous = process.env["CI"];
    process.env["CI"] = "true";
    __allowComparisonDispatchInCiForTest(false);
    try {
      const res = await start(setId, "prepare");
      assert.equal(res.status, 409);
      assert.match(res.body.refusal, /never run in CI/);
      assert.equal((await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.setId, setId))).length, 0);
    } finally {
      __allowComparisonDispatchInCiForTest(true);
      if (previous === undefined) delete process.env["CI"]; else process.env["CI"] = previous;
    }
  });

  it("records a refusal with its figure and reserves nothing when the week cannot cover it", async () => {
    const setId = await newSet("week");
    const res = await start(setId, "prepare", 0.5);
    assert.equal(res.status, 409);
    assert.match(res.body.refusal, /above the \$0\.50 left this week/);
    assert.equal(res.body.run.state, "refused");
    assert.equal((await reservations(res.body.run.id)).length, 0);
    const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
    assert.ok(panels.every((p) => p.state === "pending"));
  });

  it("reserves each permitted call, marks it in flight and queues it at one attempt", async () => {
    const setId = await newSet("admit");
    const res = await start(setId, "prepare");
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const rows = await reservations(res.body.run.id);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.kind === "planner" && r.state === "reserved"));
    const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
    assert.ok(panels.every((p) => p.state === "preparing"));
    const jobs = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, COMPARISON_PREPARE_QUEUE));
    const mine = jobs.filter((j) => (j.payload as { runId: number }).runId === res.body.run.id);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((j) => j.maxAttempts === 1));
    // A second start finds nothing pending and spends nothing.
    const again = await start(setId, "prepare");
    assert.equal(again.status, 409);
    assert.equal(again.body.refusal, "nothing left to do");
  });
});

describe("a comparison run end to end, with fakes", () => {
  it("prepares the panels once, then renders each cell with exactly one submission", async () => {
    const setId = await newSet("e2e");
    const prep = await start(setId, "prepare");
    await drain(prep.body.run.id);
    const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
    assert.ok(panels.every((p) => p.state === "prepared"), JSON.stringify(panels.map((p) => [p.state, p.error])));
    const edit = panels.find((p) => p.imageMode === "i2i")!;
    assert.match(String(edit.referenceImageUrl), /^https:\/\/fal\.test\/ref-\d+\.jpg$/);
    assert.deepEqual(uploadedTypes.slice(-1), ["image/jpeg"]); // the resized reference
    assert.ok(panels.every((p) => p.compiledPrompt));
    assert.ok((await reservations(prep.body.run.id)).every((r) => r.state === "settled" && r.settledUsd === null));
    const [prepRun] = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.id, prep.body.run.id));
    assert.equal(prepRun!.state, "done");

    statusScript = ["IN_QUEUE", "IN_PROGRESS"]; // the first cell waits two polls
    const render = await start(setId, "render");
    assert.equal(render.status, 202, JSON.stringify(render.body));
    await drain(render.body.run.id);
    const cells = await cellsOf(setId);
    assert.ok(cells.every((c) => c.state === "rendered"), JSON.stringify(cells.map((c) => [c.state, c.error])));
    assert.equal(submissions.length, 4);
    assert.ok(cells.every((c) => c.falRequestId && c.imageObjectPath && c.vendorResultUrl));
    const editSubmission = submissions.find((s) => s.endpointId.includes("edit"));
    assert.ok(stringValues(editSubmission!.input).includes(edit.referenceImageUrl!), "the edit call carries the panel's resized reference");
    const settled = await reservations(render.body.run.id);
    for (const r of settled) {
      assert.equal(r.state, "settled");
      if (r.target.startsWith(FAMILIES.flux)) assert.equal(Number(r.settledUsd), 0.048); // flat: the billed price
      else assert.equal(r.settledUsd, null); // token-billed: not reported, the ledger records the bound
    }
  });

  it("keeps a failed call's reservation, and a resumed cell never resubmits", async () => {
    const setId = await newSet("fail");
    await drain((await start(setId, "prepare")).body.run.id);
    statusScript = ["FAILED"];
    const render = await start(setId, "render");
    const payloads = (await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, COMPARISON_RENDER_QUEUE)))
      .map((j) => j.payload as { runId: number; cellId: number; reservationId: number })
      .filter((p) => p.runId === render.body.run.id);
    await renderCell(payloads[0]!);
    const [failed] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, payloads[0]!.cellId));
    assert.equal(failed!.state, "failed");
    assert.match(String(failed!.error), /ended FAILED/);
    const [held] = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.id, payloads[0]!.reservationId));
    assert.equal(held!.state, "reserved", "a call that may have been billed keeps its reservation");

    // A cell whose submission is already recorded polls it rather than submitting again.
    await db.update(comparisonCellsTable).set({ falRequestId: "req-existing" }).where(eq(comparisonCellsTable.id, payloads[1]!.cellId));
    const before = submissions.length;
    await renderCell(payloads[1]!);
    assert.equal(submissions.length, before);
    const [resumed] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, payloads[1]!.cellId));
    assert.equal(resumed!.state, "rendered");
    assert.equal(resumed!.vendorResultUrl, "https://vendor.test/req-existing.png");
  });

  it("retries a storage failure without a second image, and allows one re-run of a render failure", async () => {
    const setId = await newSet("recover");
    await drain((await start(setId, "prepare")).body.run.id);
    failStore = true;
    await drain((await start(setId, "render")).body.run.id);
    let cells = await cellsOf(setId);
    assert.ok(cells.every((c) => c.state === "failed" && c.vendorResultUrl && !c.imageObjectPath));
    const target = cells[0]!;
    await assert.rejects(rerunCell(target.id), /retry its storage instead/);

    failStore = false;
    const before = submissions.length;
    const res = await request(app()).post(`/api/admin/comparison/cells/${target.id}/retry-storage`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.cell.state, "rendered");
    assert.equal(submissions.length, before, "a storage retry submits nothing");

    // A render failure (no vendor image) gets exactly one re-run.
    const other = cells[1]!;
    await db.update(comparisonCellsTable).set({ vendorResultUrl: null }).where(eq(comparisonCellsTable.id, other.id));
    const rerun = await rerunCell(other.id);
    assert.equal(rerun.state, "expected");
    assert.equal(rerun.rerunCount, 1);
    await db.update(comparisonCellsTable).set({ state: "failed" }).where(eq(comparisonCellsTable.id, other.id));
    await assert.rejects(rerunCell(other.id), /had its one re-run/);
    cells = await cellsOf(setId);
    assert.equal(cells.filter((c) => c.state === "rendered").length, 1);
  });

  it("releases the reservation of a cell refused before dispatch", async () => {
    const setId = await newSet("refuse");
    await drain((await start(setId, "prepare")).body.run.id);
    const render = await start(setId, "render");
    const [gptT2i] = engineIds;
    await db.update(enginesTable).set({ isActive: false }).where(eq(enginesTable.id, gptT2i!));
    try {
      const before = submissions.length;
      await drain(render.body.run.id);
      const rows = await reservations(render.body.run.id);
      const released = rows.filter((r) => r.target === gptT2i);
      assert.equal(released.length, 1);
      assert.equal(released[0]!.state, "released");
      assert.equal(submissions.length, before + 3);
      const [cell] = await db.select().from(comparisonCellsTable).where(and(eq(comparisonCellsTable.id, released[0]!.cellId!)));
      assert.match(String(cell!.error), /not rendered: it is inactive/);
    } finally {
      await db.update(enginesTable).set({ isActive: true }).where(eq(enginesTable.id, gptT2i!));
    }
  });
});
