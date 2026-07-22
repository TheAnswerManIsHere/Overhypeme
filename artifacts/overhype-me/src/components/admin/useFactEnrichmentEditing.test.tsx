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
import { createLocalStorageAdapter } from "@/lib/form-draft-storage";

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
  bubbles: [],
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

interface TokenizeResultEntry {
  path: string;
  value: string;
  changed: boolean;
  usedLlm: boolean;
  error?: string;
  errorKind?: string;
}
type TokenizeHandler = (body: {
  entries: { path: string; value: string; kind: string }[];
  subjectContext?: { names: string[] };
}) => { results: TokenizeResultEntry[] };

const echoTokenizeHandler: TokenizeHandler = (body) => ({
  results: body.entries.map((e) => ({ path: e.path, value: e.value, changed: false, usedLlm: false })),
});

/** Like `mockFetch`, but also serves POST /api/ai/tokenize-enrichment via the
 *  given handler (defaults to an echo — no change, no error, no LLM). */
function mockFetchWithTokenize(
  enrichmentByFact: Record<number, FactEnrichment>,
  tokenizeHandler: TokenizeHandler = echoTokenizeHandler,
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
    calls.push({ url: u, method, body });
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

    if (u === "/api/ai/tokenize-enrichment" && method === "POST") {
      return json(tokenizeHandler(body));
    }

    const factIdMatch = u.match(/\/api\/admin\/facts\/(\d+)/);
    const reviewIdMatch = u.match(/\/api\/admin\/reviews\/(\d+)/);
    if (reviewIdMatch) {
      const reviewId = Number(reviewIdMatch[1]);
      const enrichment = enrichmentByFact[reviewId];
      if (!enrichment) return new Response("{}", { status: 404 });
      if (u.endsWith("/candidate-enrichment-resolved")) {
        return json({
          aiDerived: enrichment, overrides: {}, effective: enrichment,
          overrideSummary: EMPTY_SUMMARY, enrichmentStatus: "ok", factId: 42, candidateVersionId: 9,
        });
      }
      if (u.endsWith("/candidate-enrichment") && method === "PATCH") {
        return json({ success: true, enrichment: (body as { enrichment: FactEnrichment }).enrichment });
      }
      return json({});
    }
    const factId = factIdMatch ? Number(factIdMatch[1]) : 0;
    const enrichment = enrichmentByFact[factId];
    if (!enrichment) return new Response("{}", { status: 404 });
    if (u.endsWith("/enrichment-resolved")) {
      return json({ aiDerived: enrichment, overrides: {}, effective: enrichment, overrideSummary: EMPTY_SUMMARY });
    }
    if (u.endsWith("/enrichment") && method === "PATCH") {
      return json({ enrichment: (body as { enrichment: FactEnrichment }).enrichment });
    }
    return json({ id: factId, enrichment, enrichmentStatus: "ok" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
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

  it("candidate target: ignores stale restored fields outside the editable visual-strategy draft", async () => {
    const server = makeEnrichment({
      primaryArchetype: "superhuman_physical_feat",
      visualPromptStrategyOverride: VSO,
    });
    createLocalStorageAdapter<FactEnrichment>({ key: "candidate-enrichment-draft::31" }).save(
      makeEnrichment({
        primaryArchetype: "object_logic_impossibility",
        visualPromptStrategyOverride: VSO,
      }),
    );
    mockCandidateFetch(31, server);

    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });

    await waitFor(() => expect(result.current.enrichment).not.toBeNull());
    await waitFor(() => expect(result.current.draft.hasUncommittedChanges).toBe(false));
    expect(result.current.enrichment?.primaryArchetype).toBe("superhuman_physical_feat");
    expect(window.localStorage.getItem("candidate-enrichment-draft::31")).toBeNull();
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

  // ── tokenizeAndSaveVisualOverride: auto-tokenize on Save ────────────────────

  it("diffs against the server baseline and sends only the changed non-empty VSO entries", async () => {
    const baselineVso = { ...VSO, requiredVisualDetails: ["a baseline detail"] };
    const { calls } = mockFetchWithTokenize({ 7: makeEnrichment({ visualPromptStrategyOverride: baselineVso }) });
    const { result } = renderEditing({
      target: { kind: "fact", factId: 7 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        visualPromptStrategyOverride: {
          ...baselineVso,
          requiredVisualDetails: ["a baseline detail", "a brand new detail"],
        },
      })),
    );

    await act(async () => { await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });

    const tokenizeCall = calls.find((c) => c.url === "/api/ai/tokenize-enrichment");
    expect(tokenizeCall).toBeDefined();
    const entries = (tokenizeCall!.body as { entries: { path: string }[] }).entries;
    expect(entries.map((e) => e.path)).toEqual(["requiredVisualDetails[1]"]);
  });

  it("no changed entries: persists the whole enrichment without hitting the tokenize route", async () => {
    const { calls } = mockFetchWithTokenize({ 7: makeEnrichment({ visualPromptStrategyOverride: VSO }) });
    const { result } = renderEditing({
      target: { kind: "fact", factId: 7 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.url === "/api/ai/tokenize-enrichment")).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/admin/facts/7/enrichment")).toBe(true);
  });

  it("candidate target: tokenizeAndSaveVisualOverride hits the batch route then the candidate PATCH", async () => {
    const { calls } = mockFetchWithTokenize({ 31: makeEnrichment() });
    const { result } = renderEditing({
      target: { kind: "reviewCandidate", reviewId: 31, factId: 42 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({ ...(prev as FactEnrichment), visualPromptStrategyOverride: VSO })),
    );

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.url === "/api/ai/tokenize-enrichment")).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/admin/reviews/31/candidate-enrichment")).toBe(true);
  });

  it("REGRESSION (same-click Save): PATCH body contains the tokenized value, not stale plain English", async () => {
    const tokenizeHandler: TokenizeHandler = (body) => ({
      results: body.entries.map((e) => ({
        path: e.path,
        value: e.value.replace(/David/g, "{NAME}"),
        changed: true,
        usedLlm: true,
      })),
    });
    const { calls } = mockFetchWithTokenize(
      { 7: makeEnrichment({ visualPromptStrategyOverride: VSO }) },
      tokenizeHandler,
    );
    const { result } = renderEditing({
      target: { kind: "fact", factId: 7 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "David leans against the bar." },
      })),
    );

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    expect(ok).toBe(true);

    const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/admin/facts/7/enrichment");
    expect(patch).toBeDefined();
    const sentVso = (patch!.body as { enrichment: FactEnrichment }).enrichment.visualPromptStrategyOverride;
    expect(sentVso?.coreSceneOverride).toBe("{NAME} leans against the bar.");
  });

  it("hashtag-only dirty draft still persists through tokenizeAndSaveVisualOverride", async () => {
    const { calls } = mockFetchWithTokenize({ 7: makeEnrichment({ visualPromptStrategyOverride: VSO }) });
    const { result } = renderEditing({ target: { kind: "fact", factId: 7 }, enabled: true });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({ ...(prev as FactEnrichment), suggestedHashtags: ["new-tag"] })),
    );

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    expect(ok).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/admin/facts/7/enrichment");
    expect((patch!.body as { enrichment: FactEnrichment }).enrichment.suggestedHashtags).toEqual(["new-tag"]);
  });

  it("mixed hashtag + VSO dirty draft persists both", async () => {
    const tokenizeHandler: TokenizeHandler = (body) => ({
      results: body.entries.map((e) => ({ path: e.path, value: e.value.replace(/David/g, "{NAME}"), changed: true, usedLlm: true })),
    });
    const { calls } = mockFetchWithTokenize(
      { 7: makeEnrichment({ visualPromptStrategyOverride: VSO }) },
      tokenizeHandler,
    );
    const { result } = renderEditing({ target: { kind: "fact", factId: 7 }, enabled: true });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        suggestedHashtags: ["new-tag"],
        visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "David leans against the bar." },
      })),
    );

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    expect(ok).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/admin/facts/7/enrichment");
    const sent = (patch!.body as { enrichment: FactEnrichment }).enrichment;
    expect(sent.suggestedHashtags).toEqual(["new-tag"]);
    expect(sent.visualPromptStrategyOverride?.coreSceneOverride).toBe("{NAME} leans against the bar.");
  });

  it("an error blocks the PATCH, sets vsoTokenizeErrors, and leaves the draft dirty (blocks terminal actions)", async () => {
    const tokenizeHandler: TokenizeHandler = (body) => ({
      results: body.entries.map((e) => ({
        path: e.path,
        value: e.value,
        changed: false,
        usedLlm: false,
        error: "unbalanced token",
        errorKind: "grammar",
      })),
    });
    const { calls } = mockFetchWithTokenize(
      { 7: makeEnrichment({ visualPromptStrategyOverride: VSO }) },
      tokenizeHandler,
    );
    const { result } = renderEditing({
      target: { kind: "fact", factId: 7 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "a broken scene" },
      })),
    );

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    expect(ok).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(result.current.vsoTokenizeErrors["coreSceneOverride"]).toBe("unbalanced token");
    // Tokenized-but-blocked state is still dirty — terminal actions stay blocked.
    expect(result.current.draft.hasUncommittedChanges).toBe(true);
  });

  it("clears a field's tokenize error once its value changes again", async () => {
    const tokenizeHandler: TokenizeHandler = (body) => ({
      results: body.entries.map((e) => ({
        path: e.path, value: e.value, changed: false, usedLlm: false, error: "bad", errorKind: "grammar",
      })),
    });
    mockFetchWithTokenize({ 7: makeEnrichment({ visualPromptStrategyOverride: VSO }) }, tokenizeHandler);
    const { result } = renderEditing({
      target: { kind: "fact", factId: 7 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment).not.toBeNull());

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "a broken scene" },
      })),
    );
    await act(async () => { await result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    expect(result.current.vsoTokenizeErrors["coreSceneOverride"]).toBe("bad");

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "an edited scene" },
      })),
    );
    expect(result.current.vsoTokenizeErrors["coreSceneOverride"]).toBeUndefined();
  });

  it("a stale tokenize response from a since-abandoned target cannot mutate the now-active target", async () => {
    let resolveTokenize!: (value: Response) => void;
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      const method = opts?.method ?? "GET";
      const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
      calls.push({ url: u, method, body });
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u === "/api/ai/tokenize-enrichment" && method === "POST") {
        return new Promise<Response>((resolve) => { resolveTokenize = resolve; });
      }
      const idMatch = u.match(/\/api\/admin\/facts\/(\d+)/);
      const factId = idMatch ? Number(idMatch[1]) : 0;
      const byFact: Record<number, FactEnrichment> = {
        7: makeEnrichment({ visualPromptStrategyOverride: VSO }),
        8: makeEnrichment({ suggestedHashtags: ["fact-b"] }),
      };
      const enrichment = byFact[factId];
      if (!enrichment) return new Response("{}", { status: 404 });
      if (u.endsWith("/enrichment-resolved")) {
        return json({ aiDerived: enrichment, overrides: {}, effective: enrichment, overrideSummary: EMPTY_SUMMARY });
      }
      if (u.endsWith("/enrichment") && method === "PATCH") {
        return json({ enrichment: (body as { enrichment: FactEnrichment }).enrichment });
      }
      return json({ id: factId, enrichment, enrichmentStatus: "ok" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderEditing({
      target: { kind: "fact", factId: 7 },
      enabled: true,
      editableUntrackedFields: ["visualPromptStrategyOverride"],
    });
    await waitFor(() => expect(result.current.enrichment?.visualPromptStrategyOverride).toBeDefined());

    act(() =>
      result.current.draft.setValue((prev) => ({
        ...(prev as FactEnrichment),
        visualPromptStrategyOverride: { ...VSO, coreSceneOverride: "David leans against the bar." },
      })),
    );

    let savePromise!: Promise<boolean>;
    act(() => { savePromise = result.current.tokenizeAndSaveVisualOverride(["David Franklin"]); });
    await waitFor(() => expect(result.current.vsoTokenizing).toBe(true));

    // Navigate away to fact 8 WHILE the tokenize call is still in flight.
    rerender({ target: { kind: "fact", factId: 8 }, enabled: true });
    await waitFor(() => expect(result.current.enrichment?.suggestedHashtags).toEqual(["fact-b"]));

    // Now the stale response for fact 7 lands.
    await act(async () => {
      resolveTokenize(
        new Response(
          JSON.stringify({ results: [{ path: "coreSceneOverride", value: "{NAME} leans against the bar.", changed: true, usedLlm: true }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await savePromise;
    });

    // Fact 8's draft must be untouched by fact 7's stale tokenize result.
    expect(result.current.enrichment?.suggestedHashtags).toEqual(["fact-b"]);
    expect(result.current.enrichment?.visualPromptStrategyOverride).toBeUndefined();
    expect(result.current.vsoTokenizing).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/admin/facts/8/enrichment")).toBe(false);
  });
});
