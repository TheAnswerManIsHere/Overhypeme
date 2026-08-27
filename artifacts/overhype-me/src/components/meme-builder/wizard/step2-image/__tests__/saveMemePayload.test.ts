import { describe, it, expect } from "vitest";
import { buildSaveMemePayload } from "../../util/saveMemePayload";
import type { WizardRuntimeState } from "../../state/useWizardState";

function baseState(): WizardRuntimeState {
  return {
    currentStep: 2,
    artifactType: "image",
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

  it("emits a stock imageSource when source.kind=stock", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "stock",
      source: { kind: "stock", stockImageId: "999" },
    };
    const payload = buildSaveMemePayload({ state, factId: 42 });
    expect(payload).not.toBeNull();
    expect(payload!.imageSource).toEqual({ type: "stock", pexelsPhotoId: 999 });
    expect(payload!.imageTransform).toBeUndefined();
  });

  it("emits an upload imageSource for a library photo without stylize", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "self-upload",
      source: {
        kind: "self-upload",
        image: { kind: "library", objectPath: "/objects/foo.jpg" },
        stylizeWithAi: false,
      },
    };
    const payload = buildSaveMemePayload({ state, factId: 42 });
    expect(payload!.imageSource).toEqual({ type: "upload", uploadKey: "/objects/foo.jpg" });
    expect(payload!.imageTransform).toBeUndefined();
  });

  it("carries the visibility choice, defaulting to public when unset", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "stock",
      source: { kind: "stock", stockImageId: "999" },
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
        stylizeWithAi: false,
      },
    };
    expect(buildSaveMemePayload({ state, factId: 42 })!.isPublic).toBe(false);

    const stylized: WizardRuntimeState = {
      ...state,
      source: { ...state.source!, stylizeWithAi: true } as WizardRuntimeState["source"],
    };
    expect(
      buildSaveMemePayload({
        state: stylized,
        factId: 42,
        pulidGeneratedUploadKey: "/objects/pulid-result.jpg",
      })!.isPublic,
    ).toBe(false);
  });

  it("requires a pulidGeneratedUploadKey when stylizeWithAi is true", () => {
    const state: WizardRuntimeState = {
      ...baseState(),
      mode: "self-upload",
      source: {
        kind: "self-upload",
        image: { kind: "library", objectPath: "/objects/profile.jpg" },
        stylizeWithAi: true,
      },
    };
    expect(buildSaveMemePayload({ state, factId: 42 })).toBeNull();
    const payload = buildSaveMemePayload({
      state,
      factId: 42,
      pulidGeneratedUploadKey: "/objects/pulid-result.jpg",
    });
    expect(payload!.imageSource).toEqual({ type: "upload", uploadKey: "/objects/pulid-result.jpg" });
    expect(payload!.imageTransform).toBe("pulid");
  });
});
