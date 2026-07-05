/**
 * useFactEnrichmentEditing — the shared Edit-Fact / moderation editing engine.
 *
 * Pins the two guards the moderation-lockstep plan added on top of the
 * extracted Facts-page machinery:
 *  1. the anti-smuggle overlay: a surface that may only edit the visual
 *     strategy override (moderation) can NEVER change `suggestedHashtags`
 *     through a draft commit, even when a stale localStorage draft carries a
 *     modified value;
 *  2. the `enabled` contract: disabled → no fetches, null enrichment, no
 *     overrideContext; enabling (or switching factId) loads the new fact's
 *     detail + resolved override state cleanly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { FactEnrichment } from "@workspace/api-zod";
import { useFactEnrichmentEditing, type UseFactEnrichmentEditingOptions } from "./useFactEnrichmentEditing";

function makeEnrichment(over: Partial<FactEnrichment> = {}): FactEnrichment {
  return {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["ai-original"],
    taxonomyConfidence: 0.9,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    ...over,
  } as FactEnrichment;
}

const VSO = {
  version: 1 as const,
  enabled: true,
  requiredVisualDetails: ["adult head on a newborn body"],
  forbiddenVisualDetails: [],
  roleBindings: [],
  compositionGuidance: [],
  styleAgnosticPromptAdditions: [],
  negativePromptAdditions: [],
};

const EMPTY_SUMMARY = {
  hasOverrides: false,
  overriddenPaths: [],
  baselineChangedPaths: [],
  invalidPaths: [],
  crossFieldInvalid: false,
  hasVisualStrategyOverride: false,
};

interface Call { url: string; method: string; body?: unknown }

/** Stub fetch for the three endpoints the hook talks to, keyed by fact id. */
function mockFetch(enrichmentByFact: Record<number, FactEnrichment>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
    calls.push({ url: u, method, body });
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

    const idMatch = u.match(/\/api\/admin\/facts\/(\d+)/);
    const factId = idMatch ? Number(idMatch[1]) : 0;
    const enrichment = enrichmentByFact[factId];
    if (!enrichment) return new Response("{}", { status: 404 });

    if (u.endsWith("/enrichment-resolved")) {
      return json({ aiDerived: enrichment, overrides: {}, effective: enrichment, overrideSummary: EMPTY_SUMMARY });
    }
    if (u.endsWith("/enrichment") && method === "PATCH") {
      return json({ enrichment: (body as { enrichment: FactEnrichment }).enrichment });
    }
    // GET /api/admin/facts/:id (fact detail)
    return json({ id: factId, enrichment, enrichmentStatus: "ok" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function renderEditing(initial: UseFactEnrichmentEditingOptions) {
  return renderHook((p: UseFactEnrichmentEditingOptions) => useFactEnrichmentEditing(p), {
    initialProps: initial,
  });
}

describe("useFactEnrichmentEditing", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("moderation commit pins suggestedHashtags to the server value (anti-smuggle guard)", async () => {
    const { calls } = mockFetch({ 7: makeEnrichment() });
    const { result } = renderEditing({
      target: { kind: "fact", factId: 7 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    // A stale draft carries BOTH a hashtag change (not editable here) and a
    // VSO edit (editable here).
    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        suggestedHashtags: ["stale-client-value"],
        visualPromptStrategyOverride: VSO,
      })),
    );
    expect(result.current.draft.hasUncommittedChanges).toBe(true);

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.draft.save(); });
    expect(ok).toBe(true);

    const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/admin/facts/7/enrichment");
    expect(patch).toBeDefined();
    const sent = (patch!.body as { enrichment: FactEnrichment }).enrichment;
    // The hashtag edit was overlaid with the server value; the VSO edit went through.
    expect(sent.suggestedHashtags).toEqual(["ai-original"]);
    expect(sent.visualPromptStrategyOverride?.requiredVisualDetails).toEqual(["adult head on a newborn body"]);
  });

  it("the Facts-page surface (both fields editable) commits the hashtag edit as-is", async () => {
    const { calls } = mockFetch({ 7: makeEnrichment() });
    const { result } = renderEditing({ target: { kind: "fact", factId: 7 }, enabled: true });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        suggestedHashtags: ["curated-by-admin"],
      })),
    );
    await act(async () => { await result.current.draft.save(); });

    const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/admin/facts/7/enrichment");
    expect((patch!.body as { enrichment: FactEnrichment }).enrichment.suggestedHashtags).toEqual(["curated-by-admin"]);
  });

  it("enabled=false: no fetches, null enrichment, no overrideContext", async () => {
    const { calls } = mockFetch({ 7: makeEnrichment() });
    const { result } = renderEditing({ target: { kind: "fact", factId: 7 }, enabled: false });

    // Give any (wrong) async work a chance to fire before asserting silence.
    await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.url.includes("/api/admin/facts"))).toEqual([]);
    expect(result.current.enrichment).toBeNull();
    expect(result.current.overrideContext).toBeUndefined();
    expect(result.current.draft.hasUncommittedChanges).toBe(false);
  });

  it("flipping enabled false→true fetches detail + resolved for the fact", async () => {
    const { calls } = mockFetch({ 7: makeEnrichment() });
    const { result, rerender } = renderEditing({ target: { kind: "fact", factId: 7 }, enabled: false });

    rerender({ target: { kind: "fact", factId: 7 }, enabled: true });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());
    expect(result.current.enrichment?.suggestedHashtags).toEqual(["ai-original"]);
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/admin/facts/7")).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/admin/facts/7/enrichment-resolved")).toBe(true);
    await waitFor(() => expect(result.current.overrideContext).toBeDefined());
  });

  it("switching factId A→B loads B's state without leaking A's", async () => {
    const { calls } = mockFetch({
      7: makeEnrichment({ suggestedHashtags: ["fact-a"] }),
      8: makeEnrichment({ suggestedHashtags: ["fact-b"], visualComplexity: "high" }),
    });
    const { result, rerender } = renderEditing({ target: { kind: "fact", factId: 7 }, enabled: true });
    await waitFor(() => expect(result.current.enrichment?.suggestedHashtags).toEqual(["fact-a"]));

    rerender({ target: { kind: "fact", factId: 8 }, enabled: true });
    await waitFor(() => expect(result.current.enrichment?.suggestedHashtags).toEqual(["fact-b"]));
    expect(result.current.enrichment?.visualComplexity).toBe("high");
    expect(result.current.draft.hasUncommittedChanges).toBe(false);
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/admin/facts/8/enrichment-resolved")).toBe(true);
  });

  // ── reviewCandidate target (refresh cycles) ────────────────────────────────

  /** Stub fetch for CANDIDATE mode: only the review-scoped endpoints exist;
   *  any /api/admin/facts call is the bug the target abstraction prevents. */
  function mockCandidateFetch(
    reviewId: number,
    enrichment: FactEnrichment,
    opts: { failPut?: { status: number; error: string; code: string } } = {},
  ) {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, method, body });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

      if (u === `/api/admin/reviews/${reviewId}/candidate-enrichment-resolved`) {
        return json({
          aiDerived: enrichment, overrides: {}, effective: enrichment,
          overrideSummary: EMPTY_SUMMARY, enrichmentStatus: "ok", factId: 42, candidateVersionId: 9,
        });
      }
      if (u === `/api/admin/reviews/${reviewId}/candidate-enrichment` && method === "PATCH") {
        return json({ success: true, enrichment: (body as { enrichment: FactEnrichment }).enrichment });
      }
      if (u.startsWith(`/api/admin/reviews/${reviewId}/candidate-overrides`)) {
        if (opts.failPut) return json({ error: opts.failPut.error, code: opts.failPut.code }, opts.failPut.status);
        return json({ aiDerived: enrichment, overrides: {}, effective: enrichment, overrideSummary: EMPTY_SUMMARY });
      }
      // Anything else — most importantly /api/admin/facts/* — is a wrong-target bug.
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls };
  }

  it("candidate target: every read/write hits the review-scoped endpoints, never /api/admin/facts", async () => {
    const { calls } = mockCandidateFetch(31, makeEnrichment());
    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());
    await waitFor(() => expect(result.current.overrideContext).toBeDefined());

    // Tracked override write → candidate endpoint.
    await act(async () => { result.current.overrideContext!.onOverride("/overhypeFit", "questionable"); });
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url === "/api/admin/reviews/31/candidate-overrides")).toBe(true),
    );

    // Draft commit (VSO) → candidate PATCH.
    act(() =>
      result.current.draft.setValue((prev) => ({ ...(prev as FactEnrichment), visualPromptStrategyOverride: VSO })),
    );
    await act(async () => { await result.current.draft.save(); });
    expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/admin/reviews/31/candidate-enrichment")).toBe(true);

    // The invariant: nothing ever touched a fact URL.
    expect(calls.filter((c) => c.url.includes("/api/admin/facts"))).toEqual([]);
  });

  it("candidate target: distinct draft namespace + supportsRerun=false (no /enrich call ever)", async () => {
    const { calls } = mockCandidateFetch(31, makeEnrichment());
    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({ ...(prev as FactEnrichment), visualPromptStrategyOverride: VSO })),
    );
    // The draft persist is debounced (1.5s) — wait past it.
    await waitFor(
      () => expect(window.localStorage.getItem("candidate-enrichment-draft::31")).not.toBeNull(),
      { timeout: 4000 },
    );
    expect(window.localStorage.getItem("fact-enrichment-draft::42")).toBeNull();

    expect(result.current.supportsRerun).toBe(false);
    await act(async () => { await result.current.rerunWithConfirm(); });
    expect(calls.filter((c) => c.url.includes("/enrich"))).toEqual([]);
  });

  it("candidate target: a failed override write surfaces the server's message", async () => {
    mockCandidateFetch(31, makeEnrichment(), {
      failPut: {
        status: 409,
        error: "This refresh was already promoted — its candidate can no longer be edited.",
        code: "CANDIDATE_NOT_PENDING",
      },
    });
    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
    });
    await waitFor(() => expect(result.current.overrideContext).toBeDefined());

    await act(async () => { result.current.overrideContext!.onOverride("/overhypeFit", "questionable"); });
    await waitFor(() => expect(result.current.overrideError).toMatch(/already promoted/));
    expect(result.current.overrideContext?.pending["/overhypeFit"]).toBe("error");
  });

  // ── flushOverrides: the terminal-action race guard ──────────────────────────
  // A field blurred by the same click that fires promote/reject starts an
  // un-awaited override write; the terminal action flushes it first so the
  // candidate isn't marked non-pending mid-write (which drops the edit).

  it("flushOverrides awaits an in-flight override write and reports success", async () => {
    const { calls } = mockCandidateFetch(31, makeEnrichment());
    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
    });
    await waitFor(() => expect(result.current.overrideContext).toBeDefined());

    let flushed: boolean | undefined;
    await act(async () => {
      // Start the write but do NOT await it — exactly what a field blur does.
      result.current.overrideContext!.onOverride("/overhypeFit", "questionable");
      // The terminal action then flushes before proceeding.
      flushed = await result.current.flushOverrides();
    });

    expect(flushed).toBe(true);
    // The write actually landed (pending cleared) against the candidate endpoint.
    expect(result.current.overrideContext?.pending["/overhypeFit"]).toBeUndefined();
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/admin/reviews/31/candidate-overrides")).toBe(true);
  });

  it("flushOverrides reports failure when an in-flight override write fails", async () => {
    mockCandidateFetch(31, makeEnrichment(), {
      failPut: { status: 409, error: "already promoted", code: "CANDIDATE_NOT_PENDING" },
    });
    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
    });
    await waitFor(() => expect(result.current.overrideContext).toBeDefined());

    let flushed: boolean | undefined;
    await act(async () => {
      result.current.overrideContext!.onOverride("/overhypeFit", "questionable");
      flushed = await result.current.flushOverrides();
    });

    // The terminal action sees the failure and can abort instead of promoting
    // over a dropped edit.
    expect(flushed).toBe(false);
    expect(result.current.overrideContext?.pending["/overhypeFit"]).toBe("error");
  });

  it("flushOverrides resolves true immediately when nothing is in flight", async () => {
    mockCandidateFetch(31, makeEnrichment());
    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
    });
    await waitFor(() => expect(result.current.overrideContext).toBeDefined());

    let flushed: boolean | undefined;
    await act(async () => { flushed = await result.current.flushOverrides(); });
    expect(flushed).toBe(true);
  });
});
