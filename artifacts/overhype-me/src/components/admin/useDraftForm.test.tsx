import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDraftForm } from "./useDraftForm";
import { createLocalStorageAdapter } from "@/lib/form-draft-storage";

interface V {
  text: string;
  n: number;
}
interface Rec {
  text: string;
  n: number;
}

const rec = (text: string, n: number): Rec => ({ text, n });
const sel = (r: Rec): V => ({ text: r.text, n: r.n });

describe("useDraftForm", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("loads the server record as the baseline on mount", async () => {
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::load",
        emptyValue: { text: "", n: 0 },
        fetchServer: async () => rec("hello", 5),
        selectValue: sel,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.value).toEqual({ text: "hello", n: 5 });
    expect(result.current.hasUncommittedChanges).toBe(false);
  });

  it("a restored localStorage draft wins over the server value", async () => {
    createLocalStorageAdapter<V>({ key: "k::restore" }).save({ text: "draft-wins", n: 7 });
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::restore",
        emptyValue: { text: "", n: 0 },
        fetchServer: async () => rec("server-val", 0),
        selectValue: sel,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.value).toEqual({ text: "draft-wins", n: 7 });
    // The server value is still the baseline, so there are uncommitted changes.
    expect(result.current.hasUncommittedChanges).toBe(true);
  });

  it("autosaves edits to localStorage (debounced)", async () => {
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::autosave",
        emptyValue: { text: "", n: 0 },
        debounceMs: 20,
        fetchServer: async () => rec("a", 1),
        selectValue: sel,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setValue({ text: "b", n: 2 }));
    expect(result.current.hasUncommittedChanges).toBe(true);
    await waitFor(() => expect(window.localStorage.getItem("k::autosave")).not.toBeNull());
  });

  it("save() commits to the server, promotes the baseline, and clears the draft", async () => {
    const commit = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::save",
        emptyValue: { text: "", n: 0 },
        debounceMs: 20,
        fetchServer: async () => rec("a", 1),
        selectValue: sel,
        commit,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setValue({ text: "b", n: 2 }));
    await waitFor(() => expect(window.localStorage.getItem("k::save")).not.toBeNull());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });
    expect(ok).toBe(true);
    expect(commit).toHaveBeenCalledWith({ text: "b", n: 2 });
    expect(result.current.hasUncommittedChanges).toBe(false);
    expect(result.current.committedAt).not.toBeNull();
    expect(window.localStorage.getItem("k::save")).toBeNull();
  });

  it("save() surfaces a commit error and keeps the draft uncommitted", async () => {
    const commit = vi.fn(async () => {
      throw new Error("server exploded");
    });
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::saveerr",
        emptyValue: { text: "", n: 0 },
        debounceMs: 20,
        fetchServer: async () => rec("a", 1),
        selectValue: sel,
        commit,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setValue({ text: "b", n: 2 }));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });
    expect(ok).toBe(false);
    expect(result.current.commitError).toBe("server exploded");
    expect(result.current.hasUncommittedChanges).toBe(true);
  });

  it("discard() reverts to the server baseline and clears the draft", async () => {
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::discard",
        emptyValue: { text: "", n: 0 },
        debounceMs: 20,
        fetchServer: async () => rec("a", 1),
        selectValue: sel,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setValue({ text: "x", n: 9 }));
    await waitFor(() => expect(window.localStorage.getItem("k::discard")).not.toBeNull());

    act(() => result.current.discard());
    expect(result.current.value).toEqual({ text: "a", n: 1 });
    expect(result.current.hasUncommittedChanges).toBe(false);
    expect(window.localStorage.getItem("k::discard")).toBeNull();
  });

  it("adoptServerSlice() folds a server update into value + baseline, preserving other edits", async () => {
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::adopt",
        emptyValue: { text: "", n: 0 },
        debounceMs: 20,
        fetchServer: async () => rec("a", 1),
        selectValue: sel,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Local edit to `text`; a background job rewrites `n` server-side.
    act(() => result.current.setValue((v) => ({ ...v, text: "edited" })));
    act(() => result.current.adoptServerSlice((v) => ({ ...v, n: 99 })));

    expect(result.current.value).toEqual({ text: "edited", n: 99 });
    // baseline is now { text: "a", n: 99 } → the `text` edit is still uncommitted.
    expect(result.current.hasUncommittedChanges).toBe(true);
  });

  it("markCommitted() promotes the value without calling commit and clears the draft", async () => {
    const commit = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useDraftForm<V, Rec>({
        storageKey: "k::mark",
        emptyValue: { text: "", n: 0 },
        debounceMs: 20,
        fetchServer: async () => rec("a", 1),
        selectValue: sel,
        commit,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setValue({ text: "z", n: 3 }));
    await waitFor(() => expect(window.localStorage.getItem("k::mark")).not.toBeNull());

    act(() => result.current.markCommitted());
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.value).toEqual({ text: "z", n: 3 });
    expect(result.current.hasUncommittedChanges).toBe(false);
    expect(result.current.committedAt).not.toBeNull();
    expect(window.localStorage.getItem("k::mark")).toBeNull();
  });
});
