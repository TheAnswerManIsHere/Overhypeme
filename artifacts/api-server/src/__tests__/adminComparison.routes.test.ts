// Launch Phase 8, increment 2a: the comparison's admin routes against the test
// database (plan PLAN_PHASE8_ENGINE_EVALUATION.md, *Admin/User UX Impact*).
// Seeds two engine families under the `t-cmp-` prefix (a t2i and an edit
// definition each, copied from real candidates so their price models are
// real), one fact, and an admin. Planning spends nothing and calls nothing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { comparisonSetsTable, factsTable, lookStylesTable, usersTable } from "@workspace/db/schema";
import { inArray, like } from "drizzle-orm";

import adminComparisonRouter from "../routes/adminComparison.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { panelPreparationBoundUsd } from "../lib/comparison/admission.js";
import { DEFAULT_IMAGE_PROMPT_ENGINE_ID } from "../lib/imagePromptConfig.js";
import { clearTestEngineDefinitions } from "../lib/engineInterpreter.js";
import { testEngineRow } from "./helpers/testEngines.js";

const P = `t-cmp-${randomUUID().slice(0, 6)}`;
const FAMILIES = [`${P}-gpt`, `${P}-flux`];
const SOURCES: Record<string, [string, string]> = {
  [FAMILIES[0]!]: ["gpt-image-2-5", "gpt-image-2-5-edit"],
  [FAMILIES[1]!]: ["flux-3", "flux-3-edit"],
};
/** Seeded here: a test database carries no look styles of its own. */
const STYLE = `${P}-style`;
const engineIds: string[] = [];
let adminId = "";
let userId = "";
let factId = 0;

before(async () => {
  for (const family of FAMILIES) {
    for (const src of SOURCES[family]!) {
      const def = ALL_ENGINES.find((e) => e.id === src)!;
      const id = `${family}-${def.imageMode}`;
      testEngineRow(def, id, family);
      engineIds.push(id);
    }
  }
  await db.insert(lookStylesTable).values({ id: STYLE, label: "Comparison test look", promptSuffix: "test look" });
  adminId = `${P}-admin`;
  userId = `${P}-user`;
  await db.insert(usersTable).values([
    { id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true },
    { id: userId, email: `${userId}@test.local`, membershipTier: "registered", isAdmin: false },
  ]);
  const [fact] = await db.insert(factsTable).values({ text: `${P} fact`, isActive: false }).returning({ id: factsTable.id });
  factId = fact!.id;
});

after(async () => {
  await db.delete(comparisonSetsTable).where(like(comparisonSetsTable.label, `${P}%`));
  await db.delete(factsTable).where(inArray(factsTable.id, [factId]));
  await db.delete(lookStylesTable).where(inArray(lookStylesTable.id, [STYLE]));
  clearTestEngineDefinitions();
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, userId]));
});

const body = (over: Record<string, unknown> = {}) => ({
  label: `${P} set`,
  round: 1,
  factIds: [factId],
  scenarioKeys: ["generic_t2i", "i2i_male_default"],
  lookStyleIds: ["none", STYLE],
  engineFamilies: FAMILIES,
  ...over,
});

describe("admin comparison routes", () => {
  it("are admin-only", async () => {
    const anon = buildTestApp({ kind: "unauthenticated" }, adminComparisonRouter);
    const user = buildTestApp({ kind: "authenticated", userId }, adminComparisonRouter);
    for (const app of [anon, user]) {
      assert.ok([401, 403].includes((await request(app).get("/api/admin/comparison/sets")).status));
      assert.ok([401, 403].includes((await request(app).post("/api/admin/comparison/sets").send(body())).status));
    }
  });

  it("creates a set's panels and expected cells, and reports them at both altitudes", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);
    const created = await request(app).post("/api/admin/comparison/sets").send(body());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual({ panels: created.body.panels, cells: created.body.cells }, { panels: 4, cells: 8 });

    const detail = await request(app).get(`/api/admin/comparison/sets/${created.body.setId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.aggregate.panels.pending, 4);
    assert.equal(detail.body.aggregate.cells.expected, 8);
    const modes = detail.body.panels.map((p: { scenarioKey: string; imageMode: string; cells: Array<{ engineId: string }> }) => [p.scenarioKey, p.imageMode, p.cells.map((c) => c.engineId).sort()]);
    for (const [scenario, mode, cells] of modes) {
      assert.equal(mode, scenario === "generic_t2i" ? "t2i" : "i2i");
      assert.deepEqual(cells, FAMILIES.map((f) => `${f}-${mode}`).sort());
    }
    assert.ok(Math.abs(detail.body.estimate.preparationBoundUsd - 4 * panelPreparationBoundUsd({ model: "gpt-5.5", maxTokens: 2800, temperature: 0.4 })) < 1e-3);

    const list = await request(app).get("/api/admin/comparison/sets");
    assert.ok(list.body.sets.some((s: { id: number; cells: number }) => s.id === created.body.setId && s.cells === 8));
  });

  it("plans a preparation run of every pending panel, with no week figure", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);
    const created = await request(app).post("/api/admin/comparison/sets").send(body({ label: `${P} plan` }));
    const ok = await request(app).post(`/api/admin/comparison/sets/${created.body.setId}/plan`).send({ kind: "prepare" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.admitted, true);
    assert.equal(ok.body.items.length, 4);

    const budgeted = await request(app).post(`/api/admin/comparison/sets/${created.body.setId}/plan`).send({ kind: "prepare", weekRemainingUsd: 1 });
    assert.equal(budgeted.status, 400, "the budget fields are gone (David, 2026-11-07)");

    // Nothing is prepared yet, so there is nothing to render.
    const render = await request(app).post(`/api/admin/comparison/sets/${created.body.setId}/plan`).send({ kind: "render" });
    assert.equal(render.body.admitted, false);
    assert.equal(render.body.refusal, "nothing left to do");
  });

  it("refuses preparation when the planner engine is inactive", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);
    const created = await request(app).post("/api/admin/comparison/sets").send(body({ label: `${P} planner` }));
    // Engines live only in code (decisions.md 2026-11-14), so the test flips the catalogue definition itself and restores it.
    const planner = ALL_ENGINES.find((e) => e.id === DEFAULT_IMAGE_PROMPT_ENGINE_ID)!;
    const original = planner.isActive;
    try {
      const before = await request(app).get(`/api/admin/comparison/sets/${created.body.setId}`);
      assert.equal(before.status, 200);

      planner.isActive = false;
      const refused = await request(app).post(`/api/admin/comparison/sets/${created.body.setId}/plan`).send({ kind: "prepare" });
      assert.equal(refused.status, 400);
      assert.ok(refused.body.reasons.some((r: string) => r.includes(`"${DEFAULT_IMAGE_PROMPT_ENGINE_ID}" cannot be used (engine_inactive)`)), JSON.stringify(refused.body));
    } finally {
      planner.isActive = original;
    }
  });

  it("refuses an allowance field, and a set naming an unknown family or fact", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminId }, adminComparisonRouter);
    const created = await request(app).post("/api/admin/comparison/sets").send(body({ label: `${P} refuse` }));
    const over = await request(app).post(`/api/admin/comparison/sets/${created.body.setId}/plan`).send({ kind: "prepare", allowanceUsd: 6 });
    assert.equal(over.status, 400);

    const badFamily = await request(app).post("/api/admin/comparison/sets").send(body({ label: `${P} bad`, engineFamilies: [`${P}-nope`] }));
    assert.equal(badFamily.status, 400);
    assert.ok(badFamily.body.reasons.some((r: string) => /has 0 t2i engines/.test(r)));

    const badFact = await request(app).post("/api/admin/comparison/sets").send(body({ label: `${P} bad`, factIds: [2_000_000_000] }));
    assert.equal(badFact.status, 400);
    assert.ok(badFact.body.reasons.some((r: string) => /unknown fact/.test(r)));
  });
});
