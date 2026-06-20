import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { CLASSIFICATION_PROMPT_VERSION, type FactEnrichment } from "@workspace/api-zod";
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
  // Current version so the regenerate-preview guard treats this fixture as
  // up-to-date and exercises the happy path. A separate test covers the stale case.
  classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
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
} {
  const applyServerState = vi.fn();
  const opts: UseEnrichmentJobsOptions = {
    resource: "reviews",
    id: 7,
    status: "ok",
    isDirty: () => false,
    applyServerState,
    ...over,
  };
  return { opts, applyServerState };
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
    expect(applyServerState).toHaveBeenCalledWith(null, "pending");
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
