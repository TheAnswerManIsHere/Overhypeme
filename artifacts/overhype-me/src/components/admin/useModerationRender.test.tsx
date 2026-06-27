import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useModerationRender, type RenderControlsBody, type RenderAttempt } from "./useModerationRender";

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubRenderFetch(pollSeq: unknown[]) {
  let pollI = 0;
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? "GET";
    calls.push({ url: String(url), method });
    if (method === "POST") return json({ renderJobId: "rj1", attemptId: 9 });
    const body = pollSeq[Math.min(pollI, pollSeq.length - 1)];
    pollI += 1;
    return json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const BODY: RenderControlsBody = {
  lookStyleId: null,
  renderControls: { aspectRatio: "portrait", contentMode: "sfw", negativeSpacePreference: "auto", fallbackSubjectGender: "neutral" },
  identityPolicyOverrides: { preservePhysique: false },
  meta: { name: "David Franklin", pronouns: "he/him", aspectRatio: "portrait", fallbackGender: "neutral", style: "(none)", contentMode: "sfw" },
};

const poll = (status: string, extra: Record<string, unknown> = {}) => ({
  status, attemptId: 9, generatedImageObjectPath: null, blocked: false, blockReason: null, error: null, ...extra,
});

afterEach(() => {
  cleanupStorage();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function cleanupStorage() {
  try { localStorage.clear(); } catch { /* ignore */ }
}

describe("useModerationRender", () => {
  it("kicks a render then polls to a terminal image_ready and stops", async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubRenderFetch([
      poll("prompt_ready"),
      poll("image_ready", { generatedImageObjectPath: "/objects/ai-bg-v2/1/9.png" }),
    ]);
    const { result } = renderHook(() => useModerationRender(5));

    await act(async () => { await result.current.render(BODY); });
    expect(result.current.attempts).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(result.current.attempts[0]!.status).toBe("image_ready");
    expect(result.current.attempts[0]!.generatedImageObjectPath).toBe("/objects/ai-bg-v2/1/9.png");

    // Terminal → polling stopped: no further GET calls after more time passes.
    const callsAfterTerminal = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetchMock.mock.calls.length).toBe(callsAfterTerminal);
  });

  it("surfaces a blocked render distinctly from failure", async () => {
    vi.useFakeTimers();
    stubRenderFetch([poll("blocked", { blocked: true, blockReason: "subject_fact_compatibility_poor" })]);
    const { result } = renderHook(() => useModerationRender(5));
    await act(async () => { await result.current.render(BODY); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(result.current.attempts[0]!.status).toBe("blocked");
  });

  it("restores persisted attempts but does NOT resume polling terminal rows", async () => {
    const terminal: RenderAttempt = {
      renderJobId: "old-1", attemptId: 1, status: "image_ready",
      generatedImageObjectPath: "/objects/x.png", error: null, blockReason: null, recommendedFallback: null,
      meta: BODY.meta,
    };
    localStorage.setItem("overhype:rpp:v1:review-render-attempts:8", JSON.stringify([terminal]));
    vi.useFakeTimers();
    const { fetchMock } = stubRenderFetch([poll("image_ready")]);

    const { result } = renderHook(() => useModerationRender(8));
    expect(result.current.attempts).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    // No poll fetch for the already-terminal restored row.
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
