// The launch Phase 8 candidates (plan PLAN_PHASE8_ENGINE_EVALUATION.md,
// *Settled Decisions*: "Each candidate is a pair of engine definitions" and
// "Every candidate carries a complete per-call bound ... an engine without
// one is not dispatched to"). The figures asserted are the plan's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ALL_ENGINES, perCallBoundUsd, type EngineDefinition } from "../lib/engines";
import { buildEngineInput } from "../lib/engineInterpreter";
import { buildImageRequestSettings } from "../lib/imageRequestBuilder";
import type { Engine } from "../lib/engines/engineRecord.js";

const CANDIDATE_FAMILIES = ["gpt-image-2-6", "gpt-image-2-5", "nano-banana-2-1", "flux-3", "seedream-5-pro", "muse-image", "nano-banana-2"];

function family(name: string): EngineDefinition[] {
  return ALL_ENGINES.filter((e) => e.family === name);
}

function byId(id: string): EngineDefinition {
  const def = ALL_ENGINES.find((e) => e.id === id);
  assert.ok(def, id);
  return def;
}

describe("candidate families", () => {
  for (const name of CANDIDATE_FAMILIES) {
    it(`${name} is one text-to-image and one edit definition, each sized and priced`, () => {
      const members = family(name);
      assert.deepEqual(members.map((e) => e.imageMode).sort(), ["i2i", "t2i"]);
      for (const e of members) {
        assert.equal(e.kind, "image");
        assert.ok(e.sizeVocabulary && e.sizeVocabulary.options.length > 0, `${e.id} size vocabulary`);
        assert.ok(e.priceModel, `${e.id} price model`);
        assert.ok(e.priceModel.source && /^\d{4}-\d{2}-\d{2}$/.test(e.priceModel.readOn), `${e.id} price source`);
      }
    });
  }

  it("every edit definition requires a reference image", () => {
    const edits = ALL_ENGINES.filter((d) => CANDIDATE_FAMILIES.includes(d.family ?? "") && d.imageMode === "i2i");
    assert.equal(edits.length, CANDIDATE_FAMILIES.length);
    for (const e of edits) {
      const size = buildImageRequestSettings(e, "comparison", "portrait").sizeParams;
      const params = { imagePrompt: "p", aspectRatio: "portrait", numImages: 1, ...size };
      assert.throws(() => buildEngineInput(e as unknown as Engine, params), /referenceImageUrl|image_urls|image_url/, e.id);
    }
  });
});

describe("per-call bounds at the comparison settings match the plan", () => {
  // [engine, plan figure, tolerance]
  const cases: Array<[string, number, number]> = [
    ["gpt-image-2-5", 0.073, 0.0005],
    ["gpt-image-2-5-edit", 0.089, 0.0005],
    // 2.6: 2.5's components plus a reasoning allowance of 4,000 tokens at $10/M.
    ["gpt-image-2-6", 0.113, 0.0005],
    ["gpt-image-2-6-edit", 0.129, 0.0005],
    ["nano-banana-2-1", 0.34, 0.02],
    ["nano-banana-2-1-edit", 0.34, 0.02],
    ["flux-3", 0.048, 0],
    ["flux-3-edit", 0.048, 0],
    ["seedream-5-pro", 0.0675, 0],
    ["seedream-5-pro-edit", 0.072, 0],
    ["muse-image", 0.01, 0],
    ["muse-image-edit", 0.01, 0],
    ["nano-banana-2", 0.08, 0],
    ["nano-banana-2-edit", 0.08, 0],
  ];
  for (const [id, figure, tol] of cases) {
    it(`${id} is about $${figure}`, () => {
      const def = byId(id);
      assert.ok(def.priceModel, id);
      const bound = perCallBoundUsd(def.priceModel);
      assert.ok(Math.abs(bound - figure) <= tol + 1e-9, `${id}: bound ${bound.toFixed(4)} vs plan ${figure}`);
      // A bound is never below the realistic per-call figure.
      assert.ok(bound >= (def.estimatedCostUsdPerCall ?? 0) - 1e-9, `${id}: bound below the realistic figure`);
    });
  }

  it("the GPT edit's reference-image charge is marked as a measurement (D2)", () => {
    const model = byId("gpt-image-2-5-edit").priceModel;
    assert.ok(model && model.kind === "tokens");
    assert.deepEqual(model.components.filter((c) => c.measured).map((c) => c.name), ["reference image (image input)"]);
  });
});

describe("sizes the endpoints accept", () => {
  it("GPT Image 2.5 and Seedream pixel sizes satisfy their documented constraints", () => {
    for (const id of ["gpt-image-2-5", "seedream-5-pro"]) {
      for (const o of byId(id).sizeVocabulary!.options) {
        const [w, h] = String(o.params["imageSize"]).split("x").map(Number) as [number, number];
        const area = w * h;
        if (id === "gpt-image-2-5") {
          assert.ok(w % 16 === 0 && h % 16 === 0, `${id} ${w}x${h} multiples of 16`);
          assert.ok(area >= 655_360 && area <= 8_294_400, `${id} ${w}x${h} area`);
          assert.ok(Math.max(w, h) <= 3840 && Math.max(w, h) / Math.min(w, h) <= 3, `${id} ${w}x${h} edge and ratio`);
        } else {
          assert.ok(area >= 921_600 && area <= 4_624_220, `${id} ${w}x${h} area`);
        }
        assert.ok(Math.abs(area / 1e6 - o.megapixels) < 0.02, `${id} ${w}x${h} megapixels label`);
      }
    }
  });

  it("a pixel size reaches fal as a {width, height} object", () => {
    const def = byId("gpt-image-2-5");
    const s = buildImageRequestSettings(def, "comparison", "portrait");
    const input = buildEngineInput(def as unknown as Engine, { imagePrompt: "p", aspectRatio: "portrait", ...s.sizeParams });
    assert.deepEqual(input["image_size"], { width: 768, height: 1360 });
    assert.equal(input["quality"], "high");
  });

  it("GPT Image 2.6 sends high reasoning at high quality, sized like 2.5", () => {
    for (const id of ["gpt-image-2-6", "gpt-image-2-6-edit"]) {
      const def = byId(id);
      const s = buildImageRequestSettings(def, "comparison", "portrait");
      const params: Record<string, unknown> = { imagePrompt: "p", aspectRatio: "portrait", ...s.sizeParams };
      if (def.imageMode === "i2i") params["referenceImageUrl"] = "https://example.com/r.jpg";
      const input = buildEngineInput(def as unknown as Engine, params);
      assert.equal(input["reasoning_effort"], "high", id);
      assert.equal(input["quality"], "high", id);
      assert.deepEqual(input["image_size"], { width: 768, height: 1360 }, id);
    }
  });

  it("Nano Banana 2.1 previews at 1K (it has no 0.5K) and thinks at medium", () => {
    const def = byId("nano-banana-2-1");
    const s = buildImageRequestSettings(def, "preview", "square");
    assert.deepEqual(s.sizeParams, { resolution: "1K" });
    const input = buildEngineInput(def as unknown as Engine, { imagePrompt: "p", aspectRatio: "square", ...s.sizeParams });
    assert.equal(input["thinking_level"], "medium");
  });
});
