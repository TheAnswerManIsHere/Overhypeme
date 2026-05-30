import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { useFormDraft, type UseFormDraftOptions } from "./use-form-draft";
import { createLocalStorageAdapter, type StorageAdapter } from "@/lib/form-draft-storage";

interface Draft {
  text: string;
}

const isDraft = (v: unknown): v is Draft =>
  !!v && typeof v === "object" && typeof (v as Draft).text === "string";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function syncAdapter() {
  const save = vi.fn((_v: Draft) => Date.now());
  const clear = vi.fn();
  const load = vi.fn((): { value: Draft; savedAt: number } | null => null);
  return { adapter: { save, clear, load } as StorageAdapter<Draft>, save, clear, load };
}

// A stateful harness so `onRestore` can apply the restored value back into the
// form, mirroring real call sites (where restore feeds the controlled state).
function useDraftHarness(
  props: { initial?: string; adapter: StorageAdapter<Draft> } & Partial<UseFormDraftOptions<Draft>>,
) {
  const { initial = "", adapter, ...rest } = props;
  const [text, setText] = useState(initial);
  const draft = useFormDraft<Draft>({
    value: { text },
    adapter,
    isEmpty: (d) => d.text === "",
    onRestore: (d) => setText(d.text),
    ...rest,
  });
  return { draft, text, setText };
}

describe("useFormDraft", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid changes into a single debounced save", async () => {
    const { adapter, save } = syncAdapter();
    const { rerender } = renderHook(
      (p: { text: string }) =>
        useFormDraft<Draft>({
          value: { text: p.text },
          adapter,
          debounceMs: 500,
          restoreOnMount: false,
          isEmpty: (d) => d.text === "",
        }),
      { initialProps: { text: "" } },
    );
    rerender({ text: "a" });
    rerender({ text: "ab" });
    rerender({ text: "abc" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ text: "abc" });
  });

  it("does not save when a re-render produces an equivalent value", async () => {
    const { adapter, save } = syncAdapter();
    const { rerender } = renderHook(
      (p: { v: Draft }) =>
        useFormDraft<Draft>({
          value: p.v,
          adapter,
          debounceMs: 500,
          restoreOnMount: false,
          isEmpty: (d) => d.text === "",
        }),
      { initialProps: { v: { text: "hi" } } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    // New object, identical contents — must not schedule another save.
    rerender({ v: { text: "hi" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("restores a stored draft on mount without clearing it", async () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: "k", isValid: isDraft });
    adapter.save({ text: "restored" });
    const { result } = renderHook(() => useDraftHarness({ adapter }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.text).toBe("restored");
    expect(result.current.draft.savedAt).not.toBeNull();
    expect(window.localStorage.getItem("k")).not.toBeNull();
  });

  it("does not restore an expired draft", async () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: "k", ttlMs: 1000, isValid: isDraft });
    adapter.save({ text: "old" });
    vi.setSystemTime(Date.now() + 5000);
    const { result } = renderHook(() => useDraftHarness({ adapter }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.text).toBe("");
  });

  it("clears instead of saving when the value becomes empty", async () => {
    const { adapter, save, clear } = syncAdapter();
    const { result, rerender } = renderHook(
      (p: { text: string }) =>
        useFormDraft<Draft>({
          value: { text: p.text },
          adapter,
          debounceMs: 100,
          restoreOnMount: false,
          isEmpty: (d) => d.text === "",
        }),
      { initialProps: { text: "hi" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(save).toHaveBeenCalledTimes(1);
    rerender({ text: "" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(clear).toHaveBeenCalled();
    expect(result.current.savedAt).toBeNull();
  });

  it("does not save while disabled", async () => {
    const { adapter, save } = syncAdapter();
    renderHook(() =>
      useFormDraft<Draft>({
        value: { text: "x" },
        adapter,
        debounceMs: 100,
        restoreOnMount: false,
        enabled: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("gates autosave behind manualDirty and fires onSaved after a save", async () => {
    const { adapter, save } = syncAdapter();
    const onSaved = vi.fn();
    const { rerender } = renderHook(
      (p: { text: string; dirty: boolean }) =>
        useFormDraft<Draft>({
          value: { text: p.text },
          adapter,
          debounceMs: 100,
          restoreOnMount: false,
          manualDirty: p.dirty,
          onSaved,
        }),
      { initialProps: { text: "a", dirty: false } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(save).not.toHaveBeenCalled();
    rerender({ text: "ab", dirty: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("clear() cancels a pending save and leaves storage cleared", async () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: "k", isValid: isDraft });
    const { result, rerender } = renderHook(
      (p: { text: string }) =>
        useFormDraft<Draft>({
          value: { text: p.text },
          adapter,
          debounceMs: 500,
          restoreOnMount: false,
          isEmpty: (d) => d.text === "",
        }),
      { initialProps: { text: "" } },
    );
    rerender({ text: "draft" });
    // Discard mid-debounce: clear + empty the value, as the real call sites do.
    act(() => {
      result.current.clear();
    });
    rerender({ text: "" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(window.localStorage.getItem("k")).toBeNull();
    expect(result.current.savedAt).toBeNull();
  });

  it("saveNow flushes the latest value immediately and resolves true", async () => {
    const { adapter, save } = syncAdapter();
    const { result } = renderHook(() =>
      useFormDraft<Draft>({
        value: { text: "now" },
        adapter,
        debounceMs: 9999,
        restoreOnMount: false,
      }),
    );
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveNow();
    });
    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledWith({ text: "now" });
  });

  it("ignores a stale (out-of-order) save resolution", async () => {
    const deferreds = [deferred<number>(), deferred<number>()];
    let idx = 0;
    const save = vi.fn(() => deferreds[idx++].promise);
    const adapter: StorageAdapter<Draft> = { load: () => null, clear: vi.fn(), save };
    const { result, rerender } = renderHook(
      (p: { text: string }) =>
        useFormDraft<Draft>({ value: { text: p.text }, adapter, debounceMs: 100, restoreOnMount: false }),
      { initialProps: { text: "a" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    }); // save #1 in flight
    rerender({ text: "ab" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    }); // save #2 in flight
    // Resolve latest first, then the stale earlier one.
    await act(async () => {
      deferreds[1].resolve(2000);
      await Promise.resolve();
    });
    expect(result.current.savedAt).toBe(2000);
    await act(async () => {
      deferreds[0].resolve(1000);
      await Promise.resolve();
    });
    expect(result.current.savedAt).toBe(2000);
  });

  it("does not let a stale save rejection override a newer saved status", async () => {
    const deferreds = [deferred<number>(), deferred<number>()];
    let idx = 0;
    const save = vi.fn(() => deferreds[idx++].promise);
    const adapter: StorageAdapter<Draft> = { load: () => null, clear: vi.fn(), save };
    const { result, rerender } = renderHook(
      (p: { text: string }) =>
        useFormDraft<Draft>({ value: { text: p.text }, adapter, debounceMs: 100, restoreOnMount: false }),
      { initialProps: { text: "a" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ text: "ab" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      deferreds[1].resolve(2000);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("saved");
    await act(async () => {
      deferreds[0].reject(new Error("late failure"));
      await Promise.resolve();
    });
    expect(result.current.status).toBe("saved");
    expect(result.current.error).toBeNull();
  });

  it("re-clears storage if an in-flight save resolves after clear()", async () => {
    const d = deferred<number>();
    const save = vi.fn(() => d.promise);
    const clear = vi.fn();
    const adapter: StorageAdapter<Draft> = { load: () => null, clear, save };
    const { result, rerender } = renderHook(
      (p: { text: string }) =>
        useFormDraft<Draft>({ value: { text: p.text }, adapter, debounceMs: 100, restoreOnMount: false }),
      { initialProps: { text: "a" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    }); // save in flight
    act(() => {
      result.current.clear();
    });
    expect(clear).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve(1234);
      await Promise.resolve();
    });
    // The superseded save must not "win" — storage stays cleared.
    expect(clear).toHaveBeenCalledTimes(2);
    expect(result.current.savedAt).toBeNull();
  });

  it("surfaces an error status when the adapter save throws", async () => {
    const adapter: StorageAdapter<Draft> = {
      load: () => null,
      clear: vi.fn(),
      save: () => {
        throw new Error("server exploded");
      },
    };
    const { result } = renderHook(() =>
      useFormDraft<Draft>({ value: { text: "x" }, adapter, debounceMs: 50, restoreOnMount: false }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("server exploded");
  });

  it("refreshes the relative-time label on an interval", async () => {
    const adapter: StorageAdapter<Draft> = { load: () => null, clear: vi.fn(), save: () => Date.now() };
    const { result } = renderHook(() =>
      useFormDraft<Draft>({ value: { text: "x" }, adapter, debounceMs: 50, restoreOnMount: false }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.savedLabel).toBe("Saved just now");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(result.current.savedLabel).toMatch(/min ago/);
  });

  it("degrades without throwing when the adapter fails", () => {
    const adapter: StorageAdapter<Draft> = {
      load: () => {
        throw new Error("boom");
      },
      save: () => {
        throw new Error("boom");
      },
      clear: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      renderHook(() => useFormDraft<Draft>({ value: { text: "x" }, adapter, debounceMs: 50 })),
    ).not.toThrow();
  });
});
