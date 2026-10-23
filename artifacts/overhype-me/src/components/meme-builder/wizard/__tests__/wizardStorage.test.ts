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
    schemaVersion: 3,
    capturedAt: Date.now(),
    factId: FACT_ID,
    entryFlow: "fact-detail",
    mode: "self-upload",
    source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/lib.jpg" } },
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

  it("ignores a version-2 draft from before video was cut (it carried an artifact type and a step)", () => {
    const v2 = { ...fixture(), schemaVersion: 2, currentStep: 2, artifactType: "video" } as unknown as PendingWizardState;
    window.sessionStorage.setItem(`pending_meme_wizard_v2::${FACT_ID}`, JSON.stringify(v2));
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
    captureWizardState(fixture({ factId: "fact-2", name: "Rowan" }));
    expect(restoreWizardState("fact-1")?.name).toBe("Quinn");
    expect(restoreWizardState("fact-2")?.name).toBe("Rowan");
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

  it("survives self-upload + framing + advanced options", () => {
    const captured = fixture({
      mode: "self-upload",
      source: {
        kind: "self-upload",
        image: { kind: "fresh", objectPath: "/objects/uploads/abc.jpg" },
      },
      framingOffset: { x: 12, y: -8 },
      advancedOptions: { imageEngineId: "nano-banana-pro" },
    });
    captureWizardState(captured);
    expect(restoreWizardState(FACT_ID)).toEqual(captured);
  });

  // Launch Phase 4, removal 6: stock photos went with Pexels. A draft saved
  // before it may have the stock source selected.
  it("drops a pre-removal draft's stock source and keeps everything else; an upload draft is unchanged", () => {
    const stockDraft = {
      ...fixture(),
      mode: "stock",
      source: { kind: "stock", stockImageId: "9001" },
      framingOffset: { x: 3, y: 4 },
      isPublic: false,
    } as unknown as PendingWizardState;
    captureWizardState(stockDraft);
    const restored = restoreWizardState(FACT_ID);
    expect(restored).not.toBeNull();
    expect(restored!.source).toBeUndefined();
    expect(restored).toMatchObject({
      schemaVersion: 3,
      factId: FACT_ID,
      entryFlow: "fact-detail",
      aspectRatio: "landscape",
      name: "Quinn",
      pronouns: "they/them",
      framingOffset: { x: 3, y: 4 },
      isPublic: false,
    });

    const upload = fixture();
    captureWizardState(upload);
    expect(restoreWizardState(FACT_ID)).toEqual(upload);
  });

  // Launch Phase 4, removal 3: AI styling went with PuLID. A draft saved before
  // it may still carry the stylize flag or an AI-styling pick.
  it("drops a pre-removal draft's AI pick, and keeps a plain photo without its stale flag", () => {
    const legacy = (source: unknown) =>
      ({ ...fixture({ mode: "self-upload" }), source }) as unknown as PendingWizardState;

    captureWizardState(legacy({ kind: "self-upload", image: { kind: "ai-styling", objectPath: "/objects/ai.jpg" }, stylizeWithAi: false }));
    expect(restoreWizardState(FACT_ID)?.source).toBeUndefined();

    // A plain photo that had the stylise switch on keeps the photo; only the flag goes.
    captureWizardState(legacy({ kind: "self-upload", image: { kind: "fresh", objectPath: "/objects/f.jpg" }, stylizeWithAi: true }));
    expect(restoreWizardState(FACT_ID)?.source).toEqual({ kind: "self-upload", image: { kind: "fresh", objectPath: "/objects/f.jpg" } });

    captureWizardState(legacy({ kind: "self-upload", image: { kind: "library", objectPath: "/objects/l.jpg" }, stylizeWithAi: false }));
    expect(restoreWizardState(FACT_ID)?.source).toEqual({ kind: "self-upload", image: { kind: "library", objectPath: "/objects/l.jpg" } });
  });
});
