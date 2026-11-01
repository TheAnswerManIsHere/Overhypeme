import { describe, it, expect } from "vitest";
import { buildSaveMemePayload } from "../../util/saveMemePayload";
import type { WizardRuntimeState } from "../../state/useWizardState";
import { DEFAULT_BOTTOM_Y, DEFAULT_TOP_Y } from "../../../types";

function baseState(): WizardRuntimeState {
  return {
    generation: { status: "idle" },
    aspectRatio: "landscape",
    framingOffset: { x: 0, y: 0 },
    name: "Quinn",
    pronouns: "they/them",
    textOptions: { topText: "TOP", bottomText: "BOTTOM" },
  };
}

describe("buildSaveMemePayload", () => {
  it("returns null when no source is set", () => {
    expect(buildSaveMemePayload({ state: baseState(), factId: 42 })).toBeNull();
  });

  it("never produces a stock imageSource: a stale stock source builds no payload", () => {
    // Stock photos went with Pexels (launch Phase 4, removal 6); the server
    // refuses the variant, so a source of that shape must not reach it.
    const state = {
      ...baseState(),
      source: { kind: "stock", stockImageId: "999" },
    } as unknown as WizardRuntimeState;
    expect(buildSaveMemePayload({ state, factId: 42 })).toBeNull();
  });

  it("sends the caption positions the preview drew, the slider defaults when untouched (#707)", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "self-upload",
      source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/foo.jpg" } },
    };
    const payload = buildSaveMemePayload({ state, factId: 1 });
    expect(payload!.textOptions).toMatchObject({ topY: DEFAULT_TOP_Y, bottomY: DEFAULT_BOTTOM_Y });
  });

  it("sends the slider's positions when the user moved them (#707)", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      textOptions: { topText: "TOP", bottomText: "BOTTOM", topY: 50, bottomY: 70 },
      mode: "self-upload",
      source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/foo.jpg" } },
    };
    const payload = buildSaveMemePayload({ state, factId: 1 });
    expect(payload!.textOptions).toMatchObject({ topY: 50, bottomY: 70 });
  });

  it("emits an upload imageSource for a library photo, and no transform", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "self-upload",
      source: {
        kind: "self-upload",
        image: { kind: "library", objectPath: "/objects/foo.jpg" },
      },
    };
    const payload = buildSaveMemePayload({ state, factId: 42 });
    expect(payload!.imageSource).toEqual({ type: "upload", uploadKey: "/objects/foo.jpg" });
    expect("imageTransform" in payload!).toBe(false);
  });

  it("carries the visibility choice, defaulting to public when unset", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "self-upload",
      source: {
        kind: "self-upload",
        image: { kind: "library", objectPath: "/objects/foo.jpg" },
      },
    };
    // Drafts captured before the control existed have no isPublic field.
    expect(buildSaveMemePayload({ state, factId: 42 })!.isPublic).toBe(true);
    expect(
      buildSaveMemePayload({ state: { ...state, isPublic: false }, factId: 42 })!.isPublic,
    ).toBe(false);
    expect(
      buildSaveMemePayload({ state: { ...state, isPublic: true }, factId: 42 })!.isPublic,
    ).toBe(true);
  });

  it("carries the visibility choice through the upload branches too", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "self-upload",
      isPublic: false,
      source: {
        kind: "self-upload",
        image: { kind: "library", objectPath: "/objects/foo.jpg" },
      },
    };
    expect(buildSaveMemePayload({ state, factId: 42 })!.isPublic).toBe(false);
  });
});
