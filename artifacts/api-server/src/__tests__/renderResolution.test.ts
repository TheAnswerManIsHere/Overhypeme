// Moderation test renders (review panel) should use the lowest engine
// resolution for the fastest turnaround; real user renders stay at 2K.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RenderControls } from "@workspace/api-zod";
import { pickRenderResolution, isEphemeralModerationRender } from "../lib/imagePromptJobs";

function controls(extra: Record<string, unknown> = {}): RenderControls {
  return { aspectRatio: "portrait", contentMode: "sfw", ...extra } as unknown as RenderControls;
}

describe("pickRenderResolution", () => {
  it("ephemeral moderation render (mirrorToLegacyStorage:false) → 0.5K", () => {
    const rc = controls({ mirrorToLegacyStorage: false });
    assert.equal(isEphemeralModerationRender(rc), true);
    assert.equal(pickRenderResolution(rc), "0.5K");
  });

  it("real user render (flag unset) → 2K", () => {
    const rc = controls();
    assert.equal(isEphemeralModerationRender(rc), false);
    assert.equal(pickRenderResolution(rc), "2K");
  });

  it("explicit mirrorToLegacyStorage:true → 2K", () => {
    const rc = controls({ mirrorToLegacyStorage: true });
    assert.equal(pickRenderResolution(rc), "2K");
  });
});
