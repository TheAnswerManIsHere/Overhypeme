// Launch Phase 8, increment 3: blind judging and results against the test
// database (plan PLAN_PHASE8_ENGINE_EVALUATION.md, *Proposed Design* E and
// *Testing Plan*, "Blind view"). Seeds two engine families under a `t-cj-`
// prefix, one fact, and a set of two panels (generic_t2i and
// i2i_male_default) whose four cells are marked rendered directly: judging
// needs stored images, not a run.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonPicksTable,
  comparisonReservationsTable,
  comparisonRunsTable,
  comparisonSetsTable,
  enginesTable,
  factsTable,
  lookStylesTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";

import adminComparisonRouter, { __setBlindImageStorageForTest } from "../routes/adminComparison.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { VALID_ENRICHMENT } from "./helpers/stubPlanner.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { codeDefinitionToRow } from "../lib/engines/reconcile.js";
import { createComparisonSet } from "../lib/comparison/sets.js";
import { blindImagePath, getComparisonResults, median } from "../lib/comparison/judging.js";
import { frozenJudgingReference } from "../lib/comparison/runs.js";
import { testEngineRow } from "./helpers/testEngines.js";

const P = `t-cj-${randomUUID().slice(0, 6)}`;
const FAMILIES = { gpt: `${P}-gpt`, flux: `${P}-flux` };
const SOURCES: Array<[string, string]> = [
  [FAMILIES.gpt, "gpt-image-2-5"], [FAMILIES.gpt, "gpt-image-2-5-edit"],
  [FAMILIES.flux, "flux-3"], [FAMILIES.flux, "flux-3-edit"],
];
const engineIds: string[] = [];
const endpointIds: string[] = [];
let adminId = "";
let factId = 0;

before(async () => {
  for (const [family, src] of SOURCES) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${family}-${def.imageMode}`;
    await db.insert(enginesTable).values(testEngineRow(def, id, family));
    engineIds.push(id);
    endpointIds.push(def.endpointId!);
  }
  adminId = `${P}-admin`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
  const [fact] = await db.insert(factsTable).values({ text: `${P} {NAME} lifts a mountain`, isActive: false, enrichment: VALID_ENRICHMENT as never }).returning({ id: factsTable.id });
  factId = fact!.id;
});

after(async () => {
  await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P}%`));
  await db.delete(factsTable).where(eq(factsTable.id, factId));
  await db.delete(enginesTable).where(inArray(enginesTable.id, engineIds));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

const app = () => buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);

/** A set whose cells all have a stored image, except `missing` ones. */
async function renderedSet(label: string, opts: { missingT2i?: boolean; lookStyleIds?: string[]; edition?: 1 | 2 } = {}): Promise<{ setId: number; panels: Array<{ id: number; imageMode: string }>; cells: Array<{ id: number; panelId: number; engineId: string }> }> {
  const { setId } = await createComparisonSet({
    label: `${P} ${label}`, round: 1, factIds: [factId],
    scenarioKeys: ["generic_t2i", "i2i_male_default"], lookStyleIds: opts.lookStyleIds ?? ["none"],
    engineFamilies: [FAMILIES.gpt, FAMILIES.flux],
  }, adminId);
  // A new set is judged on the second edition; the tests written for the first say so.
  if ((opts.edition ?? 1) === 1) await db.update(comparisonSetsTable).set({ judgingEdition: 1 }).where(eq(comparisonSetsTable.id, setId));
  const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
  await db.update(comparisonPanelsTable).set({ state: "prepared" }).where(eq(comparisonPanelsTable.setId, setId));
  const cells = await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id)));
  for (const c of cells) {
    const panel = panels.find((p) => p.id === c.panelId)!;
    if (opts.missingT2i && panel.imageMode === "t2i" && c.engineId.startsWith(FAMILIES.flux)) continue;
    await db.update(comparisonCellsTable).set({ state: "rendered", imageObjectPath: `/objects/comparison/panel-${c.panelId}/cell-${c.id}-1.png`, falRequestId: `req-${c.id}` }).where(eq(comparisonCellsTable.id, c.id));
  }
  return { setId, panels, cells };
}

const pickPath = (panelId: number) => `/api/admin/comparison/panels/${panelId}/pick`;

/** The same score for every image a blind panel shows. */
function rateAll(panel: { images: Array<{ token: string }> }, score: number): Array<{ token: string; score: number }> {
  return panel.images.map((i) => ({ token: i.token, score }));
}

/** Every string anywhere in a value. */
function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return [...Object.keys(value), ...Object.values(value).flatMap(stringValues)];
  return [];
}

describe("the blind view", () => {
  it("names no engine, endpoint, family, cell or storage path, and its shuffle is stable", async () => {
    const { setId, cells } = await renderedSet("blind");
    const first = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const strings = stringValues(first.body);
    const forbidden = [...engineIds, ...endpointIds, ...Object.values(FAMILIES), "gpt", "flux", "/objects/", "engineId", "cellId", "endpoint", "req-"];
    for (const s of strings) for (const f of forbidden) assert.ok(!s.toLowerCase().includes(f.toLowerCase()), `the blind payload carries "${s}", which names "${f}"`);
    for (const c of cells) assert.ok(!strings.some((s) => s.includes(`cell-${c.id}`)), "no storage path");

    assert.equal(first.body.progress.panels, 2);
    assert.equal(first.body.progress.judgeable, 2);
    for (const panel of first.body.panels) {
      assert.equal(panel.images.length, 2);
      for (const img of panel.images) {
        assert.match(img.token, /^[0-9a-f]{16}$/);
        assert.equal(img.src, `/api/admin/comparison/panels/${panel.panelId}/images/${img.token}`);
      }
    }
    const second = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    assert.deepEqual(second.body.panels.map((p: { images: unknown }) => p.images), first.body.panels.map((p: { images: unknown }) => p.images), "the same order on every read");

    const human = first.body.panels.find((p: { scenarioKey: string }) => p.scenarioKey === "i2i_male_default");
    const generic = first.body.panels.find((p: { scenarioKey: string }) => p.scenarioKey === "generic_t2i");
    assert.equal(human.faceMarkable, true);
    assert.equal(generic.faceMarkable, false);
    assert.match(generic.factText, /lifts a mountain/);
  });

  it("shows a reference panel's source photo and prompt beside its pictures, and no photo on text-to-image", async () => {
    const { setId, panels } = await renderedSet("reference");
    const human = panels.find((p) => p.imageMode === "i2i")!;
    await db.update(comparisonPanelsTable).set({ referenceImageUrl: "https://v3b.fal.media/files/ref-male-1024.jpg", referenceIdentityType: "male", compiledPrompt: { imagePrompt: "A man lifts a mountain at dawn." } }).where(eq(comparisonPanelsTable.id, human.id));
    const blind = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    const ref = blind.body.panels.find((p: { panelId: number }) => p.panelId === human.id);
    const t2i = blind.body.panels.find((p: { panelId: number }) => p.panelId !== human.id);
    assert.deepEqual(ref.reference, { src: "https://v3b.fal.media/files/ref-male-1024.jpg", identityType: "male" });
    assert.equal(t2i.reference, null);
    assert.equal(ref.prompt, "A man lifts a mountain at dawn.", "the prompt every engine was sent, word for word");
    const strings = stringValues(blind.body);
    assert.ok(!engineIds.some((id) => strings.some((s) => s.includes(id))), "still names no engine");
  });

  it("serves each token's image and nothing for a token that is not the panel's", async () => {
    const { setId, cells } = await renderedSet("tokens");
    const blind = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    const panel = blind.body.panels[0];
    const paths = await Promise.all(panel.images.map((img: { token: string }) => blindImagePath(panel.panelId, img.token)));
    const expected = cells.filter((c) => c.panelId === panel.panelId).map((c) => `/objects/comparison/panel-${c.panelId}/cell-${c.id}-1.png`).sort();
    assert.deepEqual([...paths].sort(), expected);
    assert.equal(await blindImagePath(panel.panelId, "0000000000000000"), null);
    const other = blind.body.panels[1];
    assert.equal(await blindImagePath(other.panelId, panel.images[0].token), null, "a token is bound to its panel");
    const bad = await request(app()).get(`/api/admin/comparison/panels/${panel.panelId}/images/not-a-token`);
    assert.equal(bad.status, 400);
    const missing = await request(app()).get(`/api/admin/comparison/panels/${panel.panelId}/images/0000000000000000`);
    assert.equal(missing.status, 404);
  });

  it("shows no image of a panel still waiting on one, and refuses scores on it", async () => {
    const { setId } = await renderedSet("missing", { missingT2i: true });
    const blind = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    const generic = blind.body.panels.find((p: { scenarioKey: string }) => p.scenarioKey === "generic_t2i");
    assert.equal(generic.judgeable, false);
    assert.deepEqual(generic.images, []);
    assert.equal(generic.imagesReady, 1);
    assert.equal(generic.imagesExpected, 2);
    assert.equal(blind.body.progress.judgeable, 1);
    const res = await request(app()).post(pickPath(generic.panelId)).send({ ratings: [{ token: "0123456789abcdef", score: 3 }] });
    assert.equal(res.status, 409);
    assert.match(res.body.refusal, /every image is ready/);
  });
});

describe("a skipped panel", () => {
  it("stays listed with its reason and counts in every total, judging and results alike", async () => {
    const { setId, panels } = await renderedSet("skipped");
    const human = panels.find((p) => p.imageMode === "i2i")!;
    await db.update(comparisonPanelsTable).set({ state: "skipped", skipReason: "reference asset unavailable: missing file defaults/male.jpg" }).where(eq(comparisonPanelsTable.id, human.id));
    await db.update(comparisonCellsTable).set({ state: "expected", imageObjectPath: null }).where(eq(comparisonCellsTable.panelId, human.id));

    const blind = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    assert.equal(blind.body.panels.length, 2, "the skipped panel is still listed");
    const skipped = blind.body.panels.find((p: { panelId: number }) => p.panelId === human.id);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.judgeable, false);
    assert.match(skipped.skipReason, /reference asset unavailable/);
    assert.deepEqual(skipped.images, []);
    assert.deepEqual(blind.body.progress, { panels: 2, judgeable: 1, judged: 0, skipped: 1, lost: 0 });

    const generic = blind.body.panels.find((p: { panelId: number }) => p.panelId !== human.id);
    await request(app()).post(pickPath(generic.panelId)).send({ ratings: rateAll(generic, 3) });
    const results = await request(app()).get(`/api/admin/comparison/results?setIds=${setId}`);
    assert.deepEqual(results.body.panels, { total: 2, judged: 1, judgeable: 1, skipped: 1, lost: 0 }, "every available panel judged is still not a complete comparison");
  });
});

describe("why a panel is waiting, and a lost image", () => {
  it("tells needs-action from rendering; a lost image is shown missing and the rest are scored, naming no engine", async () => {
    const { setId, cells } = await renderedSet("waiting", { missingT2i: true });
    const missing = cells.find((c) => c.engineId.startsWith(FAMILIES.flux) && c.engineId.endsWith("-t2i"))!;
    const read = async () => {
      const res = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
      return { panel: res.body.panels.find((p: { panelId: number }) => p.panelId === missing.panelId), body: res.body };
    };
    assert.equal((await read()).panel.waiting, "rendering", "its cell is still expected");

    await db.update(comparisonCellsTable).set({ state: "failed", error: "render failed: content policy" }).where(eq(comparisonCellsTable.id, missing.id));
    assert.equal((await read()).panel.waiting, "needs_action", "a failed cell with its re-run left");

    await db.update(comparisonCellsTable).set({ rerunCount: 1 }).where(eq(comparisonCellsTable.id, missing.id));
    const lost = await read();
    assert.equal(lost.panel.waiting, null, "one lost image no longer holds the panel back");
    assert.equal(lost.panel.judgeable, true);
    assert.equal(lost.panel.images.length, 1, "only the image that exists is shown");
    assert.equal(lost.panel.imagesMissing, 1);
    assert.equal(lost.body.progress.lost, 0);
    const strings = stringValues(lost.body);
    assert.ok(!strings.some((s) => s.includes("content policy")), "a cell's error, which may name its engine's filter, is never sent");
    assert.ok(!engineIds.some((id) => strings.includes(id)), "no engine is named");

    const scored = await request(app()).post(pickPath(missing.panelId)).send({ ratings: rateAll(lost.panel, 4) });
    assert.equal(scored.status, 200, JSON.stringify(scored.body));
    const results = await request(app()).get(`/api/admin/comparison/results?setIds=${setId}`);
    const t2i = results.body.ranking.t2i as Array<{ family: string; mean: number | null; scored: number; lost: number }>;
    assert.deepEqual(t2i.map((r) => [r.family, r.mean, r.scored, r.lost]), [
      [FAMILIES.gpt, 4, 1, 0],
      [FAMILIES.flux, 1, 0, 1],
    ], "the picture the engine could not draw counts as a 1 (David, 2026-11-10), and its loss is counted");
    assert.deepEqual(results.body.leaders.t2i, { families: [FAMILIES.gpt], pictures: [1], mean: 4, judged: 1 });
    assert.deepEqual(results.body.scores.byMode.t2i[FAMILIES.flux], { mean: 1, count: 1 });

    await db.update(comparisonCellsTable).set({ vendorResultUrl: "https://vendor.test/x.png" }).where(eq(comparisonCellsTable.id, missing.id));
    assert.equal((await read()).panel.waiting, "needs_action", "an image kept at the vendor can still be stored");

    // Every image lost for good: nothing to score.
    await db.update(comparisonCellsTable).set({ state: "skipped", imageObjectPath: null, vendorResultUrl: null }).where(eq(comparisonCellsTable.panelId, missing.panelId));
    const none = await read();
    assert.equal(none.panel.waiting, "lost");
    assert.equal(none.panel.judgeable, false);
    assert.equal(none.body.progress.lost, 1);
  });
});

describe("a blind image whose storage fails mid-body", () => {
  it("ends only that response; the process keeps serving", async () => {
    const { setId } = await renderedSet("stream");
    const blind = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    const img = blind.body.panels[0].images[0];
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on("uncaughtException", onUncaught);
    __setBlindImageStorageForTest({
      getObjectEntityFile: async () => ({}) as never,
      downloadObject: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([137, 80, 78, 71])); },
        pull(controller) { controller.error(new Error("storage failed mid-body")); },
      }), { status: 200, headers: { "content-type": "image/png" } }),
    });
    try {
      await assert.rejects(request(app()).get(img.src), "the response is cut off, not completed");
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(uncaught, [], "no error escaped to the process");
      const after = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
      assert.equal(after.status, 200, "the server still answers");
    } finally {
      __setBlindImageStorageForTest(null);
      process.off("uncaughtException", onUncaught);
    }
  });
});

const STYLE = `${P}-look`;

describe("captured the style", () => {
  before(async () => { await db.insert(lookStylesTable).values({ id: STYLE, label: "Judging test look", promptSuffix: "test look" }); });
  after(async () => { await db.delete(lookStylesTable).where(eq(lookStylesTable.id, STYLE)); });

  // David, 2026-11-11: "I need a check box that says 'Captured the Style' ... next to each image".
  it("is offered only on styled panels, stored against the hidden cell, kept in history, and tallied per style and family", async () => {
    const plain = await renderedSet("style-plain");
    const plainBlind = await request(app()).get(`/api/admin/comparison/sets/${plain.setId}/judging`);
    const plainPanel = plainBlind.body.panels[0];
    assert.equal(plainPanel.styleMarkable, false, "an unstyled panel offers no style mark");
    const refused = await request(app()).post(pickPath(plainPanel.panelId)).send({ ratings: rateAll(plainPanel, 3), styleCapturedTokens: [plainPanel.images[0].token] });
    assert.equal(refused.status, 409);
    assert.match(refused.body.refusal, /look style/);

    const styled = await renderedSet("style-anime", { lookStyleIds: [STYLE] });
    const blind = await request(app()).get(`/api/admin/comparison/sets/${styled.setId}/judging`);
    assert.ok(blind.body.panels.every((p: { styleMarkable: boolean }) => p.styleMarkable), "every styled panel offers the mark");
    const panel = blind.body.panels[0];
    const [a, b] = panel.images.map((i: { token: string }) => i.token);
    const foreign = await request(app()).post(pickPath(panel.panelId)).send({ ratings: rateAll(panel, 3), styleCapturedTokens: [blind.body.panels[1].images[0].token] });
    assert.equal(foreign.status, 409, "a mark naming another panel's picture is refused");

    const saved = await request(app()).post(pickPath(panel.panelId)).send({ ratings: [{ token: a, score: 2 }, { token: b, score: 4 }], styleCapturedTokens: [a] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.pick.styleCapturedTokens, [a]);
    const cellOf = async (token: string) => Number((await blindImagePath(panel.panelId, token))!.match(/cell-(\d+)-/)![1]);
    const [row] = await db.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, panel.panelId));
    assert.deepEqual(row!.styleCapturedCellIds, [await cellOf(a)], "a low score can still have captured the style");

    const reread = await request(app()).get(`/api/admin/comparison/sets/${styled.setId}/judging`);
    assert.deepEqual(reread.body.panels.find((p: { panelId: number }) => p.panelId === panel.panelId).pick.styleCapturedTokens, [a], "the mark survives a reload");

    const results = await getComparisonResults([styled.setId]);
    const capturedCell = styled.cells.find((c) => c.id === (row!.styleCapturedCellIds as number[])[0]);
    const capturedFamily = capturedCell!.engineId.startsWith(FAMILIES.gpt) ? FAMILIES.gpt : FAMILIES.flux;
    const otherFamily = capturedFamily === FAMILIES.gpt ? FAMILIES.flux : FAMILIES.gpt;
    assert.deepEqual(results!.styleCaptured[STYLE], { [capturedFamily]: { captured: 1, pictures: 1 }, [otherFamily]: { captured: 0, pictures: 1 } });

    const changed = await request(app()).post(pickPath(panel.panelId)).send({ ratings: [{ token: a, score: 2 }, { token: b, score: 4 }], styleCapturedTokens: [] });
    assert.equal(changed.status, 200);
    const [after] = await db.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, panel.panelId));
    assert.deepEqual(after!.styleCapturedCellIds, []);
    assert.deepEqual((after!.history as Array<{ styleCapturedCellIds: unknown }>)[0]!.styleCapturedCellIds, [await cellOf(a)], "the earlier marks are kept in history");
  });
});

describe("scores", () => {
  it("scores every image 1 to 5 against its hidden cell, replaces them keeping the history, and validates", async () => {
    const { setId } = await renderedSet("pick");
    const blind = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    const human = blind.body.panels.find((p: { scenarioKey: string }) => p.scenarioKey === "i2i_male_default");
    const generic = blind.body.panels.find((p: { scenarioKey: string }) => p.scenarioKey === "generic_t2i");
    const [a, b] = human.images.map((i: { token: string }) => i.token);

    const faceOnGeneric = await request(app()).post(pickPath(generic.panelId)).send({ ratings: rateAll(generic, 3), faceMismatchTokens: [generic.images[1].token] });
    assert.equal(faceOnGeneric.status, 409);
    assert.match(faceOnGeneric.body.refusal, /person's reference photo/);
    const foreign = await request(app()).post(pickPath(human.panelId)).send({ ratings: [{ token: a, score: 3 }, { token: generic.images[0].token, score: 3 }] });
    assert.equal(foreign.status, 409);
    const partial = await request(app()).post(pickPath(human.panelId)).send({ ratings: [{ token: a, score: 3 }] });
    assert.equal(partial.status, 409);
    assert.match(partial.body.refusal, /score every image: 1 of 2/);
    const twice = await request(app()).post(pickPath(human.panelId)).send({ ratings: [{ token: a, score: 3 }, { token: a, score: 4 }] });
    assert.equal(twice.status, 409);
    for (const score of [0, 6, 2.5]) {
      const out = await request(app()).post(pickPath(human.panelId)).send({ ratings: [{ token: a, score }, { token: b, score: 3 }] });
      assert.equal(out.status, 400, `a score of ${score} is refused`);
    }
    const named = await request(app()).post(pickPath(human.panelId)).send({ ratings: [{ token: engineIds[1], score: 3 }] });
    assert.equal(named.status, 400, "a score names an image by token, never by engine");
    const oldShape = await request(app()).post(pickPath(human.panelId)).send({ pickedToken: a });
    assert.equal(oldShape.status, 400, "a single pick is no longer a judgement");

    const first = await request(app()).post(pickPath(human.panelId)).send({ ratings: [{ token: a, score: 5 }, { token: b, score: 2 }], faceMismatchTokens: [b] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const [row] = await db.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, human.panelId));
    const stored = row!.ratings as Array<{ cellId: number; score: number }>;
    const cellOf = async (token: string) => Number((await blindImagePath(human.panelId, token))!.match(/cell-(\d+)-/)![1]);
    assert.deepEqual(new Map(stored.map((r) => [r.cellId, r.score])), new Map([[await cellOf(a), 5], [await cellOf(b), 2]]), "each score is the cell behind its token");
    assert.equal(row!.pickedCellId, null);
    assert.deepEqual(row!.faceMismatchCellIds, [await cellOf(b)]);
    assert.equal(row!.judgedBy, adminId);

    const again = await request(app()).post(pickPath(human.panelId)).send({ ratings: [{ token: a, score: 1 }, { token: b, score: 4 }] });
    assert.equal(again.status, 200);
    const [replaced] = await db.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, human.panelId));
    assert.deepEqual(replaced!.faceMismatchCellIds, []);
    const history = replaced!.history as Array<{ ratings: unknown }>;
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]!.ratings, stored);

    const reread = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    const humanAgain = reread.body.panels.find((p: { panelId: number }) => p.panelId === human.panelId);
    assert.deepEqual(humanAgain.pick.ratings, { [a]: 1, [b]: 4 }, "the scores survive a reload, by token");
    assert.equal(reread.body.progress.judged, 1);
  });
});

describe("results", () => {
  it("reveals the engines: average scores per mode, style and scenario, ranked with price; face marks and costs", async () => {
    const { setId, panels, cells } = await renderedSet("results");
    const blind = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    // FLUX scores 5 on text-to-image and 4 on the edit; GPT 3 and 4 (a tie on the edit).
    for (const panel of blind.body.panels) {
      const ratings = [];
      let gptToken = "";
      for (const img of panel.images) {
        const path = (await blindImagePath(panel.panelId, img.token))!;
        const cell = cells.find((c) => path.includes(`cell-${c.id}-`))!;
        const flux = cell.engineId.startsWith(FAMILIES.flux);
        if (!flux) gptToken = img.token;
        ratings.push({ token: img.token, score: panel.imageMode === "t2i" ? (flux ? 5 : 3) : 4 });
      }
      const res = await request(app()).post(pickPath(panel.panelId)).send({ ratings, faceMismatchTokens: panel.faceMarkable ? [gptToken] : [] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    // Render times: FLUX's text-to-image took 10 s, GPT's 120 s; the edits are not timed.
    const t0 = new Date("2026-11-10T12:00:00Z");
    const at = (secs: number) => new Date(t0.getTime() + secs * 1000);
    await db.update(comparisonCellsTable).set({ submittedAt: t0, completedAt: at(10) }).where(eq(comparisonCellsTable.id, cells.find((c) => c.engineId === engineIds[2])!.id));
    await db.update(comparisonCellsTable).set({ submittedAt: t0, completedAt: at(120) }).where(eq(comparisonCellsTable.id, cells.find((c) => c.engineId === engineIds[0])!.id));
    // Two recorded image calls and one planner call; a released call costs nothing.
    const [run] = await db.insert(comparisonRunsTable).values({ setId, kind: "render", state: "done", boundUsd: "0.2000" }).returning();
    const fluxT2i = engineIds[2]!;
    await db.insert(comparisonReservationsTable).values([
      { runId: run!.id, kind: "image", target: fluxT2i, cellId: cells.find((c) => c.engineId === fluxT2i)!.id, boundUsd: "0.0480", settledUsd: "0.0480", state: "settled" },
      { runId: run!.id, kind: "image", target: engineIds[0]!, cellId: cells.find((c) => c.engineId === engineIds[0])!.id, boundUsd: "0.0600", state: "reserved" },
      { runId: run!.id, kind: "image", target: engineIds[1]!, boundUsd: "0.0700", state: "released" },
      { runId: run!.id, kind: "planner", target: "gpt-5.5", panelId: panels[0]!.id, boundUsd: "0.7680", settledUsd: "0.7680", state: "settled" },
    ]);

    const res = await request(app()).get(`/api/admin/comparison/results?setIds=${setId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body;
    assert.deepEqual(r.panels, { total: 2, judged: 2, judgeable: 2, skipped: 0, lost: 0 });
    assert.deepEqual(r.scores.overall, { [FAMILIES.flux]: { mean: 4.5, count: 2 }, [FAMILIES.gpt]: { mean: 3.5, count: 2 } });
    assert.deepEqual(r.scores.byMode, {
      t2i: { [FAMILIES.flux]: { mean: 5, count: 1 }, [FAMILIES.gpt]: { mean: 3, count: 1 } },
      i2i: { [FAMILIES.flux]: { mean: 4, count: 1 }, [FAMILIES.gpt]: { mean: 4, count: 1 } },
    });
    assert.deepEqual(r.scores.byStyle, { none: { [FAMILIES.flux]: { mean: 4.5, count: 2 }, [FAMILIES.gpt]: { mean: 3.5, count: 2 } } });
    assert.deepEqual(r.leaders.t2i, { families: [FAMILIES.flux], pictures: [1], mean: 5, judged: 1 });
    assert.deepEqual(r.leaders.i2i, { families: [FAMILIES.flux, FAMILIES.gpt].sort(), pictures: [1, 1], mean: 4, judged: 1 }, "an equal average is a tie");
    assert.deepEqual(r.faceMismatches, { [FAMILIES.gpt]: 1 });
    assert.equal(r.humanReferencePanelsJudged, 1);
    assert.deepEqual(r.costs[fluxT2i], { family: FAMILIES.flux, calls: 1, boundUsd: 0.048 });
    assert.deepEqual(r.costs[engineIds[0]!], { family: FAMILIES.gpt, calls: 1, boundUsd: 0.06 }, "a call held after a failure may have been billed, so it counts");
    assert.equal(r.costs[engineIds[1]!], undefined, "a released call never reached fal");
    assert.equal(r.preparationBoundUsd, 0.768);
    // Stage 2: each mode's engines in score order, with what one image costs.
    assert.deepEqual(r.ranking.t2i, [
      { rank: 1, family: FAMILIES.flux, engineId: engineIds[2]!, mean: 5, scored: 1, lost: 0, usdPerImage: 0.048, exact: true, billedUsdPerImage: null, billedMinUsd: null, billedMaxUsd: null, billedTotalUsd: null, billed: 0, medianSeconds: 10, slowestSeconds: 10, timed: 1 },
      { rank: 2, family: FAMILIES.gpt, engineId: engineIds[0]!, mean: 3, scored: 1, lost: 0, usdPerImage: 0.058, exact: false, billedUsdPerImage: null, billedMinUsd: null, billedMaxUsd: null, billedTotalUsd: null, billed: 0, medianSeconds: 120, slowestSeconds: 120, timed: 1 },
    ], "a flat price is exact; a token price shows its typical figure, marked approximate; each engine's render time beside it");
    assert.ok(r.ranking.i2i.every((row: { medianSeconds: number | null; timed: number }) => row.medianSeconds === null && row.timed === 0), "an untimed engine shows no time");
    assert.deepEqual(r.ranking.i2i.map((row: { rank: number; usdPerImage: number; exact: boolean }) => [row.rank, row.usdPerImage, row.exact]).sort(), [
      [1, 0.048, true],
      [1, 0.066, false],
    ], "engines with the same average share a rank");
    assert.ok(r.perPanel.every((p: { ratings: unknown[] }) => p.ratings.length === 2));

    const two = await request(app()).get(`/api/admin/comparison/results?setIds=${setId},${setId}`);
    assert.equal(two.status, 200, "a repeated id reads once");
    const unknown = await request(app()).get(`/api/admin/comparison/results?setIds=${setId},2000000000`);
    assert.equal(unknown.status, 404);
    const bad = await request(app()).get(`/api/admin/comparison/results?setIds=x`);
    assert.equal(bad.status, 400);
  });
});

// ─── The second judging edition (plan PLAN_PROMPT_TUNER.md, *Proposed Design* B and C) ───

type V2Panel = { panelId: number; scenarioKey: string; categories: string[]; images: Array<{ token: string }>; gag: string | null; factText: string; prompt: string | null; judgement: unknown };

/** Every picture of a blind panel scored `score` on each category the panel asks. */
function scoreAll(panel: V2Panel, score: number | ((token: string) => number)) {
  return panel.images.map((i) => ({ token: i.token, ...Object.fromEntries(panel.categories.map((k) => [k, typeof score === "number" ? score : score(i.token)])) }));
}

async function v2Blind(setId: number): Promise<{ body: { set: { judgingEdition: number }; progress: { judged: number }; panels: V2Panel[] }; t2i: V2Panel; i2i: V2Panel }> {
  const res = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return {
    body: res.body,
    t2i: res.body.panels.find((p: V2Panel) => p.scenarioKey === "generic_t2i"),
    i2i: res.body.panels.find((p: V2Panel) => p.scenarioKey === "i2i_male_default"),
  };
}

describe("second edition: what a panel is judged against", () => {
  it("a new set is judged on the second edition; its panels show the frozen fact and gag, never the prompt, and a later edit to the fact changes nothing", async () => {
    const { setId, panels } = await renderedSet("v2-frozen", { edition: 2 });
    const [set] = await db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.id, setId));
    assert.equal(set!.judgingEdition, 2, "every set made from now on");
    for (const p of panels) {
      await db.update(comparisonPanelsTable).set({ frozenFactText: "Alex lifts a mountain", frozenGag: "Alex holds a mountain overhead like a barbell", compiledPrompt: { imagePrompt: "SECRET PROMPT TEXT" } }).where(eq(comparisonPanelsTable.id, p.id));
    }
    await db.update(factsTable).set({ text: `${P} {NAME} was edited after preparation` }).where(eq(factsTable.id, factId));
    try {
      const { body, t2i, i2i } = await v2Blind(setId);
      assert.equal(body.set.judgingEdition, 2);
      for (const p of [t2i, i2i]) {
        assert.equal(p.factText, "Alex lifts a mountain", "the wording frozen at preparation, not the live row");
        assert.equal(p.gag, "Alex holds a mountain overhead like a barbell");
        assert.equal(p.prompt, null, "a second-edition panel never shows the prompt");
      }
      assert.ok(!JSON.stringify(body).includes("SECRET PROMPT TEXT"), "no prompt text anywhere in the payload");
      assert.deepEqual(t2i.categories, ["visualQuality", "gagFidelity", "realism"], "no photo, no style: three categories");
      assert.deepEqual(i2i.categories, ["visualQuality", "gagFidelity", "realism", "likeness"], "a supplied photo asks Likeness");
    } finally {
      await db.update(factsTable).set({ text: `${P} {NAME} lifts a mountain` }).where(eq(factsTable.id, factId));
    }
  });

  it("freezes the fact's wording and its approved gag, rendered for the panel's subject", () => {
    const subject = { name: "Alex Franklin", pronouns: "they/them" };
    assert.deepEqual(
      frozenJudgingReference("Alex Franklin lifts a mountain", { visualPromptStrategyOverride: { coreSceneOverride: "  {NAME} holds a mountain overhead  " } }, subject),
      { frozenFactText: "Alex Franklin lifts a mountain", frozenGag: "Alex Franklin holds a mountain overhead" },
    );
    assert.deepEqual(frozenJudgingReference("x", {}, subject), { frozenFactText: "x", frozenGag: null }, "no approved gag freezes null");
  });

  it("a styled panel asks Style interpretation", async () => {
    await db.insert(lookStylesTable).values({ id: `${STYLE}-v2`, label: "Judging test look v2", promptSuffix: "test look" });
    try {
      const { setId } = await renderedSet("v2-styled", { edition: 2, lookStyleIds: [`${STYLE}-v2`] });
      const { t2i, i2i } = await v2Blind(setId);
      assert.deepEqual(t2i.categories, ["visualQuality", "gagFidelity", "realism", "styleInterpretation"]);
      assert.deepEqual(i2i.categories, ["visualQuality", "gagFidelity", "realism", "styleInterpretation", "likeness"]);
    } finally {
      await db.delete(lookStylesTable).where(eq(lookStylesTable.id, `${STYLE}-v2`));
    }
  });
});

describe("second edition: a judgement", () => {
  it("needs every picture scored on exactly the panel's categories, one pick from the pictures shown, and broken marks only on them", async () => {
    const { setId } = await renderedSet("v2-validate", { edition: 2 });
    const { i2i, t2i } = await v2Blind(setId);
    const send = (panelId: number, body: object) => request(app()).post(pickPath(panelId)).send(body);
    const best = i2i.images[0]!.token;

    const noLikeness = await send(i2i.panelId, { scores: scoreAll(t2i, 4).map((s, n) => ({ ...s, token: i2i.images[n]!.token })), bestToken: best });
    assert.equal(noLikeness.status, 409);
    assert.match(noLikeness.body.refusal, /likeness/);
    const extraLikeness = await send(t2i.panelId, { scores: scoreAll(t2i, 4).map((s) => ({ ...s, likeness: 3 })), bestToken: t2i.images[0]!.token });
    assert.equal(extraLikeness.status, 409, "Likeness is not asked without a photo");
    const partial = await send(i2i.panelId, { scores: scoreAll(i2i, 4).slice(0, 1), bestToken: best });
    assert.equal(partial.status, 409);
    assert.match(partial.body.refusal, /1 of 2/);
    const foreignPick = await send(i2i.panelId, { scores: scoreAll(i2i, 4), bestToken: t2i.images[0]!.token });
    assert.equal(foreignPick.status, 409, "the pick must be one of this panel's pictures");
    const foreignBroken = await send(i2i.panelId, { scores: scoreAll(i2i, 4), bestToken: best, brokenTokens: [t2i.images[0]!.token] });
    assert.equal(foreignBroken.status, 409, "a broken mark must name one of this panel's pictures");
    assert.match(foreignBroken.body.refusal, /broken mark/);
    const noPick = await send(i2i.panelId, { scores: scoreAll(i2i, 4) });
    assert.equal(noPick.status, 400, "a judgement without a pick is incomplete");
    const firstEditionBody = await send(i2i.panelId, { ratings: i2i.images.map((i) => ({ token: i.token, score: 3 })) });
    assert.equal(firstEditionBody.status, 409, "a one-score judgement is refused on a second-edition set");
    const outOfRange = await send(i2i.panelId, { scores: scoreAll(i2i, 6), bestToken: best });
    assert.equal(outOfRange.status, 400);

    const ok = await send(i2i.panelId, { scores: scoreAll(i2i, 4), bestToken: best, brokenTokens: [i2i.images[1]!.token] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const again = await send(i2i.panelId, { scores: scoreAll(i2i, 2), bestToken: i2i.images[1]!.token });
    assert.equal(again.status, 200);
    const [row] = await db.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, i2i.panelId));
    const history = row!.history as Array<{ categoryScores: unknown[]; pickedCellId: number; brokenCellIds: number[] }>;
    assert.equal(history.length, 1, "re-judging keeps the earlier judgement");
    assert.equal(history[0]!.brokenCellIds.length, 1);
    assert.equal((row!.categoryScores as unknown[]).length, 2);
    assert.deepEqual(row!.brokenCellIds, []);
    assert.deepEqual(row!.ratings, [], "no first-edition score is written");

    const reread = await v2Blind(setId);
    const saved = reread.i2i.judgement as { scores: Record<string, Record<string, number>>; bestToken: string; brokenTokens: string[] };
    assert.equal(saved.bestToken, i2i.images[1]!.token);
    assert.deepEqual(saved.scores[best], { visualQuality: 2, gagFidelity: 2, realism: 2, likeness: 2 });
    assert.equal(reread.body.progress.judged, 1);
    assert.equal(reread.i2i && (reread.body.panels.find((p) => p.panelId === i2i.panelId) as unknown as { pick: unknown }).pick, null, "no first-edition pick on a second-edition panel");
  });

  it("a first-edition set refuses a second-edition judgement", async () => {
    const { setId } = await renderedSet("v1-refuses-v2");
    const res = await request(app()).get(`/api/admin/comparison/sets/${setId}/judging`);
    const panel = res.body.panels[0];
    assert.deepEqual(panel.categories, []);
    const refused = await request(app()).post(pickPath(panel.panelId)).send({ scores: panel.images.map((i: { token: string }) => ({ token: i.token, visualQuality: 3, gagFidelity: 3, realism: 3 })), bestToken: panel.images[0].token });
    assert.equal(refused.status, 409);
  });
});

describe("second edition: results", () => {
  it("per engine and mode: pick share over every judged panel it was on, each category's average with a lost picture as 1, broken and lost counts", async () => {
    const { setId, cells } = await renderedSet("v2-results", { edition: 2, missingT2i: true });
    const lostCell = cells.find((c) => c.engineId.startsWith(FAMILIES.flux) && c.engineId.endsWith("-t2i"))!;
    await db.update(comparisonCellsTable).set({ state: "failed", rerunCount: 1 }).where(eq(comparisonCellsTable.id, lostCell.id));
    const { t2i, i2i } = await v2Blind(setId);
    assert.equal(t2i.images.length, 1, "the lost picture is not shown, so it can never be the pick");

    // t2i: gpt's picture alone, scored 4, picked. i2i: both scored; flux picked and gpt marked broken.
    const tokenOfFamily = async (panelId: number, family: string) => {
      const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId));
      const { blindToken } = await import("../lib/comparison/blindToken.js");
      return blindToken(panel!, cells.find((c) => c.panelId === panelId && c.engineId.startsWith(family))!.id);
    };
    const gptI2i = await tokenOfFamily(i2i.panelId, FAMILIES.gpt);
    const fluxI2i = await tokenOfFamily(i2i.panelId, FAMILIES.flux);
    assert.equal((await request(app()).post(pickPath(t2i.panelId)).send({ scores: scoreAll(t2i, 4), bestToken: t2i.images[0]!.token })).status, 200);
    assert.equal((await request(app()).post(pickPath(i2i.panelId)).send({ scores: scoreAll(i2i, (tok) => (tok === fluxI2i ? 5 : 2)), bestToken: fluxI2i, brokenTokens: [gptI2i] })).status, 200);

    const res = await request(app()).get(`/api/admin/comparison/results?setIds=${setId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.edition, 2);
    assert.deepEqual(res.body.panels, { total: 2, judged: 2, judgeable: 2, skipped: 0, lost: 0 });
    const row = (mode: string, family: string) => (res.body.rows[mode] as Array<Record<string, unknown> & { family: string }>).find((r) => r.family === family)!;
    const fluxT2i = row("t2i", FAMILIES.flux);
    assert.deepEqual([fluxT2i.panels, fluxT2i.picked, fluxT2i.pickShare, fluxT2i.scored, fluxT2i.lost], [1, 0, 0, 0, 1], "a lost picture stays in the pick share's denominator");
    assert.deepEqual((fluxT2i.categories as Record<string, unknown>).gagFidelity, { mean: 1, count: 1 }, "and counts as 1 in every category asked (David, 2026-11-10)");
    assert.deepEqual((fluxT2i.categories as Record<string, unknown>).likeness, { mean: null, count: 0 }, "never asked without a photo");
    const gptT2i = row("t2i", FAMILIES.gpt);
    assert.deepEqual([gptT2i.panels, gptT2i.picked, gptT2i.pickShare], [1, 1, 1]);
    assert.equal((res.body.rows.t2i as Array<{ family: string }>)[0]!.family, FAMILIES.gpt, "ordered by pick share");
    const gptI2iRow = row("i2i", FAMILIES.gpt);
    assert.deepEqual([gptI2iRow.picked, gptI2iRow.broken], [0, 1]);
    assert.deepEqual((gptI2iRow.categories as Record<string, unknown>).likeness, { mean: 2, count: 1 });
    assert.deepEqual((row("i2i", FAMILIES.flux).categories as Record<string, unknown>).visualQuality, { mean: 5, count: 1 });

    const old = await renderedSet("v2-results-old");
    const mixed = await request(app()).get(`/api/admin/comparison/results?setIds=${setId},${old.setId}`);
    assert.equal(mixed.status, 409, "the two editions are never averaged together");
    const oldOnly = await request(app()).get(`/api/admin/comparison/results?setIds=${old.setId}`);
    assert.equal(oldOnly.body.edition, 1, "a first-edition set still reads its own results");
  });
});

describe("median", () => {
  it("is the middle value, or the mean of the two middle values", () => {
    assert.equal(median([30, 10, 20]), 20);
    assert.equal(median([40, 10, 30, 20]), 25);
    assert.equal(median([7]), 7);
  });
});
