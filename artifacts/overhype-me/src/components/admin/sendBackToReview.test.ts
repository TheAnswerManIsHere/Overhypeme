/**
 * Shared send-back client — the request shape + 409-code passthrough both the
 * Facts editor and the Taxonomy Health stale-for-reprocess list depend on.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendFactBackToReview } from "./sendBackToReview";

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    calls.push({
      url: String(url),
      method: opts?.method ?? "GET",
      body: opts?.body ? JSON.parse(String(opts.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendFactBackToReview", () => {
  it("POSTs to the send-back endpoint with clearOverrides=false by default and returns the reviewId", async () => {
    const { calls } = mockFetch(200, { success: true, reviewId: 42 });
    const result = await sendFactBackToReview(7);
    expect(result).toEqual({ success: true, reviewId: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/admin/facts/7/send-back-to-review");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ clearOverrides: false });
  });

  it("passes clearOverrides through when requested", async () => {
    const { calls } = mockFetch(200, { success: true, reviewId: 9 });
    await sendFactBackToReview(3, { clearOverrides: true });
    expect(calls[0]!.body).toEqual({ clearOverrides: true });
  });

  it("surfaces a 409 HAS_ACTIVE_VARIANTS with its code and message", async () => {
    mockFetch(409, { error: "This fact has active variants.", code: "HAS_ACTIVE_VARIANTS" });
    const result = await sendFactBackToReview(7);
    expect(result.success).toBe(false);
    expect(result.code).toBe("HAS_ACTIVE_VARIANTS");
    expect(result.error).toBe("This fact has active variants.");
  });

  it("surfaces a 409 REFRESH_ALREADY_IN_PROGRESS with its code", async () => {
    mockFetch(409, { error: "A refresh is already in progress.", code: "REFRESH_ALREADY_IN_PROGRESS" });
    const result = await sendFactBackToReview(7);
    expect(result.success).toBe(false);
    expect(result.code).toBe("REFRESH_ALREADY_IN_PROGRESS");
  });

  it("falls back to a status-based message when the error body is empty", async () => {
    mockFetch(500, {});
    const result = await sendFactBackToReview(7);
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("resolves to a network error result when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const result = await sendFactBackToReview(7);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network/i);
  });
});
