import { describe, it, expect } from "vitest";
import { makeAbortController } from "@/lib/makeAbortController";

/** Simulates a fetch that resolves with data but rejects with AbortError when the signal fires. */
function makeAbortablePromise<T>(
  signal: AbortSignal,
  executor: (resolve: (v: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    executor(resolve);
  });
}

describe("makeAbortController (race-safe fetch helper)", () => {
  it("aborts the previous signal when next() is called a second time", () => {
    const ctrl = makeAbortController();
    const first = ctrl.next();
    expect(first.signal.aborted).toBe(false);

    ctrl.next();
    expect(first.signal.aborted).toBe(true);
  });

  it("isLatest() returns false for a superseded request and true for the current one", () => {
    const ctrl = makeAbortController();
    const a = ctrl.next();
    const b = ctrl.next();

    expect(a.isLatest()).toBe(false);
    expect(b.isLatest()).toBe(true);
  });

  it("resolves with user B's data when A's response arrives after B's (simulated out-of-order delivery)", async () => {
    const ctrl = makeAbortController();
    let membershipData: { userId: string } | null = null;
    let loading = false;

    function runFetch(userId: string, resolverSlot: { resolve?: (v: { userId: string }) => void }) {
      const { signal, isLatest } = ctrl.next();
      loading = true;
      membershipData = null;
      makeAbortablePromise<{ userId: string }>(signal, (resolve) => { resolverSlot.resolve = resolve; })
        .then((data) => { membershipData = data; })
        .catch(() => {})
        .finally(() => { if (isLatest()) loading = false; });
      void userId;
    }

    const slotA: { resolve?: (v: { userId: string }) => void } = {};
    const slotB: { resolve?: (v: { userId: string }) => void } = {};

    runFetch("user-a", slotA);
    runFetch("user-b", slotB);

    slotB.resolve!({ userId: "user-b" });
    await new Promise((r) => setTimeout(r, 0));

    expect(membershipData).toEqual({ userId: "user-b" });

    slotA.resolve?.({ userId: "user-a" });
    await new Promise((r) => setTimeout(r, 0));

    expect(membershipData).toEqual({ userId: "user-b" });
    expect(loading).toBe(false);
  });

  it("loading state is only cleared by the latest fetch", async () => {
    const ctrl = makeAbortController();
    let loading = false;

    const slotB: { resolve?: () => void } = {};

    function runFetch(resolverSlot?: { resolve?: () => void }) {
      const { signal, isLatest } = ctrl.next();
      loading = true;
      makeAbortablePromise<void>(signal, (resolve) => {
        if (resolverSlot) resolverSlot.resolve = resolve;
      })
        .catch(() => {})
        .finally(() => { if (isLatest()) loading = false; });
    }

    runFetch();
    runFetch(slotB);

    expect(loading).toBe(true);
    slotB.resolve!();
    await new Promise((r) => setTimeout(r, 0));
    expect(loading).toBe(false);
  });
});
