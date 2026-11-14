// The request builder maps (purpose, aspect, engine) to a size the endpoint
// itself accepts (launch Phase 8, plan PLAN_PHASE8_ENGINE_EVALUATION.md, A2).
// Replaces renderResolution.test.ts: on Nano Banana 2 a moderation preview is
// still 0.5K and a member's render still 2K.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RenderControls } from "@workspace/api-zod";
import { isEphemeralModerationRender, requestPurposeForRenderControls } from "../lib/imagePromptJobs";
import { buildImageRequestSettings, ImageRequestBuildError, type ImageRequestPurpose } from "../lib/imageRequestBuilder";
import { ALL_ENGINES } from "../lib/engines";
import { buildEngineInput } from "../lib/engineInterpreter";
import type { Engine } from "../lib/engines/toRow.js";

function controls(extra: Record<string, unknown> = {}): RenderControls {
  return { aspectRatio: "portrait", contentMode: "sfw", ...extra } as unknown as RenderControls;
}

const NB2 = ALL_ENGINES.find((e) => e.id === "nano-banana-2")!;
const NB2_EDIT = ALL_ENGINES.find((e) => e.id === "nano-banana-2-edit")!;

describe("request purpose from render controls", () => {
  it("an ephemeral moderation or eval render (mirrorToLegacyStorage:false) is a preview", () => {
    const rc = controls({ mirrorToLegacyStorage: false });
    assert.equal(isEphemeralModerationRender(rc), true);
    assert.equal(requestPurposeForRenderControls(rc), "preview");
  });
  it("a member's render (flag unset or true) is final", () => {
    assert.equal(requestPurposeForRenderControls(controls()), "final");
    assert.equal(requestPurposeForRenderControls(controls({ mirrorToLegacyStorage: true })), "final");
  });
});

describe("Nano Banana 2 keeps its sizes", () => {
  for (const engine of [NB2, NB2_EDIT]) {
    it(`${engine.id}: preview 0.5K, comparison 1K, final 2K`, () => {
      assert.deepEqual(buildImageRequestSettings(engine, "preview", "portrait").sizeParams, { resolution: "0.5K" });
      assert.deepEqual(buildImageRequestSettings(engine, "comparison", "square").sizeParams, { resolution: "1K" });
      assert.deepEqual(buildImageRequestSettings(engine, "final", "landscape").sizeParams, { resolution: "2K" });
    });
  }
});

describe("buildImageRequestSettings", () => {
  it("records engine, purpose, aspect and the chosen size", () => {
    const s = buildImageRequestSettings(NB2, "final", "portrait");
    assert.deepEqual(s, { engineId: "nano-banana-2", purpose: "final", aspectRatio: "portrait", sizeParams: { resolution: "2K" }, megapixels: 4 });
  });

  it("refuses an engine with no vocabulary, and an unknown aspect", () => {
    assert.throws(() => buildImageRequestSettings({ id: "x", sizeVocabulary: null }, "final", "portrait"), ImageRequestBuildError);
    assert.throws(() => buildImageRequestSettings(NB2, "final", "panorama"), ImageRequestBuildError);
  });

  it("picks only options for the requested aspect, nearest the target, the smaller on a tie", () => {
    const engine = {
      id: "dims",
      sizeVocabulary: {
        options: [
          { params: { imageSize: "a" }, megapixels: 0.5, aspect: "square" as const },
          { params: { imageSize: "b" }, megapixels: 2, aspect: "square" as const },
          { params: { imageSize: "c" }, megapixels: 1, aspect: "portrait" as const },
        ],
      },
    };
    // 0.5 and 2 are equally far from 1 on a log scale: the smaller wins.
    assert.deepEqual(buildImageRequestSettings(engine, "comparison", "square").sizeParams, { imageSize: "a" });
    assert.deepEqual(buildImageRequestSettings(engine, "comparison", "portrait").sizeParams, { imageSize: "c" });
    assert.throws(() => buildImageRequestSettings(engine, "final", "landscape"), ImageRequestBuildError);
  });
});

// Every image definition that declares a vocabulary: each purpose and aspect
// yields settings the engine's own schema accepts (buildEngineInput enforces
// the schema's enums and required params).
describe("every declared vocabulary builds a valid engine input", () => {
  const purposes: ImageRequestPurpose[] = ["preview", "comparison", "final"];
  for (const def of ALL_ENGINES.filter((e) => e.kind === "image" && e.sizeVocabulary)) {
    it(def.id, () => {
      for (const purpose of purposes) {
        for (const aspect of ["landscape", "square", "portrait"] as const) {
          const settings = buildImageRequestSettings(def, purpose, aspect);
          const params: Record<string, unknown> = {
            imagePrompt: "a test prompt",
            aspectRatio: aspect,
            numImages: 1,
            ...settings.sizeParams,
          };
          if (def.imageMode === "i2i") params["referenceImageUrl"] = "https://example.com/ref.png";
          assert.doesNotThrow(() => buildEngineInput(def as unknown as Engine, params), `${def.id} ${purpose} ${aspect}`);
        }
      }
    });
  }
});
