// Launch Phase 8, increments 2b and 3: the comparison's runs against the test
// database, with every paid call faked. Pricing does not gate a run (David,
// 2026-11-07, decisions.md); what is tested is that each paid call happens
// once and is recorded.
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
  reprepareFailedPanel,
  rerunCell,
  retryCellStorage,
} from "../lib/comparison/runs.js";
import { llmMaxRetriesInScope } from "../lib/utilityLLM.js";

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
  async status(_endpointId, requestId) {
    if (failNextGptEdit && isGptEditRequest(requestId)) { failNextGptEdit = false; return "FAILED"; }
    return statusScript.shift() ?? "COMPLETED";
  },
  async result(_e, requestId) { return { images: [{ url: `https://vendor.test/${requestId}.png` }] }; },
};
/** When set, the next status read of a GPT edit request reports FAILED (once). */
let failNextGptEdit = false;
const submissionOf = (requestId: string) => submissions[Number(requestId.split("-")[1]) - 1];
const isGptEditRequest = (requestId: string) => {
  const s = submissionOf(requestId);
  return !!s && s.endpointId.includes("gpt") && s.endpointId.includes("edit");
};
/** The retry count the planner call ran under, per preparation. */
let plannerRetries: Array<number | undefined> = [];

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
  __setPlanGeneratorForTest(async (input) => {
    plannerRetries.push(llmMaxRetriesInScope());
    return makeStubPlan(
      (input as { subjectRenderMode: string }).subjectRenderMode === "t2i_fallback" ? "t2i_fallback" : "human_identity_i2i",
      "A protagonist lifts a mountain.",
    ) as never;
  });
  CELL_POLL.intervalMs = 0;
}

beforeEach(() => { submissions = []; statusScript = []; failStore = false; failNextGptEdit = false; plannerRetries = []; installFakes(); });

async function newSet(label: string, imageSize?: "comparison" | "final"): Promise<number> {
  const { setId } = await createComparisonSet({
    label: `${P} ${label}`, round: 1, factIds: [factId],
    scenarioKeys: ["generic_t2i", "i2i_male_default"], lookStyleIds: ["none"],
    engineFamilies: [FAMILIES.gpt, FAMILIES.flux],
    ...(imageSize ? { imageSize } : {}),
  }, adminId);
  return setId;
}

const app = () => buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);

async function start(setId: number, kind: "prepare" | "render") {
  return request(app()).post(`/api/admin/comparison/sets/${setId}/runs`).send({ kind });
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

  it("asks for no allowance or week figure, and refuses the old budget fields", async () => {
    const setId = await newSet("nobudget");
    const res = await request(app()).post(`/api/admin/comparison/sets/${setId}/runs`).send({ kind: "prepare", weekRemainingUsd: 0.5 });
    assert.equal(res.status, 400, "the budget fields are gone from the request");
    assert.equal((await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.setId, setId))).length, 0);
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

/** The render jobs a run queued, as the worker would receive them. */
async function renderPayloads(runId: number) {
  return (await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, COMPARISON_RENDER_QUEUE)))
    .map((j) => j.payload as { runId: number; cellId: number; reservationId: number })
    .filter((p) => p.runId === runId);
}


describe("a comparison run end to end, with fakes", () => {
  it("prepares the panels once, without SDK retries, and settles each planner call at its bound", async () => {
    const setId = await newSet("e2e");
    const prep = await start(setId, "prepare");
    await drain(prep.body.run.id);
    const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
    assert.ok(panels.every((p) => p.state === "prepared"), JSON.stringify(panels.map((p) => [p.state, p.error])));
    assert.deepEqual(plannerRetries, [0, 0], "every planner call runs with the SDK's retries off");
    // What a second-edition panel is judged against is frozen with it (plan PLAN_PROMPT_TUNER.md, B).
    assert.ok(panels.every((p) => typeof p.frozenFactText === "string" && p.frozenFactText.length > 0 && !p.frozenFactText.includes("{")), JSON.stringify(panels.map((p) => p.frozenFactText)));
    const edit = panels.find((p) => p.imageMode === "i2i")!;
    assert.match(String(edit.referenceImageUrl), /^https:\/\/fal\.test\/ref-\d+\.jpg$/);
    assert.deepEqual(uploadedTypes.slice(-1), ["image/jpeg"]); // the resized reference
    for (const r of await reservations(prep.body.run.id)) {
      assert.equal(r.state, "settled");
      assert.equal(r.settledUsd, r.boundUsd, "OpenAI reports no per-request bill: the bound is recorded");
    }
    const [prepRun] = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.id, prep.body.run.id));
    assert.equal(prepRun!.state, "done");
  });

  it("freezes the fact's approved gag, rendered for the panel's subject, so a later edit changes nothing", async () => {
    const { EMPTY_VISUAL_STRATEGY_OVERRIDE } = await import("@workspace/api-zod");
    const withGag = { ...VALID_ENRICHMENT, visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "{NAME} hoists a mountain overhead like a barbell." } };
    await db.update(factsTable).set({ enrichment: withGag as never }).where(eq(factsTable.id, factId));
    try {
      const setId = await newSet("gag");
      await drain((await start(setId, "prepare")).body.run.id);
      await db.update(factsTable).set({ enrichment: VALID_ENRICHMENT as never }).where(eq(factsTable.id, factId));
      const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
      assert.ok(panels.length > 0 && panels.every((p) => p.state === "prepared"), JSON.stringify(panels.map((p) => [p.state, p.error])));
      for (const p of panels) {
        assert.match(String(p.frozenGag), /hoists a mountain overhead like a barbell\./);
        assert.doesNotMatch(String(p.frozenGag), /\{NAME\}/, "rendered for the panel's subject");
      }
    } finally {
      await db.update(factsTable).set({ enrichment: VALID_ENRICHMENT as never }).where(eq(factsTable.id, factId));
    }
  });

  it("renders every cell in one run, one submission each, each recorded at its bound with no bill read", async () => {
    const setId = await newSet("all");
    await drain((await start(setId, "prepare")).body.run.id);
    statusScript = ["IN_QUEUE", "IN_PROGRESS"]; // the first cell waits two polls

    const render = await start(setId, "render");
    assert.equal(render.status, 202, JSON.stringify(render.body));
    const admitted = await renderPayloads(render.body.run.id);
    assert.equal(admitted.length, 4, "both families, both modes: no first-edit gate");
    const [run] = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.id, render.body.run.id));
    assert.equal(run!.allowanceUsd, null, "no allowance is checked, so none is recorded");
    assert.equal(run!.weekRemainingUsd, null);

    await drain(render.body.run.id);
    const cells = await cellsOf(setId);
    assert.ok(cells.every((c) => c.state === "rendered" && c.falRequestId && c.imageObjectPath), JSON.stringify(cells.map((c) => [c.state, c.error])));
    // Render time (David, 2026-11-10): sent, then returned, on every rendered cell.
    assert.ok(cells.every((c) => c.submittedAt && c.completedAt && c.completedAt.getTime() >= c.submittedAt.getTime()), "each rendered cell is timed");
    assert.equal(submissions.length, 4, "exactly one submission per cell");
    for (const r of await reservations(render.body.run.id)) {
      assert.equal(r.state, "settled");
      assert.equal(r.settledUsd, r.boundUsd, "recorded at the most it could have cost");
      assert.ok(r.falRequestId, "each record carries its own fal request id");
    }
    const editSubmission = submissions.find((x) => x.endpointId.includes("edit"));
    const editPanel = (await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId))).find((p) => p.imageMode === "i2i")!;
    assert.ok(stringValues(editSubmission!.input).includes(editPanel.referenceImageUrl!), "the edit call carries the panel's resized reference");
    const again = await start(setId, "render");
    assert.equal(again.status, 409);
    assert.equal(again.body.refusal, "nothing left to do");
  });

  it("draws a member-size set's pictures at a member's size, and an ordinary set's at the comparison size", async () => {
    // David, 2026-11-11: "let's render images at the same resolution that users get so we get accurate pricing".
    const sizesOf = async (setId: number) => {
      await drain((await start(setId, "prepare")).body.run.id);
      await drain((await start(setId, "render")).body.run.id);
      const cells = await cellsOf(setId);
      assert.ok(cells.every((c) => c.state === "rendered"), JSON.stringify(cells.map((c) => [c.state, c.error])));
      return cells.map((c) => c.requestSettings as { purpose: string; megapixels: number });
    };
    const member = await sizesOf(await newSet("member size", "final"));
    assert.ok(member.every((r) => r.purpose === "final" && r.megapixels >= 3), JSON.stringify(member));
    const ordinary = await sizesOf(await newSet("comparison size"));
    assert.ok(ordinary.every((r) => r.purpose === "comparison" && r.megapixels < 2), JSON.stringify(ordinary));
  });

  it("keeps a failed call's reservation, and a resumed cell never resubmits", async () => {
    const setId = await newSet("fail");
    await drain((await start(setId, "prepare")).body.run.id);
    statusScript = ["FAILED"];
    const render = await start(setId, "render");
    const payloads = await renderPayloads(render.body.run.id);
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

  it("never repeats a paid call whose outcome a restart left unknown", async () => {
    const setId = await newSet("ambiguous");
    const prep = await start(setId, "prepare");
    const prepJobs = (await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, COMPARISON_PREPARE_QUEUE)))
      .map((j) => j.payload as { runId: number; panelId: number; reservationId: number })
      .filter((p) => p.runId === prep.body.run.id);
    // A restart after the planner call began.
    await db.update(comparisonPanelsTable).set({ state: "planning" }).where(eq(comparisonPanelsTable.id, prepJobs[0]!.panelId));
    await preparePanel(prepJobs[0]!);
    assert.deepEqual(plannerRetries, [], "no planner call was made");
    const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, prepJobs[0]!.panelId));
    assert.equal(panel!.state, "failed");
    assert.match(String(panel!.error), /interrupted during the planner call/);
    const [panelHeld] = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.id, prepJobs[0]!.reservationId));
    assert.equal(panelHeld!.state, "reserved");
    // A failed panel can be prepared again, through the next run's admission.
    const again = await reprepareFailedPanel(panel!.id);
    assert.equal(again.state, "pending");
    await assert.rejects(reprepareFailedPanel(panel!.id), /only a failed panel/);
    await preparePanel(prepJobs[1]!);
    await drain((await start(setId, "prepare")).body.run.id);

    // A restart after the submission marker was written and before the request id was.
    const render = await start(setId, "render");
    const [job] = await renderPayloads(render.body.run.id);
    await db.update(comparisonCellsTable).set({ requestSettings: { sizeParams: {} } }).where(eq(comparisonCellsTable.id, job!.cellId));
    const before = submissions.length;
    await renderCell(job!);
    assert.equal(submissions.length, before, "no second submission");
    const [cell] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, job!.cellId));
    assert.equal(cell!.state, "failed");
    assert.match(String(cell!.error), /interrupted during submission/);
    const [cellHeld] = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.id, job!.reservationId));
    assert.equal(cellHeld!.state, "reserved");
  });

  it("retries a storage failure without a second image, and allows one re-run of a render failure", async () => {
    const setId = await newSet("recover");
    await drain((await start(setId, "prepare")).body.run.id);
    failStore = true;
    await drain((await start(setId, "render")).body.run.id);
    let cells = (await cellsOf(setId)).filter((c) => c.vendorResultUrl);
    assert.equal(cells.length, 4);
    assert.ok(cells.every((c) => c.state === "failed" && !c.imageObjectPath));
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
    assert.equal(rerun.submittedAt, null, "a re-run starts its own clock");
    assert.equal(rerun.completedAt, null);
    assert.equal(rerun.rerunCount, 1);
    await db.update(comparisonCellsTable).set({ state: "failed" }).where(eq(comparisonCellsTable.id, other.id));
    await assert.rejects(rerunCell(other.id), /had its one re-run/);
    cells = await cellsOf(setId);
    assert.equal(cells.filter((c) => c.state === "rendered").length, 1);
  });

  it("gives a re-run its own record, and the failed first call keeps its own", async () => {
    const setId = await newSet("rebind");
    await drain((await start(setId, "prepare")).body.run.id);
    failNextGptEdit = true;
    const first = await start(setId, "render");
    await drain(first.body.run.id);
    const firstEdit = submissions.findIndex((s) => s.endpointId.includes("gpt") && s.endpointId.includes("edit"));
    const reqA = `req-${firstEdit + 1}`;
    const [r1] = (await reservations(first.body.run.id)).filter((r) => r.falRequestId === reqA);
    assert.ok(r1, "the record carries its own request id");
    assert.equal(r1!.state, "reserved", "a call that failed after submission stays held: it may have been billed");
    const failedCell = (await cellsOf(setId)).find((c) => c.id === r1!.cellId)!;
    assert.equal(failedCell.state, "failed");

    await rerunCell(failedCell.id);
    const second = await start(setId, "render");
    assert.equal(second.status, 202, JSON.stringify(second.body));
    assert.deepEqual((await renderPayloads(second.body.run.id)).map((p) => p.cellId), [failedCell.id]);
    await drain(second.body.run.id);
    const [r2] = await reservations(second.body.run.id);
    assert.notEqual(r2!.falRequestId, reqA);
    assert.equal(r2!.state, "settled");
    const [r1After] = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.id, r1!.id));
    assert.equal(r1After!.state, "reserved", "the re-run never rewrites the first call's record");
  });

  it("releases the reservation of a cell refused before dispatch", async () => {
    const setId = await newSet("refuse");
    await drain((await start(setId, "prepare")).body.run.id);
    const render = await start(setId, "render");
    const fluxT2i = engineIds[2]!;
    await db.update(enginesTable).set({ isActive: false }).where(eq(enginesTable.id, fluxT2i));
    try {
      const before = submissions.length;
      await drain(render.body.run.id);
      const rows = await reservations(render.body.run.id);
      const released = rows.filter((r) => r.target === fluxT2i);
      assert.equal(released.length, 1);
      assert.equal(released[0]!.state, "released");
      assert.equal(submissions.length, before + 3);
      const [cell] = await db.select().from(comparisonCellsTable).where(and(eq(comparisonCellsTable.id, released[0]!.cellId!)));
      assert.match(String(cell!.error), /not rendered: it is inactive/);
    } finally {
      await db.update(enginesTable).set({ isActive: true }).where(eq(enginesTable.id, fluxT2i));
    }
  });
});

// ─── The prompt tuner: comparing prompt wording on one engine (PLAN_PROMPT_TUNER.md, B) ───

describe("a prompt comparison", () => {
  it("draws one shared scene with each version's wording on one engine, records each picture's exact prompt, and reveals the versions in the results", async () => {
    const { promptRecipeVersionsTable, promptRecipePromotionsTable } = await import("@workspace/db/schema");
    const [v] = await db.insert(promptRecipeVersionsTable).values({
      engineFamily: FAMILIES.gpt, number: 1, note: "shorter identity",
      pieces: { "identity.person": "Use the photo as the person's face, exactly." },
    }).returning({ id: promptRecipeVersionsTable.id });
    try {
      const refused = await createComparisonSet({
        label: `${P} prompt-bad`, round: 1, factIds: [factId], scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none"],
        engineFamilies: [FAMILIES.flux], kind: "prompt", recipeVersionIds: [null, v!.id],
      }, adminId).then(() => null, (e: Error) => e);
      assert.match(String(refused?.message), /belongs to/, "a version of another family is refused");

      const { setId, cells } = await createComparisonSet({
        label: `${P} prompt`, round: 1, factIds: [factId], scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none"],
        engineFamilies: [FAMILIES.gpt], kind: "prompt", recipeVersionIds: [null, v!.id],
      }, adminId);
      assert.equal(cells, 2, "one cell per version on the family's one edit engine");
      const plannerCalls = plannerRetries.length;
      await drain((await start(setId, "prepare")).body.run.id);
      assert.equal(plannerRetries.length - plannerCalls, 1, "the scene is written once for the panel");
      const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
      assert.ok(panel!.compileArgs, "the scene is frozen with the panel");
      const sent = submissions.length;
      await drain((await start(setId, "render")).body.run.id);
      assert.equal(submissions.length - sent, 2);
      const drawn = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panel!.id));
      const baseline = drawn.find((c) => c.recipeVersionId == null)!;
      const tuned = drawn.find((c) => c.recipeVersionId === v!.id)!;
      assert.match(String(tuned.promptText), /IDENTITY & REFERENCE: Use the photo as the person's face, exactly\./);
      assert.doesNotMatch(String(baseline.promptText), /face, exactly/);
      assert.equal(String(baseline.promptText).replace(/IDENTITY & REFERENCE: .*? SUBJECT/, ""), String(tuned.promptText).replace(/IDENTITY & REFERENCE: .*? SUBJECT/, ""), "only the wording differs");
      assert.ok(submissions.slice(sent).some((s) => String(s.input["prompt"]).includes("face, exactly")), "the tuned prompt is what was sent");

      const { getJudgedResults } = await import("../lib/comparison/judging.js");
      const results = await getJudgedResults([setId]);
      assert.equal(results!.kind, "prompt");
      assert.equal(results!.family, FAMILIES.gpt);
      assert.deepEqual(results!.rows.i2i!.map((r) => r.recipeLabel).sort(), ["Baseline", "Version 1"]);
      assert.ok(results!.byLook["none"], "the same rows within each look");
      assert.equal(results!.pictures.length, 2);
      assert.ok(results!.pictures.every((p) => p.promptText), "every picture is revealed with its exact prompt");
    } finally {
      await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P} prompt%`));
      await db.delete(promptRecipePromotionsTable).where(eq(promptRecipePromotionsTable.engineFamily, FAMILIES.gpt));
      await db.delete(promptRecipeVersionsTable).where(eq(promptRecipeVersionsTable.id, v!.id));
    }
  });

  it("an engine set draws each family with its live wording, frozen when the set is made", async () => {
    const { promptRecipeVersionsTable, promptRecipePromotionsTable } = await import("@workspace/db/schema");
    const [v] = await db.insert(promptRecipeVersionsTable).values({ engineFamily: FAMILIES.gpt, number: 2, note: "live", pieces: {} }).returning({ id: promptRecipeVersionsTable.id });
    await db.insert(promptRecipePromotionsTable).values({ engineFamily: FAMILIES.gpt, versionId: v!.id });
    try {
      const setId = await newSet("live-wording");
      const panels = await db.select({ id: comparisonPanelsTable.id }).from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
      const cells = await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id)));
      for (const c of cells) assert.equal(c.recipeVersionId, c.engineId.startsWith(FAMILIES.gpt) ? v!.id : null, c.engineId);
    } finally {
      await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P} live-wording%`));
      await db.delete(promptRecipePromotionsTable).where(eq(promptRecipePromotionsTable.engineFamily, FAMILIES.gpt));
      await db.delete(promptRecipeVersionsTable).where(eq(promptRecipeVersionsTable.id, v!.id));
    }
  });
});
