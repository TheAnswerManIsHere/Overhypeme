/**
 * The Facts editor's AI taxonomy: read-only, with "Re-run" (plan
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, oracle items 15 and 16).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { buildPlaceholderFactEnrichment, type FactEnrichment } from "@workspace/api-zod";
import { FactTaxonomyPanel, type TaxonomyRun } from "./FactTaxonomyPanel";

const STORED: FactEnrichment = {
  ...buildPlaceholderFactEnrichment(),
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  suggestedHashtags: ["strength", "pushups", "earth"],
};

const RUNS: TaxonomyRun[] = [
  { id: 3, outcome: "ok", origin: "rerun", output: STORED, error: null, requestedByName: "Raena Admin", createdAt: "2026-11-21T10:00:00Z" },
  { id: 2, outcome: "failed", origin: "rerun", output: null, error: "the classifier timed out", requestedByName: "Raena Admin", createdAt: "2026-11-21T09:00:00Z" },
  { id: 1, outcome: "ok", origin: "legacy_superseded", output: { ...STORED, primaryArchetype: "object_logic_impossibility" }, error: null, requestedByName: null, createdAt: "2026-01-01T00:00:00Z" },
];

function stub(detail: { enrichment: FactEnrichment | null; enrichmentStatus: string | null }, runs: TaxonomyRun[] = []) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method });
    const body = method === "POST"
      ? { success: true, enrichmentStatus: "pending" }
      : String(url).endsWith("/taxonomy-runs") ? { runs } : detail;
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
    await screen.findByTestId("taxonomy-run-history-empty");
    expect(screen.getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Re-run"]);
  });

  it("lists every run newest first, failures included, and opens an earlier run's output", async () => {
    stub({ enrichment: STORED, enrichmentStatus: "ok" }, RUNS);
    render(<FactTaxonomyPanel factId={7} initialStatus="ok" />);
    await waitFor(() => expect(screen.getAllByTestId("taxonomy-run")).toHaveLength(3));
    const rows = screen.getAllByTestId("taxonomy-run");
    expect(rows.map((r) => r.getAttribute("data-outcome"))).toEqual(["ok", "failed", "ok"]);
    expect(rows[0]!.textContent).toContain("Re-run, by Raena Admin");
    expect(rows[1]!.textContent).toContain("Failed");
    expect(rows[1]!.textContent).toContain("the classifier timed out");
    expect(rows[2]!.textContent).toContain("an earlier version, replaced");
    // A failed run has no output to open.
    expect(rows[1]!.querySelector("[data-testid=taxonomy-run-toggle]")).toBeNull();
    fireEvent.click(rows[2]!.querySelector("[data-testid=taxonomy-run-toggle]")!);
    expect(rows[2]!.querySelector("[data-testid=taxonomy-summary]")!.textContent).toContain("object_logic_impossibility");
  });

  it("names a run kept from before history began (migration 0160) for what it is", async () => {
    const kept: TaxonomyRun = { id: 4, outcome: "ok", origin: "legacy_current", output: STORED, error: null, requestedByName: null, createdAt: "2026-11-21T12:00:00Z" };
    stub({ enrichment: STORED, enrichmentStatus: "ok" }, [kept]);
    render(<FactTaxonomyPanel factId={7} initialStatus="ok" />);
    const [row] = await screen.findAllByTestId("taxonomy-run");
    expect(row!.textContent).toContain("the taxonomy held before run history began");
    expect(row!.textContent).not.toContain(" by ");
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
