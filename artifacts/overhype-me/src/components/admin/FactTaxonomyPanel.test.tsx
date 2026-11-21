/**
 * The Facts editor's AI taxonomy: read-only, with "Re-run" (plan
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, oracle items 15 and 16).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { buildPlaceholderFactEnrichment, type FactEnrichment } from "@workspace/api-zod";
import { FactTaxonomyPanel } from "./FactTaxonomyPanel";

const STORED: FactEnrichment = {
  ...buildPlaceholderFactEnrichment(),
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  suggestedHashtags: ["strength", "pushups", "earth"],
};

function stub(detail: { enrichment: FactEnrichment | null; enrichmentStatus: string | null }) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method });
    const body = method === "POST" ? { success: true, enrichmentStatus: "pending" } : detail;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("FactTaxonomyPanel", () => {
  it("shows the stored taxonomy and offers nothing that edits it", async () => {
    stub({ enrichment: STORED, enrichmentStatus: "ok" });
    const { container } = render(<FactTaxonomyPanel factId={7} initialStatus="ok" />);
    const summary = await screen.findByTestId("taxonomy-summary");
    expect(summary.textContent).toContain("superhuman_physical_feat");
    expect(summary.textContent).toContain("strength, pushups, earth");
    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(screen.getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Re-run"]);
  });

  it("Re-run asks first, then starts a run on the fact", async () => {
    const calls = stub({ enrichment: STORED, enrichmentStatus: "ok" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<FactTaxonomyPanel factId={7} initialStatus="ok" />);
    await screen.findByTestId("taxonomy-summary");

    fireEvent.click(screen.getByTestId("taxonomy-rerun"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(screen.getByTestId("taxonomy-rerun"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/admin/facts/7/enrich" && c.method === "POST")).toBe(true));
    // The previous result stays on screen while the new run is in flight.
    expect(await screen.findByTestId("taxonomy-status-running")).toBeTruthy();
    expect(screen.getByTestId("taxonomy-summary")).toBeTruthy();
  });

  it("says when a run failed or there is no taxonomy, and blocks nothing", async () => {
    stub({ enrichment: null, enrichmentStatus: "failed" });
    render(<FactTaxonomyPanel factId={8} initialStatus="failed" />);
    expect((await screen.findByTestId("taxonomy-status-failed")).textContent).toMatch(/last run failed/i);
    expect(screen.getByTestId("taxonomy-missing")).toBeTruthy();
    expect((screen.getByTestId("taxonomy-rerun") as HTMLButtonElement).disabled).toBe(false);
  });
});
