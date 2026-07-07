/**
 * Taxonomy Health page — PR4 bulk send-back UI.
 *
 * Focus: the "Send next 50 stale" / "Send selected" controls only appear on
 * the Stale-for-reprocess card, the corpus-wide button confirms before firing
 * and posts `{scope:"all_stale"}`, row checkboxes drive "Send selected" with
 * exactly the checked ids, and the single-row send-back button now posts
 * through the SAME bulk-send-back endpoint (the unification) rather than the
 * old direct Facts-editor endpoint.
 *
 * AdminLayout is stubbed to a passthrough so the test needs no auth provider.
 * Action responses return jobs:[] (an inline/immediately-terminal shape) so
 * no polling is needed — this file only exercises the click → POST contract,
 * not the async job lifecycle (covered by useTaxonomyHealthActions.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  CLASSIFICATION_PROMPT_VERSION,
  type FactTaxonomyHealth,
  type TaxonomyHealthReviewFlags,
} from "@workspace/api-zod";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import TaxonomyHealth from "./taxonomy-health";

const NO_FLAGS: TaxonomyHealthReviewFlags = {
  lowConfidence: false,
  questionableFit: false,
  rejectFit: false,
  adultRequiresReview: false,
  culturalReferenceNeedsResearch: false,
  semanticEntityNeedsReview: false,
  staleEnrichmentVersion: false,
  staleForReprocess: false,
  projectionMismatch: false,
  invalidEnrichment: false,
};

function makeHealth(factId: number): FactTaxonomyHealth {
  return {
    factId,
    overallStatus: "healthy",
    statuses: ["stale_for_reprocess"],
    issues: [{ code: "stale_for_reprocess", severity: "info", message: "Send it back to refresh.", recommendedAction: "send_back_to_review" }],
    reviewFlags: { ...NO_FLAGS, staleForReprocess: true },
    summary: {
      primaryArchetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      taxonomyConfidence: 0.9,
      overhypeFit: "strong",
      adultSuitability: "safe",
      taxonomyVersion: "v1",
      classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
      visualStrategyVersion: "v2",
      enrichedAt: null,
      enrichedBy: "openai",
    },
  };
}

function makeRow(factId: number, text: string) {
  return {
    factId,
    factText: text,
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    overhypeFit: "strong",
    adultSuitability: "safe",
    taxonomyConfidence: 0.9,
    health: makeHealth(factId),
    updatedAt: null,
    refreshInReview: false,
  };
}

const ROWS = [makeRow(1, "Stale fact one."), makeRow(2, "Stale fact two.")];

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
          totalFacts: 2, healthy: 0, missingEnrichment: 0, invalidEnrichment: 0,
          needsAdminReview: 0, staleEnrichmentVersion: 0, staleForReprocess: 2,
          projectionMismatch: 0, incompleteCulturalReferences: 0,
          semanticEntitiesNeedReview: 0, lowConfidence: 0, engineRevision: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/actions/bulk-send-back")) {
      const factIds = (body?.scope === "selected" ? body.factIds : ROWS.map((r) => r.factId)) as number[];
      return new Response(
        JSON.stringify({
          mode: "inline",
          jobs: [],
          outcomes: factIds.map((factId) => ({ factId, action: "send_back_to_review", status: "done", message: "Refresh started." })),
          summary: { requested: factIds.length, queued: 0, done: factIds.length, failed: 0, skipped: 0 },
          totalStale: 2,
          eligibleRemaining: 2 - factIds.length,
          batchLimit: 50,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/facts")) {
      return new Response(
        JSON.stringify({ rows: ROWS, total: ROWS.length, limit: 100, offset: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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

async function switchToStaleForReprocessCard() {
  const button = await screen.findByText("Stale for reprocess");
  button.click();
}

beforeEach(() => mockFetch());
afterEach(() => vi.unstubAllGlobals());

describe("TaxonomyHealth — bulk send-back", () => {
  it("the bulk send-back controls only appear on the Stale-for-reprocess card", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("engine-revision")).toBeTruthy());
    expect(screen.queryByTestId("send-back-all-stale")).toBeNull();
    expect(screen.queryByTestId("send-back-selected")).toBeNull();

    await switchToStaleForReprocessCard();
    await waitFor(() => expect(screen.getByTestId("send-back-all-stale")).toBeTruthy());
    expect(screen.getByTestId("send-back-selected")).toBeTruthy();
  });

  it("'Send next 50 stale' confirms before firing and posts scope:all_stale", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = mockFetch();
    renderPage();
    await switchToStaleForReprocessCard();
    const btn = await screen.findByTestId("send-back-all-stale");
    btn.click();
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("bulk-send-back") && (c.body as { scope?: string })?.scope === "all_stale")).toBe(true),
    );
    confirmSpy.mockRestore();
  });

  it("declining the confirm never fires the request", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { calls } = mockFetch();
    renderPage();
    await switchToStaleForReprocessCard();
    const btn = await screen.findByTestId("send-back-all-stale");
    btn.click();
    expect(confirmSpy).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST" && c.url.includes("bulk-send-back"))).toBe(false);
    confirmSpy.mockRestore();
  });

  it("'Send selected' is disabled with no rows checked, and posts exactly the checked factIds", async () => {
    const { calls } = mockFetch();
    renderPage();
    await switchToStaleForReprocessCard();

    const selectedBtn = await screen.findByTestId("send-back-selected");
    expect((selectedBtn as HTMLButtonElement).disabled).toBe(true);

    const row1 = (await screen.findByText("Stale fact one.")).closest("tr") as HTMLElement;
    const checkbox = within(row1).getByTestId("send-back-select");
    checkbox.click();

    await waitFor(() => expect((selectedBtn as HTMLButtonElement).disabled).toBe(false));
    expect(selectedBtn.textContent).toContain("Send selected (1)");

    selectedBtn.click();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.url.includes("bulk-send-back") &&
            (c.body as { scope?: string; factIds?: number[] })?.scope === "selected" &&
            JSON.stringify((c.body as { factIds?: number[] }).factIds) === JSON.stringify([1]),
        ),
      ).toBe(true),
    );
  });

  it("the unified single-row 'Send back to review' posts through the bulk-send-back endpoint (not the old Facts-editor endpoint)", async () => {
    const { calls } = mockFetch();
    renderPage();
    await switchToStaleForReprocessCard();
    const row1 = (await screen.findByText("Stale fact one.")).closest("tr") as HTMLElement;
    const sendBtn = within(row1).getByTestId("send-back-to-review");
    sendBtn.click();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.url.includes("/api/admin/taxonomy-health/actions/bulk-send-back") &&
            (c.body as { scope?: string; factIds?: number[] })?.scope === "selected" &&
            JSON.stringify((c.body as { factIds?: number[] }).factIds) === JSON.stringify([1]),
        ),
      ).toBe(true),
    );
    expect(calls.some((c) => c.url.includes("/send-back-to-review") && !c.url.includes("bulk-send-back"))).toBe(false);
  });
});
