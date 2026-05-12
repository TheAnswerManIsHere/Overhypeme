import { describe, it, expect, beforeEach } from "vitest";
import {
  captureWizardState,
  clearWizardState,
  restoreWizardState,
  type PendingWizardState,
} from "../state/wizardStorage";

const FACT_ID = "fact-42";

function fixture(overrides: Partial<PendingWizardState> = {}): PendingWizardState {
  return {
    schemaVersion: 2,
    capturedAt: Date.now(),
    factId: FACT_ID,
    entryFlow: "fact-detail",
    currentStep: 2,
    artifactType: "image",
    mode: "stock",
    source: { kind: "stock", stockImageId: "9001" },
    aspectRatio: "landscape",
    name: "Quinn",
    pronouns: "they/them",
    textOptions: {},
    ...overrides,
  };
}

describe("wizardStorage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips a fixture exactly", () => {
    const original = fixture();
    captureWizardState(original);
    expect(restoreWizardState(FACT_ID)).toEqual(original);
  });

  it("returns null when no pending state exists", () => {
    expect(restoreWizardState("nonexistent")).toBeNull();
  });

  it("expires entries older than 1 hour and clears them", () => {
    const old = fixture({ capturedAt: Date.now() - 61 * 60 * 1000 });
    window.sessionStorage.setItem(
      `pending_meme_wizard_v2::${FACT_ID}`,
      JSON.stringify(old),
    );
    expect(restoreWizardState(FACT_ID)).toBeNull();
    expect(
      window.sessionStorage.getItem(`pending_meme_wizard_v2::${FACT_ID}`),
    ).toBeNull();
  });

  it("ignores entries with the wrong schemaVersion", () => {
    const v1Style = { ...fixture(), schemaVersion: 1 } as unknown as PendingWizardState;
    window.sessionStorage.setItem(
      `pending_meme_wizard_v2::${FACT_ID}`,
      JSON.stringify(v1Style),
    );
    expect(restoreWizardState(FACT_ID)).toBeNull();
  });

  it("ignores malformed JSON", () => {
    window.sessionStorage.setItem(
      `pending_meme_wizard_v2::${FACT_ID}`,
      "{not-json",
    );
    expect(restoreWizardState(FACT_ID)).toBeNull();
  });

  it("isolates factIds", () => {
    captureWizardState(fixture({ factId: "fact-1" }));
    captureWizardState(fixture({ factId: "fact-2", artifactType: "video" }));
    expect(restoreWizardState("fact-1")?.artifactType).toBe("image");
    expect(restoreWizardState("fact-2")?.artifactType).toBe("video");
  });

  it("does not collide with the v1 pendingBuilderState key prefix", () => {
    // v1 uses `pending_meme_builder_v1::`; v2 uses `pending_meme_wizard_v2::`.
    // Writing v1 should not affect v2 reads.
    window.sessionStorage.setItem(
      `pending_meme_builder_v1::${FACT_ID}`,
      JSON.stringify({ schemaVersion: 1, factId: FACT_ID }),
    );
    expect(restoreWizardState(FACT_ID)).toBeNull();
  });

  it("clearWizardState removes the row", () => {
    captureWizardState(fixture());
    clearWizardState(FACT_ID);
    expect(restoreWizardState(FACT_ID)).toBeNull();
  });

  it("survives video artifact + self-upload + advanced options", () => {
    const captured = fixture({
      artifactType: "video",
      mode: "self-upload",
      source: {
        kind: "self-upload",
        image: { kind: "fresh", objectPath: "/objects/uploads/abc.jpg" },
        stylizeWithAi: true,
      },
      framingOffset: { x: 12, y: -8 },
      advancedOptions: {
        videoEngineId: "xai/grok-imagine-video/image-to-video",
        videoLengthSeconds: 6,
        videoResolution: "480p",
      },
    });
    captureWizardState(captured);
    expect(restoreWizardState(FACT_ID)).toEqual(captured);
  });
});
