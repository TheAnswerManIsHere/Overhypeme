// Launch Phase 8, increment 2a: the comparison's layout and run admission
// (plan PLAN_PHASE8_ENGINE_EVALUATION.md, *Proposed Design* C and D). Pure —
// no database. The counts asserted are the plan's: round 1 is 15 panels and 90
// cells, round 2 is 18 panels and 108, 33 and 198 together. Since every picture
// starts from a photo (compiler review, Phase 2) round 1 drops its no-photo
// scenario: 12 panels and 72 cells; since people and pets only (Issue #964)
// it also drops the object/vehicle scenario: 9 panels and 54 cells.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { COMPARISON_DEFAULT_FAMILIES, COMPARISON_ROUND_PRESETS } from "@workspace/api-zod";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { toEngineRecord } from "../lib/engines/engineRecord.js";
import { ComparisonLayoutError, deriveComparisonLayout } from "../lib/comparison/layout.js";
import { cellBoundUsd, planRun, type WorkItem } from "../lib/comparison/admission.js";

const catalogue = ALL_ENGINES.filter((e) => e.kind === "image").map((e) => toEngineRecord(e));

function round(n: 1 | 2) {
  const p = COMPARISON_ROUND_PRESETS[n];
  return { factIds: [1, 2, 3], scenarioKeys: [...p.scenarioKeys], lookStyleIds: [...p.lookStyleIds], engineFamilies: [...COMPARISON_DEFAULT_FAMILIES] };
}

describe("comparison layout", () => {
  it("round 1 is 9 photo panels and 54 cells", () => {
    const panels = deriveComparisonLayout(round(1), catalogue);
    assert.equal(panels.length, 9);
    assert.equal(panels.reduce((s, p) => s + p.engineIds.length, 0), 54);
    assert.ok(panels.every((p) => p.imageMode === "i2i"), "no picture without a photo");
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
    const unpriced = catalogue.map((e) => (e.id === "muse-image-edit" ? { ...e, priceModel: null } : e));
    assert.throws(() => deriveComparisonLayout(round(1), unpriced), /muse-image-edit: it has no price model/);
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

  it("an engine without a price model has no bound", () => {
    assert.throws(() => cellBoundUsd(null), /never admitted/);
  });

  // David, 2026-11-07: "Ignore pricing entirely." No allowance or week limits a run.
  it("takes every pending item, with no allowance or week limit, and records the worst case", () => {
    const plan = planRun(items(15, 0.5, "cell"));
    assert.equal(plan.admitted, true);
    assert.equal(plan.items.length, 15);
    assert.ok(Math.abs(plan.boundUsd - 7.5) < 1e-9, String(plan.boundUsd)); // 15 × 0.5, above the old $5
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
