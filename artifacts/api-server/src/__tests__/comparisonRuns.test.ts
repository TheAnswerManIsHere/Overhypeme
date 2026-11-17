// Launch Phase 8, increments 2b and 3: the comparison's runs against the test
// database, with every paid call faked. Pricing does not gate a run (David,
// 2026-11-07, decisions.md); what is tested is that each paid call happens
// once and is recorded. Preparation makes no paid call since the planner was
// removed (plan PLAN_GAG_DIRECT_RENDER.md, D): it compiles the panel's gag.
// Seeds two engine families under a `t-cr-` prefix (GPT, token-billed; FLUX,
// flat), registered as code definitions, one enriched fact with one gag, and a
// set of two panels (i2i_female_default and i2i_male_default, unstyled) — four cells.
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
  factGagsTable,
  factsTable,
  usersTable,
  type ComparisonCell,
} from "@workspace/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";

import adminComparisonRouter from "../routes/adminComparison.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { VALID_ENRICHMENT } from "./helpers/validEnrichment.js";
import { withCast } from "./helpers/gagCast.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
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
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, PATH_COMPARISON_RETIRED_MESSAGE } from "@workspace/api-zod";
import { testEngineRow } from "./helpers/testEngines.js";
import { clearTestEngineDefinitions } from "../lib/engineInterpreter.js";

const P = `t-cr-${randomUUID().slice(0, 6)}`;
const FAMILIES = { gpt: `${P}-gpt`, flux: `${P}-flux` };
const SOURCES: Array<[string, string]> = [
  [FAMILIES.gpt, "gpt-image-2-5"], [FAMILIES.gpt, "gpt-image-2-5-edit"],
  [FAMILIES.flux, "flux-3"], [FAMILIES.flux, "flux-3-edit"],
];
const engineIds: string[] = [];
let adminId = "";
let factId = 0;
let baseGagId = 0;
/** The fact's one gag (slot 1, a pending version): what every panel without a chosen gag draws. */
const BASE_GAG = withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "{NAME} hoists a mountain overhead like a barbell." });

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

// One wrapper scopes the file-level hooks to this file: with test isolation off,
// a root-level beforeEach would install this file's fakes for every other file
// in the same shard.
describe("comparison runs", () => {
before(async () => {
  for (const [family, src] of SOURCES) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${family}-${def.imageMode}`;
    testEngineRow(def, id, family);
    engineIds.push(id);
  }
  adminId = `${P}-admin`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
  const [fact] = await db.insert(factsTable).values({ text: `${P} {NAME} lifts a mountain`, isActive: false, enrichment: VALID_ENRICHMENT as never }).returning({ id: factsTable.id });
  factId = fact!.id;
  const [gag] = await db.insert(factGagsTable).values({ factId, slot: 1, pendingContent: BASE_GAG as never }).returning({ id: factGagsTable.id });
  baseGagId = gag!.id;
});

after(async () => {
  __allowComparisonDispatchInCiForTest(false);
  __setComparisonFalForTest(null);
  __setReferenceFalUploadForTest(null);
  __setComparisonImageStoreForTest(null);
  CELL_POLL.intervalMs = 3_000;
  await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.queue, [COMPARISON_PREPARE_QUEUE, COMPARISON_RENDER_QUEUE]));
  await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P}%`));
  await db.delete(factGagsTable).where(eq(factGagsTable.factId, factId));
  await db.delete(factsTable).where(eq(factsTable.id, factId));
  clearTestEngineDefinitions();
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

/**
 * Every fake is installed before each test, not once per file: the sharded
 * runner loads all test files into one process, and another file's cleanup
 * resets a shared seam between this file's hook and its tests.
 */
function installFakes(): void {
  __allowComparisonDispatchInCiForTest(true);
  __setComparisonFalForTest(fakeFal);
  __setReferenceFalUploadForTest(async (_bytes, contentType) => { uploadedTypes.push(contentType); return `https://fal.test/ref-${uploadedTypes.length}.jpg`; });
  __setComparisonImageStoreForTest(async (cell) => {
    if (failStore) throw new Error("bucket unavailable");
    return `/objects/comparison/cell-${cell.id}.png`;
  });
  CELL_POLL.intervalMs = 0;
}

beforeEach(() => { submissions = []; statusScript = []; failStore = false; failNextGptEdit = false; installFakes(); });

async function newSet(label: string, imageSize?: "comparison" | "final"): Promise<number> {
  const { setId } = await createComparisonSet({
    label: `${P} ${label}`, round: 1, factIds: [factId],
    scenarioKeys: ["i2i_female_default", "i2i_male_default"], lookStyleIds: ["none"],
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
    assert.ok(rows.every((r) => Number(r.boundUsd) === 0), "a preparation makes no paid call, so reserves nothing");
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
  it("prepares the panels with no paid call: each compiles the fact's gag directly and releases its $0 reservation", async () => {
    const setId = await newSet("e2e");
    const prep = await start(setId, "prepare");
    await drain(prep.body.run.id);
    const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
    assert.ok(panels.every((p) => p.state === "prepared"), JSON.stringify(panels.map((p) => [p.state, p.error])));
    for (const p of panels) {
      assert.ok((p.compileArgs as { direct?: unknown }).direct, "the gag is frozen for each cell to compile");
      assert.deepEqual(p.gagCast, { cast: BASE_GAG.cast }, "the gag's stored cast, as it reached the prompt");
      assert.equal(p.visualPlan ?? null, null, "no plan is made");
      assert.equal(p.gagId, null, "an engine set with no gag chosen draws the fact's default gag");
    }
    // What a second-edition panel is judged against is frozen with it (plan PLAN_PROMPT_TUNER.md, B).
    assert.ok(panels.every((p) => typeof p.frozenFactText === "string" && p.frozenFactText.length > 0 && !p.frozenFactText.includes("{")), JSON.stringify(panels.map((p) => p.frozenFactText)));
    const edit = panels.find((p) => p.imageMode === "i2i")!;
    assert.match(String(edit.referenceImageUrl), /^https:\/\/fal\.test\/ref-\d+\.jpg$/);
    // Each fixed photo names its own subject in everything the panel freezes:
    // the wife's photo renders as Raena Franklin, she/her; David's as David.
    for (const [scenario, name, pronouns] of [["i2i_female_default", "Raena Franklin", "she/her"], ["i2i_male_default", "David Franklin", "he/him"]] as const) {
      const panel = panels.find((p) => p.scenarioKey === scenario)!;
      assert.match(String(panel.frozenFactText), new RegExp(name), `${scenario}: the frozen fact text`);
      const subject = (panel.compileArgs as { direct: { renderedSubject: { name: string; pronouns: string } } }).direct.renderedSubject;
      assert.deepEqual(subject, { name, pronouns }, `${scenario}: the subject every cell compiles with`);
    }
    assert.deepEqual(uploadedTypes.slice(-1), ["image/jpeg"]); // the resized reference
    for (const r of await reservations(prep.body.run.id)) {
      assert.equal(r.state, "released", "nothing was spent");
      assert.equal(Number(r.boundUsd), 0);
    }
    const [prepRun] = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.id, prep.body.run.id));
    assert.equal(prepRun!.state, "done");
  });

  it("freezes the fact's approved gag, rendered for the panel's subject, so a later edit changes nothing", async () => {
    try {
      const setId = await newSet("gag");
      await drain((await start(setId, "prepare")).body.run.id);
      await db.update(factGagsTable).set({ pendingContent: withCast({ ...BASE_GAG, coreSceneOverride: "{NAME} does something else." }) as never }).where(eq(factGagsTable.id, baseGagId));
      const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
      assert.ok(panels.length > 0 && panels.every((p) => p.state === "prepared"), JSON.stringify(panels.map((p) => [p.state, p.error])));
      for (const p of panels) {
        assert.match(String(p.frozenGag), /hoists a mountain overhead like a barbell\./);
        assert.doesNotMatch(String(p.frozenGag), /\{NAME\}/, "rendered for the panel's subject");
      }
    } finally {
      await db.update(factGagsTable).set({ pendingContent: BASE_GAG as never }).where(eq(factGagsTable.id, baseGagId));
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

  it("never repeats a paid call whose outcome a restart left unknown (a panel left mid-planner-call before the switch, and a submission)", async () => {
    const setId = await newSet("ambiguous");
    const prep = await start(setId, "prepare");
    const prepJobs = (await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.queue, COMPARISON_PREPARE_QUEUE)))
      .map((j) => j.payload as { runId: number; panelId: number; reservationId: number })
      .filter((p) => p.runId === prep.body.run.id);
    // A restart after the planner call began.
    await db.update(comparisonPanelsTable).set({ state: "planning" }).where(eq(comparisonPanelsTable.id, prepJobs[0]!.panelId));
    await preparePanel(prepJobs[0]!);
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
    const fluxEdit = engineIds[3]!;
    const fluxSource = ALL_ENGINES.find((e) => e.id === "flux-3-edit")!;
    const fluxFamily = FAMILIES.flux;
    // Engines live only in code: re-register the test clone as inactive.
    testEngineRow(fluxSource, fluxEdit, fluxFamily, { isActive: false });
    try {
      const before = submissions.length;
      await drain(render.body.run.id);
      const rows = await reservations(render.body.run.id);
      const released = rows.filter((r) => r.target === fluxEdit);
      assert.equal(released.length, 2, "both photo panels' FLUX cells");
      assert.ok(released.every((r) => r.state === "released"));
      assert.equal(submissions.length, before + 2);
      const [cell] = await db.select().from(comparisonCellsTable).where(and(eq(comparisonCellsTable.id, released[0]!.cellId!)));
      assert.match(String(cell!.error), /not rendered: it is inactive/);
    } finally {
      testEngineRow(fluxSource, fluxEdit, fluxFamily);
    }
  });

  // A cell prepared for the retired render planner can no longer be drawn
  // (PLAN_GAG_DIRECT_RENDER.md, D). It must end as a failed cell with its
  // reservation released, never throw out of a job that runs once and leave
  // the evaluation in flight (Codex, PR #1022 round 1).
  it("fails a cell prepared for the retired planner, releases its reservation and finishes the run; an already-submitted one still polls", async () => {
    const setId = await newSet("retired-planner");
    await drain((await start(setId, "prepare")).body.run.id);
    const render = await start(setId, "render");
    const runId = render.body.run.id as number;
    const payloads = await renderPayloads(runId);
    assert.ok(payloads.length >= 3, "enough cells for the three shapes");
    const cellRow = async (id: number) => (await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, id)))[0]!;

    // An explicitly planned cell.
    await db.update(comparisonCellsTable).set({ renderPath: "planned" }).where(eq(comparisonCellsTable.id, payloads[0]!.cellId));
    // A cell whose panel froze only a plan: give it a panel of its own shape
    // by clearing the direct input on its panel.
    const second = await cellRow(payloads[1]!.cellId);
    const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, second.panelId));
    const args = panel!.compileArgs as Record<string, unknown>;
    await db.update(comparisonPanelsTable).set({ compileArgs: { ...args, direct: undefined, planned: { plan: true } } as never }).where(eq(comparisonPanelsTable.id, second.panelId));
    // An explicitly planned cell already submitted before the switch.
    const thirdId = payloads.find((p) => p.cellId !== payloads[0]!.cellId && p.cellId !== payloads[1]!.cellId)!;
    const third = await cellRow(thirdId.cellId);
    if (third.panelId === second.panelId) {
      await db.update(comparisonCellsTable).set({ falRequestId: "req-planned", promptText: "a prompt the planner wrote" }).where(eq(comparisonCellsTable.id, thirdId.cellId));
    } else {
      await db.update(comparisonCellsTable).set({ renderPath: "planned", falRequestId: "req-planned", promptText: "a prompt the planner wrote" }).where(eq(comparisonCellsTable.id, thirdId.cellId));
    }

    const before = submissions.length;
    await renderCell(payloads[0]!);
    await renderCell(payloads[1]!);
    await renderCell(thirdId);

    for (const p of [payloads[0]!, payloads[1]!]) {
      const cell = await cellRow(p.cellId);
      assert.equal(cell.state, "failed", `cell ${p.cellId} ends failed, not enqueued`);
      assert.match(String(cell.error), /render planner, which has been removed/);
      const [res] = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.id, p.reservationId));
      assert.equal(res!.state, "released", "nothing was submitted, so nothing is held");
    }
    const submitted = await cellRow(thirdId.cellId);
    assert.equal(submitted.state, "rendered", "a submitted cell polls its request; it is never compiled again");
    assert.equal(submitted.promptText, "a prompt the planner wrote");
    assert.equal(submissions.length, before, "no new submission for any of the three");

    await drain(runId);
    const [run] = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.id, runId));
    assert.equal(run!.state, "done", "the run finishes once every cell is terminal");
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
      await drain((await start(setId, "prepare")).body.run.id);
      const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
      assert.ok((panel!.compileArgs as { direct?: unknown }).direct, "the gag is frozen once with the panel, shared by every version");
      const sent = submissions.length;
      await drain((await start(setId, "render")).body.run.id);
      assert.equal(submissions.length - sent, 2);
      const drawn = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panel!.id));
      const baseline = drawn.find((c) => c.recipeVersionId == null)!;
      const tuned = drawn.find((c) => c.recipeVersionId === v!.id)!;
      assert.match(String(tuned.promptText), /IDENTITY & REFERENCE: Use the photo as the person's face, exactly\./);
      assert.doesNotMatch(String(baseline.promptText), /face, exactly/);
      assert.equal(String(baseline.promptText).replace(/IDENTITY & REFERENCE: .*? ADDITIONAL DETAILS/, ""), String(tuned.promptText).replace(/IDENTITY & REFERENCE: .*? ADDITIONAL DETAILS/, ""), "only the wording differs");
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

  it("draws a person and a pet panel with each version's wording for that kind of picture (PR #927)", async () => {
    const { promptRecipeVersionsTable, promptRecipePromotionsTable } = await import("@workspace/db/schema");
    const [v] = await db.insert(promptRecipeVersionsTable).values({
      engineFamily: FAMILIES.gpt, number: 1, note: "other kinds of picture",
      pieces: {
        "identity.person": "Image-to-image edit: the reference photo is the person, every feature kept recognisable.",
        "identity.pet": "Image-to-image edit: the reference image is the subject, kept recognisable. Never swap it for a human.",
      },
    }).returning({ id: promptRecipeVersionsTable.id });
    try {
      const { setId, cells } = await createComparisonSet({
        label: `${P} prompt-other`, round: 1, factIds: [factId], scenarioKeys: ["i2i_female_default", "i2i_nonhuman_animal"], lookStyleIds: ["none"],
        engineFamilies: [FAMILIES.gpt], kind: "prompt", recipeVersionIds: [null, v!.id],
      }, adminId);
      assert.equal(cells, 4, "two kinds of picture, two versions each");
      await drain((await start(setId, "prepare")).body.run.id);
      await drain((await start(setId, "render")).body.run.id);
      const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
      for (const [scenario, mine] of [["i2i_female_default", /every feature kept recognisable/], ["i2i_nonhuman_animal", /Never swap it for a human/]] as const) {
        const panel = panels.find((p) => p.scenarioKey === scenario)!;
        assert.ok(panel.compileArgs, `${scenario}: the scene is frozen`);
        const drawn = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panel.id));
        const tuned = drawn.find((c) => c.recipeVersionId === v!.id)!;
        const baseline = drawn.find((c) => c.recipeVersionId == null)!;
        assert.match(String(tuned.promptText), mine, `${scenario}: the version's wording is drawn`);
        assert.doesNotMatch(String(baseline.promptText), mine, `${scenario}: the baseline keeps today's wording`);
      }
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

// Chosen gags (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, Q11: 1): every
// picture is drawn straight from one gag; a set may name the gags it draws,
// one panel per chosen gag. The planned-versus-direct "path" set is retired
// with the planner (D): there is one render path.
describe("chosen gags", () => {
  const scene = "{NAME} drives {POSS} mom home from the hospital; mom grips the dashboard.";
  const bubbles = [{ type: "speech" as const, entity: "mom", text: "Slow down, {NAME}!" }];
  const MOM = { label: "mom", description: "the older woman in the passenger seat" };
  let gagA = 0;
  let gagB = 0;

  before(async () => {
    const [a] = await db.insert(factGagsTable).values({ factId, slot: 2, pendingContent: { ...withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: scene, bubbles }), cast: [MOM] } as never }).returning({ id: factGagsTable.id });
    const [b] = await db.insert(factGagsTable).values({ factId, slot: 3, pendingContent: withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "{NAME} parallel-parks a hospital bed.", bubbles: [] }) as never }).returning({ id: factGagsTable.id });
    gagA = a!.id;
    gagB = b!.id;
  });
  after(async () => {
    await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P} chosen%`));
    await db.delete(factGagsTable).where(inArray(factGagsTable.id, [gagA, gagB]));
  });

  async function chosenSet(label: string, gagIds?: number[]) {
    return createComparisonSet({
      label: `${P} chosen ${label}`, round: 1, factIds: [factId], scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none"],
      engineFamilies: [FAMILIES.gpt], ...(gagIds ? { gagIds } : {}),
    }, adminId);
  }

  it("refuses a path set at creation, naming why", async () => {
    const refused = await createComparisonSet({
      label: `${P} chosen path`, round: 1, factIds: [factId], scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none"],
      engineFamilies: [FAMILIES.gpt], kind: "path", gagIds: [gagA],
    }, adminId).then(() => null, (e: Error) => e);
    assert.ok(refused, "a path set is not made");
    assert.ok(String((refused as { reasons?: string[] }).reasons ?? refused.message).includes(PATH_COMPARISON_RETIRED_MESSAGE), String(refused));
  });

  it("lays out one panel per chosen gag on an engine set, and refuses a gag that is not the fact's", async () => {
    const both = await chosenSet("layout", [gagA, gagB]);
    assert.deepEqual([both.panels, both.cells], [2, 2]);
    const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, both.setId));
    assert.deepEqual(panels.map((p) => p.gagId).sort(), [gagA, gagB].sort());
    const refused = await chosenSet("foreign", [999_999_999]).then(() => null, (e: Error) => e);
    assert.match(String((refused as { reasons?: string[] } | null)?.reasons ?? refused?.message), /not a live gag/);
  });

  it("freezes the chosen gag's cast and bubbles and draws the gag alone", async () => {
    const { setId } = await chosenSet("draw", [gagA]);
    await drain((await start(setId, "prepare")).body.run.id);
    const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
    assert.equal(panel!.state, "prepared", String(panel!.error ?? panel!.skipReason));
    assert.deepEqual((panel!.gagCast as { cast: unknown }).cast, [MOM]);
    const expected = panel!.frozenBubbles as Array<{ speaker: string; text: string }>;
    assert.equal(expected[0]!.speaker, "mom");
    assert.doesNotMatch(expected[0]!.text, /\{NAME\}/, "rendered for the panel's subject");

    await drain((await start(setId, "render")).body.run.id);
    const [cell] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panel!.id));
    assert.match(String(cell!.promptText), /mom: the older woman in the passenger seat\./);
    assert.match(String(cell!.promptText), /as comedy, without intense gore/);
    assert.match(String(cell!.promptText), /drives his mom home from the hospital/);
    assert.doesNotMatch(String(cell!.promptText), /hoists a mountain/, "the chosen gag, not the fact's default");

    const { getBlindSet } = await import("../lib/comparison/judging.js");
    const blind = await getBlindSet(setId);
    assert.deepEqual(blind!.panels[0]!.bubbles?.map((b) => b.speaker), ["mom"]);
  });

  it("skips a panel whose gag cannot be drawn as it stands (its cast was not read from its scene), naming why", async () => {
    await db.update(factGagsTable).set({ pendingContent: { ...withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "{NAME} parallel-parks a hospital bed.", bubbles: [] }), coreSceneOverride: "{NAME} parallel-parks an ambulance." } as never }).where(eq(factGagsTable.id, gagB));
    const { setId } = await chosenSet("stale", [gagB]);
    await drain((await start(setId, "prepare")).body.run.id);
    const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
    assert.equal(panel!.state, "skipped");
    assert.match(String(panel!.skipReason), /cast was not read from its scene/);
  });
});
});
