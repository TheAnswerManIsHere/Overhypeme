import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FactEnrichment } from "@workspace/api-zod";
import { useEnrichmentJobs, type UseEnrichmentJobsOptions } from "./useEnrichmentJobs";

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: [],
  taxonomyConfidence: 0.9,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

interface Call { url: string; method: string }

function mockFetch(getBody: unknown = { enrichment: ENRICHMENT, enrichmentStatus: "ok" }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? "GET";
    calls.push({ url: String(url), method });
    if (method === "POST") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(getBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function makeOpts(over: Partial<UseEnrichmentJobsOptions> = {}): {
  opts: UseEnrichmentJobsOptions;
  applyServerState: ReturnType<typeof vi.fn>;
  saveNow: ReturnType<typeof vi.fn>;
} {
  const applyServerState = vi.fn();
  const saveNow = vi.fn(async () => true);
  const opts: UseEnrichmentJobsOptions = {
    resource: "reviews",
    id: 7,
    status: "ok",
    getEnrichment: () => ENRICHMENT,
    isDirty: () => false,
    applyServerState,
    saveNow,
    ...over,
  };
  return { opts, applyServerState, saveNow };
}

describe("useEnrichmentJobs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("onRerun POSTs /enrich and marks the form server-synced as pending", async () => {
    const { calls } = mockFetch();
    const { opts, applyServerState } = makeOpts();
    const { result } = renderHook((p: UseEnrichmentJobsOptions) => useEnrichmentJobs(p), { initialProps: opts });

    await act(async () => { await result.current.onRerun(); });

    expect(calls.some((c) => c.method === "POST" && c.url === "/api/admin/reviews/7/enrich")).toBe(true);
    expect(applyServerState).toHaveBeenCalledWith(ENRICHMENT, "pending");
  });

  it("onRegeneratePreview flushes the draft before POSTing /preview", async () => {
    const { calls } = mockFetch();
    const { opts, saveNow } = makeOpts();
    const { result } = renderHook((p: UseEnrichmentJobsOptions) => useEnrichmentJobs(p), { initialProps: opts });

    await act(async () => { await result.current.onRegeneratePreview(); });

    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/admin/reviews/7/preview")).toBe(true);
  });

  it("onRegeneratePreview is a no-op when there is no enrichment", async () => {
    const { calls } = mockFetch();
    const { opts, saveNow } = makeOpts({ getEnrichment: () => null });
    const { result } = renderHook((p: UseEnrichmentJobsOptions) => useEnrichmentJobs(p), { initialProps: opts });

    await act(async () => { await result.current.onRegeneratePreview(); });

    expect(saveNow).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it("polls and syncs while status is pending, then stops once resolved", async () => {
    const { calls } = mockFetch({ enrichment: ENRICHMENT, enrichmentStatus: "ok" });
    const { opts, applyServerState } = makeOpts({ status: "pending" });
    renderHook((p: UseEnrichmentJobsOptions) => useEnrichmentJobs(p), { initialProps: opts });

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(calls.some((c) => c.method === "GET" && c.url === "/api/admin/reviews/7")).toBe(true);
    expect(applyServerState).toHaveBeenCalledWith(ENRICHMENT, "ok");
  });

  it("does NOT sync from server while the form is dirty", async () => {
    const { calls } = mockFetch();
    const { opts, applyServerState } = makeOpts({ status: "pending", isDirty: () => true });
    renderHook((p: UseEnrichmentJobsOptions) => useEnrichmentJobs(p), { initialProps: opts });

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(calls.some((c) => c.method === "GET")).toBe(false);
    expect(applyServerState).not.toHaveBeenCalled();
  });
});
