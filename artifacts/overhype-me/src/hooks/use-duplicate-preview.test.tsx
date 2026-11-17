/**
 * The submit page's duplicate preview (plan docs/plans/PLAN_DUPLICATE_VERDICT.md,
 * Astra R3): it shows the server's "duplicate" verdict only for the text being
 * judged, a changed input (typing, or an advanced-template edit) drops the old
 * preview, and a late answer for older text never replaces a newer one.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDuplicatePreview, DUPLICATE_PREVIEW_DELAY_MS } from "./use-duplicate-preview";

type Pending = { text: string; resolve: (body: unknown) => void };
let pending: Pending[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((res) => {
    pending.push({ text: JSON.parse(String(init.body)).text, resolve: (body) => res({ ok: true, status: 200, json: async () => body }) });
  })) as unknown as typeof fetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const A = "{NAME} can hear sign languages, loudly";
const B = "{NAME} can hear sign languages, quietly";
const dup = { outcome: "duplicate", isDuplicate: true, confidence: 77, matchingFactId: 41, matchingFactText: "x" };

async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); }); }

describe("useDuplicatePreview", () => {
  it("shows a duplicate verdict for the current text after the pause", async () => {
    const { result } = renderHook(() => useDuplicatePreview(A));
    await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
    expect(pending.map((p) => p.text)).toEqual([A]);
    await act(async () => pending[0]!.resolve(dup));
    await settle();
    expect(result.current.shown?.matchingFactId).toBe(41);
  });

  it("does not show a distinct or unavailable verdict", async () => {
    const { result } = renderHook(() => useDuplicatePreview(A));
    await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
    await act(async () => pending[0]!.resolve({ ...dup, outcome: "unavailable", isDuplicate: false }));
    await settle();
    expect(result.current.shown).toBeNull();
  });

  it("a changed input (an advanced-template edit) drops the old preview at once", async () => {
    const { result, rerender } = renderHook(({ input }) => useDuplicatePreview(input), { initialProps: { input: A } });
    await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
    await act(async () => pending[0]!.resolve(dup));
    await settle();
    expect(result.current.shown).not.toBeNull();
    rerender({ input: B });
    expect(result.current.shown).toBeNull();
  });

  it("a late answer for older text never replaces the newer one", async () => {
    const { result, rerender } = renderHook(({ input }) => useDuplicatePreview(input), { initialProps: { input: A } });
    await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
    rerender({ input: B });
    await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
    expect(pending.map((p) => p.text)).toEqual([A, B]);
    await act(async () => pending[1]!.resolve({ ...dup, outcome: "distinct", isDuplicate: false }));
    await act(async () => pending[0]!.resolve(dup));
    await settle();
    expect(result.current.shown).toBeNull();
    expect(result.current.checking).toBe(false);
  });

  describe("stopped when a submission starts (Codex 4603544371)", () => {
    const hook = () => renderHook(({ input, active }) => useDuplicatePreview(input, active), { initialProps: { input: A, active: true } });

    it("a pause still pending when it stops starts no request", async () => {
      const { rerender } = hook();
      rerender({ input: A, active: false });
      await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS * 2); });
      expect(pending).toHaveLength(0);
    });

    it("a request in flight when it stops cannot show its answer", async () => {
      const { result, rerender } = hook();
      await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
      expect(pending).toHaveLength(1);
      rerender({ input: A, active: false });
      await act(async () => pending[0]!.resolve(dup));
      await settle();
      expect(result.current.shown).toBeNull();
      expect(result.current.checking).toBe(false);
    });

    it("a verdict shown before it stops is still shown after", async () => {
      const { result, rerender } = hook();
      await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
      await act(async () => pending[0]!.resolve(dup));
      await settle();
      rerender({ input: A, active: false });
      expect(result.current.shown?.matchingFactId).toBe(41);
    });

    it("resuming without a success (a failed submission) checks the current text again", async () => {
      const { rerender } = hook();
      rerender({ input: A, active: false });
      rerender({ input: A, active: true });
      await act(async () => { vi.advanceTimersByTime(DUPLICATE_PREVIEW_DELAY_MS); });
      expect(pending.map((p) => p.text)).toEqual([A]);
    });
  });
});
