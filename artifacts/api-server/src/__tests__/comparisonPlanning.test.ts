// Launch Phase 8, increment 2a: the comparison's layout and run admission
// (plan PLAN_PHASE8_ENGINE_EVALUATION.md, *Proposed Design* C and D). Pure —
// no database. The counts asserted are the plan's: round 1 is 15 panels and 90
// cells, round 2 is 18 panels and 108, 33 and 198 together.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { COMPARISON_DEFAULT_FAMILIES, COMPARISON_ROUND_PRESETS } from "@workspace/api-zod";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { toEngineRecord } from "../lib/engines/engineRecord.js";
import { ComparisonLayoutError, deriveComparisonLayout } from "../lib/comparison/layout.js";
import { cellBoundUsd, panelPreparationBoundUsd, planRun, type WorkItem } from "../lib/comparison/admission.js";

const catalogue = ALL_ENGINES.filter((e) => e.kind === "image").map((e) => toEngineRecord(e));

function round(n: 1 | 2) {
  const p = COMPARISON_ROUND_PRESETS[n];
  return { factIds: [1, 2, 3], scenarioKeys: [...p.scenarioKeys], lookStyleIds: [...p.lookStyleIds], engineFamilies: [...COMPARISON_DEFAULT_FAMILIES] };
}

describe("comparison layout", () => {
  it("round 1 is 15 panels and 90 cells", () => {
    const panels = deriveComparisonLayout(round(1), catalogue);
    assert.equal(panels.length, 15);
    assert.equal(panels.reduce((s, p) => s + p.engineIds.length, 0), 90);
  });

  it("round 2 is 18 panels and 108 cells", () => {
    const panels = deriveComparisonLayout(round(2), catalogue);
    assert.equal(panels.length, 18);
    assert.equal(panels.reduce((s, p) => s + p.engineIds.length, 0), 108);
  });

  it("every cell's engine is of its family and the panel's mode", () => {
    for (const p of deriveComparisonLayout(round(1), catalogue)) {
      p.engineIds.forEach((id, i) => {
        const e = catalogue.find((c) => c.id === id)!;
        assert.equal(e.family, COMPARISON_DEFAULT_FAMILIES[i]);
        assert.equal(e.imageMode, p.imageMode);
      });
    }
  });

  it("a family that is not one engine per mode is refused, never dropped", () => {
    const withoutEdit = catalogue.filter((e) => e.id !== "flux-3-edit");
    assert.throws(() => deriveComparisonLayout(round(1), withoutEdit), (err: unknown) =>
      err instanceof ComparisonLayoutError && err.reasons.some((r) => /flux-3.*0 i2i/.test(r)));
  });

  it("an engine without a price model, or inactive, is refused with the reason", () => {
    const unpriced = catalogue.map((e) => (e.id === "muse-image" ? { ...e, priceModel: null } : e));
    assert.throws(() => deriveComparisonLayout(round(1), unpriced), /muse-image: it has no price model/);
    const inactive = catalogue.map((e) => (e.id === "seedream-5-pro-edit" ? { ...e, isActive: false } : e));
    assert.throws(() => deriveComparisonLayout(round(1), inactive), /seedream-5-pro-edit: it is inactive/);
  });

  it("an unknown scenario is refused", () => {
    assert.throws(() => deriveComparisonLayout({ ...round(1), scenarioKeys: ["nope" as never] }, catalogue), /unknown scenario "nope"/);
  });
});

describe("run admission", () => {
  const items = (n: number, bound: number, prefix = "cell"): WorkItem[] =>
    Array.from({ length: n }, (_, i) => ({ ref: `${prefix}:${i}`, label: `${prefix} ${i}`, boundUsd: bound }));

  // The shipped planner: gpt-5.5, 2,800 visible tokens, temperature 0.4.
  const SHIPPED = { model: "gpt-5.5", maxTokens: 2800, temperature: 0.4 };

  it("a panel's preparation reserves two planner calls at the ceiling the request sends ($0.768)", () => {
    // (2,800 + 8,000 reasoning headroom) × $30/M + 12,000 input × $5/M = $0.384 a call.
    assert.ok(Math.abs(panelPreparationBoundUsd(SHIPPED) - 0.768) < 1e-9, String(panelPreparationBoundUsd(SHIPPED)));
  });

  it("a raised planner token ceiling raises the bound", () => {
    const raised = { ...SHIPPED, maxTokens: 6000 };
    assert.ok(Math.abs(panelPreparationBoundUsd(raised) - 0.96) < 1e-9, String(panelPreparationBoundUsd(raised)));
  });

  it("a planner request without reasoning headroom is priced from its own ceiling", () => {
    // GPT-6 at reasoning effort "none" sends max_completion_tokens = maxTokens, no headroom.
    const bound = panelPreparationBoundUsd({ model: "gpt-6-luna", maxTokens: 512, temperature: 0.4, reasoningEffort: "none" });
    assert.ok(Math.abs(bound - 2 * (512 * 0.5 + 12_000 * 0.1) / 1_000_000) < 1e-12, String(bound));
  });

  it("a planner model with no price refuses rather than guessing", () => {
    assert.throws(() => panelPreparationBoundUsd({ ...SHIPPED, model: "no-such-model" }), /no price for the planner model "no-such-model"/);
  });

  it("an engine without a price model has no bound", () => {
    assert.throws(() => cellBoundUsd(null), /never admitted/);
  });

  // David, 2026-11-07: "Ignore pricing entirely." No allowance or week limits a run.
  it("takes every pending item, with no allowance or week limit, and records the worst case", () => {
    const plan = planRun(items(15, panelPreparationBoundUsd(SHIPPED), "panel"));
    assert.equal(plan.admitted, true);
    assert.equal(plan.items.length, 15);
    assert.ok(Math.abs(plan.boundUsd - 11.52) < 1e-9, String(plan.boundUsd)); // 15 × 0.768, above the old $5
    const big = planRun([{ ref: "cell:1", label: "rendering cell 1 (x)", boundUsd: 6 }]);
    assert.equal(big.admitted, true, "an item above the old $5 allowance is no longer refused");
  });

  it("nothing pending is not a run", () => {
    const plan = planRun([]);
    assert.equal(plan.admitted, false);
    assert.equal(plan.refusal, "nothing left to do");
  });

  it("rounds 1 and 2 render within the plan's figure at the candidates' bounds", () => {
    const total = [1, 2].flatMap((n) => deriveComparisonLayout(round(n as 1 | 2), catalogue))
      .flatMap((p) => p.engineIds)
      .reduce((s, id) => s + cellBoundUsd(catalogue.find((e) => e.id === id)!.priceModel), 0);
    // Six families' bounds sum to about $0.67 per t2i panel and $0.69 per i2i panel.
    assert.ok(total > 15 && total < 30, `rounds 1–2 image bound $${total.toFixed(2)}`);
  });
});
