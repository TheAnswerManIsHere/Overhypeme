import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  capturePendingState,
  clearPendingState,
  restorePendingState,
} from "../state/pendingBuilderState";
import type { PendingBuilderState } from "../types";

const FACT_ID = "fact-42";

function fixture(overrides: Partial<PendingBuilderState> = {}): PendingBuilderState {
  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    factId: FACT_ID,
    mode: "stock",
    entryFlow: "fact-detail",
    name: "Quinn",
    pronouns: "they/them",
    source: { kind: "stock", stockImageId: "9001" },
    aspectRatio: "landscape",
    textOptions: {},
    ...overrides,
  };
}

describe("pendingBuilderState", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a fixture exactly", () => {
    const original = fixture();
    capturePendingState(original);
    const restored = restorePendingState(FACT_ID);
    expect(restored).toEqual(original);
  });

  it("returns null when no pending state exists", () => {
    expect(restorePendingState("nonexistent")).toBeNull();
  });

  it("expires entries older than 1 hour", () => {
    const old = fixture({ capturedAt: Date.now() - 61 * 60 * 1000 });
    window.sessionStorage.setItem(`pending_meme_builder_v1::${FACT_ID}`, JSON.stringify(old));
    expect(restorePendingState(FACT_ID)).toBeNull();
    // Stale entry should be cleared as a side effect.
    expect(window.sessionStorage.getItem(`pending_meme_builder_v1::${FACT_ID}`)).toBeNull();
  });

  it("ignores rows with the wrong schemaVersion", () => {
    const future = { ...fixture(), schemaVersion: 99 } as unknown as PendingBuilderState;
    window.sessionStorage.setItem(`pending_meme_builder_v1::${FACT_ID}`, JSON.stringify(future));
    expect(restorePendingState(FACT_ID)).toBeNull();
  });

  it("clearPendingState removes the row", () => {
    capturePendingState(fixture());
    clearPendingState(FACT_ID);
    expect(restorePendingState(FACT_ID)).toBeNull();
  });

  it("survives a self-upload source", () => {
    const captured = fixture({
      mode: "self-upload",
      source: { kind: "self-upload", image: { kind: "fresh", objectPath: "/objects/uploads/abc.jpg" } },
    });
    capturePendingState(captured);
    expect(restorePendingState(FACT_ID)).toEqual(captured);
  });

  // Launch Phase 4, removal 3: AI styling went with PuLID. A draft saved before
  // it may still carry the stylize flag or an AI-styling pick.
  it("drops a pre-removal draft's AI pick, and keeps a plain photo without its stale flag", () => {
    const legacy = (source: unknown) =>
      ({ ...fixture({ mode: "self-upload" }), source }) as unknown as PendingBuilderState;

    capturePendingState(legacy({ kind: "self-upload", image: { kind: "ai-styling", objectPath: "/objects/ai.jpg" }, stylizeWithAi: false }));
    expect(restorePendingState(FACT_ID)?.source).toBeUndefined();

    capturePendingState(legacy({ kind: "self-upload", image: { kind: "fresh", objectPath: "/objects/f.jpg" }, stylizeWithAi: true }));
    expect(restorePendingState(FACT_ID)?.source).toBeUndefined();

    capturePendingState(legacy({ kind: "self-upload", image: { kind: "library", objectPath: "/objects/l.jpg" }, stylizeWithAi: false }));
    expect(restorePendingState(FACT_ID)?.source).toEqual({ kind: "self-upload", image: { kind: "library", objectPath: "/objects/l.jpg" } });
  });
});
