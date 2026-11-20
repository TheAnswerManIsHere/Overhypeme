/**
 * Read-only mode in the web app (launch Phase 16, increment 4): a refused
 * request raises the notice and the refusal message, and the caller can
 * still read the response it was given.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetReadOnlyNoticeForTests,
  inspectForReadOnly,
  isReadOnlyNow,
  onReadOnlyChange,
  noteReadOnlyRefusal,
  onReadOnlyRefusal,
  READ_ONLY_REFUSED_TITLE,
  REFUSAL_QUIET_MS,
  shouldSuppressToast,
} from "./readOnlyNotice";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => __resetReadOnlyNoticeForTests());

describe("a refused request", () => {
  it("turns the notice on and announces the refusal; the caller still reads the body", async () => {
    const changed = vi.fn();
    const refused = vi.fn();
    onReadOnlyChange(changed);
    onReadOnlyRefusal(refused);
    const res = json(503, { code: "READ_ONLY_MODE", error: "paused" });
    await inspectForReadOnly(res);
    expect(isReadOnlyNow()).toBe(true);
    expect(changed).toHaveBeenCalledWith(true);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ code: "READ_ONLY_MODE", error: "paused" });
  });

  it("any other answer, a 503 included, changes nothing", async () => {
    const refused = vi.fn();
    onReadOnlyRefusal(refused);
    await inspectForReadOnly(json(503, { error: "down" }));
    await inspectForReadOnly(new Response("<html>", { status: 503 }));
    await inspectForReadOnly(json(403, { code: "READ_ONLY_MODE" }));
    await inspectForReadOnly(json(200, { ok: true }));
    expect(refused).not.toHaveBeenCalled();
    expect(isReadOnlyNow()).toBe(false);
  });
});

describe("toasts right after a refusal (Issue #1107)", () => {
  it("keeps the refusal's reason: the caller's own failure toast is dropped for a moment", () => {
    vi.useFakeTimers();
    try {
      expect(shouldSuppressToast("Failed to post comment")).toBe(false);
      noteReadOnlyRefusal();
      expect(shouldSuppressToast("Failed to post comment")).toBe(true);
      expect(shouldSuppressToast(READ_ONLY_REFUSED_TITLE)).toBe(false);
      vi.advanceTimersByTime(REFUSAL_QUIET_MS);
      expect(shouldSuppressToast("Failed to post comment")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
