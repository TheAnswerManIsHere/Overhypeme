/**
 * Taxonomy Health page — Bulk Media Backfill panel (task 17).
 *
 * Focus: the panel is always visible (not gated by card filter), each of the
 * three buttons confirms before firing and posts to its own route, and a
 * declined confirm never fires the request.
 *
 * AdminLayout is stubbed to a passthrough so the test needs no auth provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import TaxonomyHealth from "./taxonomy-health";

interface Call { url: string; method: string; body?: unknown }

function mockFetch() {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    const body = opts?.body ? JSON.parse(opts.body as string) : undefined;
    calls.push({ url: u, method, body });
    if (u.includes("/summary")) {
      return new Response(
        JSON.stringify({
          totalFacts: 0, healthy: 0, missingEnrichment: 0, invalidEnrichment: 0,
          needsAdminReview: 0, staleEnrichmentVersion: 0, staleForReprocess: 0,
          projectionMismatch: 0, incompleteCulturalReferences: 0,
          semanticEntitiesNeedReview: 0, lowConfidence: 0, engineRevision: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/backfill-images") || u.includes("/backfill-pexels") || u.includes("/backfill-ai-memes")) {
      return new Response(
        JSON.stringify({ success: true, jobs: [{ factId: 1, jobId: 501, deduped: false }], outcomes: [], summary: { requested: 1, queued: 1, skipped: 0 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/taxonomy-health/facts")) {
      return new Response(JSON.stringify({ rows: [], total: 0, limit: 100, offset: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function renderPage() {
  const { hook } = memoryLocation({ path: "/admin/taxonomy-health" });
  return render(<Router hook={hook}><TaxonomyHealth /></Router>);
}

beforeEach(() => mockFetch());
afterEach(() => vi.unstubAllGlobals());

describe("TaxonomyHealth — Bulk Media Backfill panel", () => {
  it("is visible regardless of the selected card filter (not gated like send-back)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bulk-media-backfill-panel")).toBeTruthy());
    expect(screen.getByTestId("bulk-backfill-images-button")).toBeTruthy();
    expect(screen.getByTestId("bulk-backfill-pexels-button")).toBeTruthy();
    expect(screen.getByTestId("bulk-backfill-ai-memes-button")).toBeTruthy();
  });

  it("'Backfill images' confirms before firing and posts to backfill-images", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = mockFetch();
    renderPage();
    const btn = await screen.findByTestId("bulk-backfill-images-button");
    btn.click();
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/admin/facts/backfill-images"))).toBe(true),
    );
    confirmSpy.mockRestore();
  });

  it("'Backfill Pexels' posts to the distinct backfill-pexels route", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = mockFetch();
    renderPage();
    const btn = await screen.findByTestId("bulk-backfill-pexels-button");
    btn.click();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/admin/backfill-pexels"))).toBe(true),
    );
    confirmSpy.mockRestore();
  });

  it("'Backfill AI memes' posts to backfill-ai-memes", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = mockFetch();
    renderPage();
    const btn = await screen.findByTestId("bulk-backfill-ai-memes-button");
    btn.click();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/admin/facts/backfill-ai-memes"))).toBe(true),
    );
    confirmSpy.mockRestore();
  });

  it("declining the confirm never fires the request", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { calls } = mockFetch();
    renderPage();
    const btn = await screen.findByTestId("bulk-backfill-images-button");
    btn.click();
    expect(confirmSpy).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST" && c.url.includes("backfill-images"))).toBe(false);
    confirmSpy.mockRestore();
  });

  it("shows a done/queued status line after the jobs resolve", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockFetch();
    renderPage();
    const btn = await screen.findByTestId("bulk-backfill-images-button");
    btn.click();
    await waitFor(() => expect(screen.getByTestId("bulk-backfill-images-status").textContent).toContain("of 1 done"));
    confirmSpy.mockRestore();
  });
});
