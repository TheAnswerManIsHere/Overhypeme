import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FactEnrichment } from "@workspace/api-zod";
import { useEnrichmentDraft } from "./useEnrichmentDraft";

const VALID: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["strength", "pushups", "earth"],
  taxonomyConfidence: 0.9,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

// subtype does not belong to the archetype → fails validateEnrichment
const INVALID: FactEnrichment = { ...VALID, subtype: "mechanical_contradiction" as FactEnrichment["subtype"] };

interface Call { url: string; method: string; body?: unknown }

function mockFetch() {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? "GET";
    const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
    calls.push({ url: String(url), method, body });
    if (method === "PATCH") {
      return new Response(
        JSON.stringify({ success: true, enrichment: (body as { enrichment: FactEnrichment }).enrichment, projection: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // GET detail
    return new Response(JSON.stringify({ enrichment: VALID, enrichmentStatus: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, patches: () => calls.filter((c) => c.method === "PATCH") };
}

describe("useEnrichmentDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("autosaves a valid edit after the debounce", async () => {
    const { patches } = mockFetch();
    const { result } = renderHook(() =>
      useEnrichmentDraft({ resource: "facts", id: 1, initialEnrichment: VALID, initialStatus: "ok" }),
    );

    act(() => result.current.onChange({ ...VALID, adminReviewNotes: "tuned" }));
    expect(result.current.dirty).toBe(true);
    expect(result.current.unsavedInvalid).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    const p = patches();
    expect(p.length).toBe(1);
    expect(p[0].url).toBe("/api/admin/facts/1/enrichment");
    expect((p[0].body as { enrichment: FactEnrichment }).enrichment.adminReviewNotes).toBe("tuned");
  });

  it("does NOT autosave an invalid edit; surfaces unsavedInvalid", async () => {
    const { patches } = mockFetch();
    const { result } = renderHook(() =>
      useEnrichmentDraft({ resource: "facts", id: 1, initialEnrichment: VALID, initialStatus: "ok" }),
    );

    act(() => result.current.onChange(INVALID));
    expect(result.current.dirty).toBe(true);
    expect(result.current.unsavedInvalid).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(patches().length).toBe(0);
  });

  it("does not leak a pending save across an id change", async () => {
    const { patches } = mockFetch();
    const { result, rerender } = renderHook(
      (props: { id: number }) =>
        useEnrichmentDraft({ resource: "facts", id: props.id, initialEnrichment: VALID, initialStatus: "ok" }),
      { initialProps: { id: 1 } },
    );

    // Dirty fact #1, then switch to fact #2 before the debounce fires.
    act(() => result.current.onChange({ ...VALID, adminReviewNotes: "edit-for-1" }));
    rerender({ id: 2 });
    expect(result.current.dirty).toBe(false); // reset on id change

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    // The pending save for #1 must never fire (and certainly not against #2).
    expect(patches().length).toBe(0);
  });
});
