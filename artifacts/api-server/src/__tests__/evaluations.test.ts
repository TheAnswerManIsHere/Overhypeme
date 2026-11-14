// The Eval page's evaluations (plan docs/plans/PLAN_EVAL_PAGE.md): the
// eligible-fact search, Generate Images creating and starting one evaluation
// once, the "full" run queueing each picture the moment its scene is
// prepared, the retries starting their own work, the derived statuses and
// Finish. Every paid call is faked, as in comparisonRuns.test.ts.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  asyncJobsTable,
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonPicksTable,
  comparisonReservationsTable,
  comparisonRunsTable,
  comparisonSetsTable,
  factsTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";

import adminComparisonRouter from "../routes/adminComparison.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { makeStubPlan, VALID_ENRICHMENT } from "./helpers/stubPlanner.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { __setPlanGeneratorForTest } from "../lib/imagePrompt/preview.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { __setComparisonFalForTest, type ComparisonFal } from "../lib/comparison/transport.js";
import {
  __allowComparisonDispatchInCiForTest,
  __setComparisonImageStoreForTest,
  CELL_POLL,
  COMPARISON_PREPARE_QUEUE,
  COMPARISON_RENDER_QUEUE,
  preparePanel,
  renderCell,
} from "../lib/comparison/runs.js";
import { createEvaluation, estimateEvaluation, finishEvaluation, listEvaluations, progressOf, searchEligibleFacts } from "../lib/comparison/evaluations.js";
import { panelPreparationTypicalUsd } from "../lib/comparison/admission.js";
import { plannerSettings } from "../lib/comparison/sets.js";
import type { EvaluationCreate } from "@workspace/api-zod";
import { testEngineRow } from "./helpers/testEngines.js";
import { clearEngineCaches } from "../lib/engineInterpreter.js";

const P = `t-ev-${randomUUID().slice(0, 6)}`;
const FAMILIES = { gpt: `${P}-gpt`, flux: `${P}-flux` };
const SOURCES: Array<[string, string]> = [
  [FAMILIES.gpt, "gpt-image-2-5"], [FAMILIES.gpt, "gpt-image-2-5-edit"],
  [FAMILIES.flux, "flux-3"], [FAMILIES.flux, "flux-3-edit"],
];
const engineIds: string[] = [];
let adminId = "";
let activeFact = 0;
let inactiveFact = 0;
let brokenFact = 0;

let submissions: Array<{ endpointId: string; input: Record<string, unknown> }> = [];
let failPlanner = false;
const fakeFal: ComparisonFal = {
  async submit(endpointId, input) { submissions.push({ endpointId, input }); return `req-${submissions.length}`; },
  async status() { return "COMPLETED"; },
  async result(_e, requestId) { return { images: [{ url: `https://vendor.test/${requestId}.png` }] }; },
};

const ACTIVE_ENRICHMENT = { ...VALID_ENRICHMENT, visualPromptStrategyOverride: { version: 1, coreSceneOverride: "{NAME} lifts a whole mountain overhead." } };

// One wrapper scopes the file-level hooks to this file: with test isolation off,
// a root-level beforeEach would install this file's fakes for every other file
// in the same shard.
describe("evaluations", () => {
before(async () => {
  for (const [family, src] of SOURCES) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${family}-${def.imageMode}`;
    testEngineRow(def, id, family);
    engineIds.push(id);
  }
  adminId = `${P}-admin`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
  const facts = await db.insert(factsTable).values([
    { text: `${P} zebra {NAME} lifts a mountain`, isActive: true, enrichment: ACTIVE_ENRICHMENT as never },
    { text: `${P} zebra {NAME} is not live yet`, isActive: false, enrichment: VALID_ENRICHMENT as never },
    { text: `${P} zebra {NAME} has a broken enrichment`, isActive: true, enrichment: { visualPromptStrategyOverride: { coreSceneOverride: "x" } } as never },
  ]).returning({ id: factsTable.id });
  [activeFact, inactiveFact, brokenFact] = facts.map((f) => f.id) as [number, number, number];
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
  await db.delete(factsTable).where(inArray(factsTable.id, [activeFact, inactiveFact, brokenFact]));
  clearEngineCaches();
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

beforeEach(() => {
  submissions = [];
  failPlanner = false;
  __allowComparisonDispatchInCiForTest(true);
  __setComparisonFalForTest(fakeFal);
  __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
  __setComparisonImageStoreForTest(async (cell) => `/objects/comparison/cell-${cell.id}.png`);
  __setPlanGeneratorForTest(async (input) => {
    if (failPlanner) throw new Error("planner down");
    return makeStubPlan((input as { subjectRenderMode: string }).subjectRenderMode === "t2i_fallback" ? "t2i_fallback" : "human_identity_i2i", "A protagonist lifts a mountain.") as never;
  });
  CELL_POLL.intervalMs = 0;
});

const app = () => buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);

/** The lib takes the test families the route's schema would refuse (it names only the real candidates). */
function generate(label: string, token = randomUUID()): EvaluationCreate {
  return {
    requestToken: token,
    description: `${P} ${label}`,
    selection: {
      kind: "engine", factIds: [activeFact], engineFamilies: [FAMILIES.gpt, FAMILIES.flux] as never,
      scenarioKeys: ["generic_t2i", "i2i_male_default"] as never, lookStyleIds: ["none"],
    },
  };
}

/** Run every queued comparison job through its handler, repeatedly, as the worker would. */
async function drainAll(): Promise<void> {
  const seen = new Set<number>();
  for (let round = 0; round < 5; round++) {
    const jobs = (await db.select().from(asyncJobsTable).where(inArray(asyncJobsTable.queue, [COMPARISON_PREPARE_QUEUE, COMPARISON_RENDER_QUEUE])))
      .filter((j) => !seen.has(j.id));
    if (!jobs.length) return;
    for (const job of jobs) {
      seen.add(job.id);
      if (job.queue === COMPARISON_PREPARE_QUEUE) await preparePanel(job.payload as never);
      else await renderCell(job.payload as never);
    }
  }
}

async function rows(setId: number) {
  const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
  const cells = await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id)));
  return { panels, cells };
}

async function summary(setId: number) {
  return (await listEvaluations("engine")).find((e) => e.id === setId)!;
}

describe("the eligible-fact search", () => {
  it("finds active facts whose enrichment validates, by every keyword, and counts the pool", async () => {
    const { facts, eligibleTotal } = await searchEligibleFacts(`${P} zebra`);
    assert.deepEqual(facts.map((f) => f.id), [activeFact], "the inactive and the broken fact are excluded");
    assert.ok(eligibleTotal >= 1);
    assert.deepEqual((await searchEligibleFacts(`${P} zebra mountain`)).facts.map((f) => f.id), [activeFact]);
    assert.deepEqual((await searchEligibleFacts(`${P} giraffe`)).facts, []);
    const res = await request(app()).get(`/api/admin/comparison/eligible-facts?q=${encodeURIComponent(`${P} zebra`)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.facts.map((f: { id: number }) => f.id), [activeFact]);
  });
});

describe("Generate Images", () => {
  it("creates one evaluation, prepares every scene and draws every picture with no second button, admitted once", async () => {
    const out = await createEvaluation(generate("full"), adminId);
    assert.equal(out.created, true);
    const runs = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.setId, out.setId));
    assert.equal(runs.length, 1, "one run");
    assert.equal(runs[0]!.kind, "full");
    const before = await rows(out.setId);
    assert.ok(before.panels.every((p) => p.state === "preparing"));
    assert.ok(before.cells.every((c) => c.state === "waiting"), "pictures wait, reserved, for their scene");
    const reserved = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.runId, runs[0]!.id));
    assert.equal(reserved.length, before.panels.length + before.cells.length, "every call reserved up front");
    assert.equal((await summary(out.setId)).status, "generating");

    await drainAll();
    const afterRows = await rows(out.setId);
    assert.ok(afterRows.panels.every((p) => p.state === "prepared"));
    assert.ok(afterRows.cells.every((c) => c.state === "rendered"), JSON.stringify(afterRows.cells.map((c) => c.state)));
    assert.equal(submissions.length, afterRows.cells.length, "one submission per picture");
    const settled = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.runId, runs[0]!.id));
    assert.ok(settled.every((r) => r.state === "settled"), "every reservation settled at its bound");
    const [run] = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.id, runs[0]!.id));
    assert.equal(run!.state, "done");
    assert.equal((await summary(out.setId)).status, "ready");
  });

  it("returns the same evaluation for a repeated token and buys nothing more", async () => {
    const token = randomUUID();
    const first = await createEvaluation(generate("token", token), adminId);
    const again = await createEvaluation(generate("token again", token), adminId);
    assert.equal(again.setId, first.setId);
    assert.equal(again.created, false);
    assert.equal((await db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.requestToken, token))).length, 1);
    assert.equal((await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.setId, first.setId))).length, 1, "no second run");
  });

  it("refuses a fact that is no longer eligible, naming it", async () => {
    const bad = generate("ineligible");
    bad.selection.factIds = [activeFact, inactiveFact];
    await assert.rejects(createEvaluation(bad, adminId), (err: Error & { reasons?: string[] }) => {
      assert.match(err.message, /can no longer be evaluated/);
      assert.ok(err.reasons!.some((r) => r.includes(String(inactiveFact))));
      return true;
    });
  });

  it("refuses an engine outside the candidates and a photo type outside the three at the route", async () => {
    const body = { requestToken: randomUUID(), description: `${P} route`, selection: { kind: "engine", factIds: [activeFact], engineFamilies: ["flux-3"], scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none"] } };
    assert.equal((await request(app()).post("/api/admin/comparison/evaluations").send(body)).status, 400);
    const female = { ...body, selection: { ...body.selection, engineFamilies: ["gpt-image-2-6"], scenarioKeys: ["i2i_female_default"] } };
    assert.equal((await request(app()).post("/api/admin/comparison/evaluations").send(female)).status, 400);
  });

  it("a failed scene releases its pictures' reservations, shows Needs action, and Retry scene starts it and its pictures", async () => {
    failPlanner = true;
    const out = await createEvaluation(generate("retry"), adminId);
    await drainAll();
    let r = await rows(out.setId);
    assert.ok(r.panels.every((p) => p.state === "failed"));
    assert.ok(r.cells.every((c) => c.state === "expected"), "the waiting pictures went back to expected");
    const imageRes = await db.select().from(comparisonReservationsTable).where(inArray(comparisonReservationsTable.cellId, r.cells.map((c) => c.id)));
    assert.ok(imageRes.every((x) => x.state === "released"), "their reservations were released");
    const s = await summary(out.setId);
    assert.equal(s.status, "needs_action");
    assert.equal(s.needsAction.length, r.panels.length);
    await assert.rejects(finishEvaluation(out.setId), /can still be started or retried/);

    failPlanner = false;
    const panel = r.panels[0]!;
    const res = await request(app()).post(`/api/admin/comparison/panels/${panel.id}/reprepare`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await drainAll();
    r = await rows(out.setId);
    assert.equal(r.panels.find((p) => p.id === panel.id)!.state, "prepared");
    assert.ok(r.cells.filter((c) => c.panelId === panel.id).every((c) => c.state === "rendered"), "Retry scene drew its pictures with no other control");
  });
});

describe("statuses and Finish", () => {
  it("derives every status from the rows alone", () => {
    const panel = (id: number, state: string) => ({ id, state, error: null }) as never;
    const cell = (panelId: number, state: string, extra: Record<string, unknown> = {}) => ({ id: Math.random(), panelId, state, rerunCount: 0, vendorResultUrl: null, imageObjectPath: state === "rendered" ? "/x" : null, ...extra }) as never;
    const by = (cells: Array<{ panelId: number }>) => { const m = new Map<number, never[]>(); for (const c of cells) m.set(c.panelId, [...(m.get(c.panelId) ?? []), c as never]); return m; };
    const none = new Set<number>();
    assert.equal(progressOf({ finishedAt: null }, [panel(1, "preparing")], by([cell(1, "waiting")]), none).status, "generating");
    assert.equal(progressOf({ finishedAt: null }, [panel(1, "prepared")], by([cell(1, "rendered"), cell(1, "failed")]), none).status, "needs_action");
    assert.equal(progressOf({ finishedAt: null }, [panel(1, "skipped")], by([cell(1, "expected")]), none).status, "nothing_to_judge", "a skipped panel needs no judgement and is not a comparison");
    assert.equal(progressOf({ finishedAt: null }, [panel(1, "prepared")], by([cell(1, "rendered")]), none).status, "ready");
    assert.equal(progressOf({ finishedAt: null }, [panel(1, "prepared"), panel(2, "prepared")], by([cell(1, "rendered"), cell(2, "rendered")]), new Set([1])).status, "judging");
    assert.equal(progressOf({ finishedAt: new Date() }, [panel(1, "prepared")], by([cell(1, "rendered")]), new Set([1])).status, "finished");
    const lost = progressOf({ finishedAt: null }, [panel(1, "prepared"), panel(2, "prepared")], by([cell(1, "rendered"), cell(2, "failed", { rerunCount: 1 })]), none);
    assert.equal(lost.status, "ready", "a panel whose pictures are lost for good needs no action and no judgement");
  });

  it("work no run holds is not generating: it carries one Resume action, and Finish refuses (PR #931 round 1)", () => {
    const panel = (id: number, state: string) => ({ id, state, error: null }) as never;
    const cell = (panelId: number, state: string) => ({ id: Math.random(), panelId, state, rerunCount: 0, vendorResultUrl: null, imageObjectPath: state === "rendered" ? "/x" : null }) as never;
    const by = (cells: Array<{ panelId: number }>) => { const m = new Map<number, never[]>(); for (const c of cells) m.set(c.panelId, [...(m.get(c.panelId) ?? []), c as never]); return m; };
    const none = new Set<number>();
    const preparedUnrendered = progressOf({ finishedAt: null }, [panel(1, "prepared")], by([cell(1, "expected"), cell(1, "expected")]), none);
    assert.equal(preparedUnrendered.status, "needs_action");
    assert.deepEqual(preparedUnrendered.needsAction.map((a) => a.action), ["resume"]);
    assert.equal(preparedUnrendered.needsAction[0]!.costs, true);
    assert.equal(progressOf({ finishedAt: null }, [panel(1, "pending")], by([cell(1, "expected")]), none).status, "needs_action");
    const mixed = progressOf({ finishedAt: null }, [panel(1, "pending"), panel(2, "preparing")], by([cell(1, "expected"), cell(2, "waiting")]), none);
    assert.equal(mixed.status, "generating", "real motion still shows as generating");
    assert.deepEqual(mixed.needsAction.map((a) => a.action), ["resume"], "and the unstarted work still offers Resume");
  });

  it("every paid action carries the most it could cost; a free one carries none (PR #931 build report)", () => {
    const panel = (id: number, state: string) => ({ id, state, error: null }) as never;
    const cell = (panelId: number, state: string, engineId: string, extra: Record<string, unknown> = {}) => ({ id: Math.random(), panelId, state, engineId, rerunCount: 0, vendorResultUrl: null, imageObjectPath: state === "rendered" ? "/x" : null, ...extra }) as never;
    const by = (cells: Array<{ panelId: number }>) => { const m = new Map<number, never[]>(); for (const c of cells) m.set(c.panelId, [...(m.get(c.panelId) ?? []), c as never]); return m; };
    const pricing = { prepUsd: 0.5, cellUsd: (id: string) => (id === "a" ? 0.1 : 0.2) };
    const none = new Set<number>();
    // Resume: a pending scene (its preparation and both pictures) plus a prepared scene's one unstarted picture.
    const resume = progressOf({ finishedAt: null }, [panel(1, "pending"), panel(2, "prepared")], by([cell(1, "expected", "a"), cell(1, "expected", "b"), cell(2, "expected", "a"), cell(2, "rendered", "b")]), none, pricing);
    assert.equal(resume.needsAction[0]!.action, "resume");
    assert.equal(resume.needsAction[0]!.boundUsd, 0.9);
    // Retry scene: its preparation plus every picture it will still draw.
    const scene = progressOf({ finishedAt: null }, [panel(1, "failed")], by([cell(1, "expected", "a"), cell(1, "expected", "b")]), none, pricing);
    assert.deepEqual(scene.needsAction.map((a) => [a.action, a.boundUsd]), [["retry_scene", 0.8]]);
    // Retry picture costs its engine's bound; Retry storage is free.
    const pics = progressOf({ finishedAt: null }, [panel(1, "prepared")], by([cell(1, "rendered", "a"), cell(1, "failed", "b"), cell(1, "failed", "a", { vendorResultUrl: "https://v/x" })]), none, pricing);
    assert.deepEqual(pics.needsAction.map((a) => [a.action, a.boundUsd]).sort(), [["retry_picture", 0.2], ["retry_storage", null]]);
    // An engine that cannot be priced leaves the amount unknown rather than understated.
    const unpriced = progressOf({ finishedAt: null }, [panel(1, "prepared")], by([cell(1, "expected", "a")]), none, { prepUsd: 0.5, cellUsd: () => null });
    assert.equal(unpriced.needsAction[0]!.boundUsd, null);
  });

  it("the estimate shows a typical cost below the ceiling, from what fal billed for each engine", async () => {
    const out = await createEvaluation(generate("typical"), adminId);
    await drainAll();
    const r = await rows(out.setId);
    await db.update(comparisonCellsTable).set({ billedUsd: "0.010000" }).where(inArray(comparisonCellsTable.id, r.cells.map((c) => c.id)));
    const est = await estimateEvaluation(generate("typical-estimate").selection);
    assert.ok(est.typicalUsd != null && est.totalBoundUsd != null);
    assert.ok(est.typicalUsd! < est.totalBoundUsd!, `typical ${est.typicalUsd} is below the ceiling ${est.totalBoundUsd}`);
    const prepTypical = est.panels * panelPreparationTypicalUsd(await plannerSettings());
    assert.equal(est.typicalUsd, Math.round((prepTypical + est.images * 0.01) * 10_000) / 10_000, "pictures are priced at the billed average");
  });

  it("Resume starts an interrupted evaluation's work once and spends no retry allowance", async () => {
    const out = await createEvaluation(generate("resume"), adminId);
    // Simulate an interruption before admission: undo the run's admission.
    const [run] = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.setId, out.setId));
    await db.delete(comparisonReservationsTable).where(eq(comparisonReservationsTable.runId, run!.id));
    await db.delete(comparisonRunsTable).where(eq(comparisonRunsTable.id, run!.id));
    const r0 = await rows(out.setId);
    await db.update(comparisonPanelsTable).set({ state: "pending" }).where(inArray(comparisonPanelsTable.id, r0.panels.map((p) => p.id)));
    await db.update(comparisonCellsTable).set({ state: "expected" }).where(inArray(comparisonCellsTable.id, r0.cells.map((c) => c.id)));
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.queue, [COMPARISON_PREPARE_QUEUE, COMPARISON_RENDER_QUEUE]));
    let s = await summary(out.setId);
    assert.equal(s.status, "needs_action");
    assert.equal(s.needsAction[0]!.action, "resume");
    await assert.rejects(finishEvaluation(out.setId), /not drawn yet/);

    const res = await request(app()).post(`/api/admin/comparison/evaluations/${out.setId}/resume`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.started, true);
    const again = await request(app()).post(`/api/admin/comparison/evaluations/${out.setId}/resume`).send({});
    assert.equal(again.body.started, false, "nothing is admitted twice");
    await drainAll();
    const r = await rows(out.setId);
    assert.ok(r.cells.every((c) => c.state === "rendered" && c.rerunCount === 0), "drawn, with no retry allowance spent");
    s = await summary(out.setId);
    assert.equal(s.status, "ready");
  });

  it("a retry starts only its own work, within the figure its button showed; Resume still holds the rest (PR #932 round 1)", async () => {
    failPlanner = true;
    const out = await createEvaluation(generate("retry-scope"), adminId);
    await drainAll();
    let r = await rows(out.setId);
    const [failed, other] = r.panels;
    assert.ok(failed && other && r.panels.every((p) => p.state === "failed"));
    // The other scene becomes work no run holds: pending, its pictures expected.
    await db.update(comparisonPanelsTable).set({ state: "pending", error: null }).where(eq(comparisonPanelsTable.id, other.id));
    failPlanner = false;

    let s = await summary(out.setId);
    const retry = s.needsAction.find((a) => a.action === "retry_scene" && a.panelId === failed.id)!;
    const resume = s.needsAction.find((a) => a.action === "resume")!;
    assert.ok(retry.boundUsd != null && resume.boundUsd != null);

    const res = await request(app()).post(`/api/admin/comparison/panels/${failed.id}/reprepare`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.startError, null);
    r = await rows(out.setId);
    assert.equal(r.panels.find((p) => p.id === other.id)!.state, "pending", "the other scene was not started");
    assert.ok(r.cells.filter((c) => c.panelId === other.id).every((c) => c.state === "expected"), "nor its pictures");
    const runs = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.setId, out.setId));
    const latest = runs.sort((a, b) => b.id - a.id)[0]!;
    assert.ok(Number(latest.boundUsd) <= retry.boundUsd! + 1e-9, `run bound ${latest.boundUsd} is within the shown ${retry.boundUsd}`);
    const held = await db.select().from(comparisonReservationsTable).where(eq(comparisonReservationsTable.runId, latest.id));
    const otherCells = new Set(r.cells.filter((c) => c.panelId === other.id).map((c) => c.id));
    assert.ok(held.every((h) => h.panelId !== other.id && !otherCells.has(h.cellId ?? -1)), "no reservation for the other scene's work");

    await drainAll();
    s = await summary(out.setId);
    const after = s.needsAction.find((a) => a.action === "resume")!;
    assert.equal(after.boundUsd, resume.boundUsd, "Resume shows the same figure for the work it still holds");
    const go = await request(app()).post(`/api/admin/comparison/evaluations/${out.setId}/resume`).send({});
    assert.equal(go.body.started, true);
    await drainAll();
    r = await rows(out.setId);
    assert.ok(r.cells.every((c) => c.state === "rendered"), "Resume drew the rest, once");
  });

  it("two overlapping Generate requests with one token make one evaluation and both succeed", async () => {
    const token = randomUUID();
    const [a, b] = await Promise.all([createEvaluation(generate("race", token), adminId), createEvaluation(generate("race", token), adminId)]);
    assert.equal(a.setId, b.setId);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    assert.equal((await db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.requestToken, token))).length, 1);
    const reserved = await db.select().from(comparisonReservationsTable).innerJoin(comparisonRunsTable, eq(comparisonRunsTable.id, comparisonReservationsTable.runId)).where(eq(comparisonRunsTable.setId, a.setId));
    const r = await rows(a.setId);
    assert.equal(reserved.length, r.panels.length + r.cells.length, "every item admitted once");
  });

  it("refuses Finish until every judgeable panel is judged, then records it", async () => {
    const out = await createEvaluation(generate("finish"), adminId);
    await drainAll();
    await assert.rejects(finishEvaluation(out.setId), /judge every panel first: 0 of 2/);
    const r = await rows(out.setId);
    for (const p of r.panels) {
      const cells = r.cells.filter((c) => c.panelId === p.id);
      await db.insert(comparisonPicksTable).values({ panelId: p.id, pickedCellId: cells[0]!.id, categoryScores: [], judgedBy: adminId });
    }
    const res = await request(app()).post(`/api/admin/comparison/evaluations/${out.setId}/finish`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await summary(out.setId)).status, "finished");
  });
});
});
