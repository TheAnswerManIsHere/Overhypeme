/**
 * The fold and cast fill panel (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, E;
 * Admin UX: per-item and aggregate status in the pattern of Taxonomy Health):
 * the dry-run counts, the two lists with their reasons, and Run.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { GagFoldReport } from "@workspace/api-zod";
import { GagFoldPanel } from "./GagFoldPanel";

vi.mock("wouter", () => ({ Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const REPORT: GagFoldReport = {
  versions: 5,
  fold: { nothing: 2, would_convert: 1, listed: 1, already_converted: 1 },
  cast: { extracted: 2, missing: 2, stale: 0, failed: 1 },
  jobs: { queued: 0, running: 0 },
  forModerator: [{ gagId: 7, factId: 40, slot: 2, stage: "approved", fold: "listed", cast: "missing", reasons: ["violence is set to soften at mild, which changes what the picture shows"], job: null }],
  castMissing: [
    { gagId: 7, factId: 40, slot: 2, stage: "approved", fold: "listed", cast: "missing", reasons: ["the cast has not been read yet"], job: null },
    { gagId: 8, factId: 41, slot: 1, stage: "pending", fold: "nothing", cast: "failed", reasons: ['the scene does not show bubble speaker "nurse"'], job: { status: "done", error: null } },
  ],
};

function stub(report: GagFoldReport) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const body = String(url).endsWith("/run") ? { requested: 4, queued: 4, deduped: 0 } : report;
    return new Response(JSON.stringify(body), { status: String(url).endsWith("/run") ? 202 : 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("GagFoldPanel", () => {
  it("shows what a run would do, and the two lists with each version's reason", async () => {
    stub(REPORT);
    render(<GagFoldPanel />);
    const counts = await screen.findByTestId("gag-fold-counts");
    expect(counts.textContent).toContain("Would fold 1");
    expect(counts.textContent).toContain("Listed for a moderator 1");
    expect(counts.textContent).toContain("Cast failed 1");
    const listed = screen.getByTestId("gag-fold-for-moderator");
    expect(within(listed).getByText(/Fact #40 · gag 2 · approved version/)).toBeTruthy();
    expect(within(listed).getByText(/violence is set to soften/)).toBeTruthy();
    const missing = screen.getByTestId("gag-fold-cast-missing");
    expect(within(missing).getByText(/Fact #41 · gag 1 · pending change/)).toBeTruthy();
    expect(within(missing).getByText(/does not show bubble speaker "nurse"/)).toBeTruthy();
    expect(screen.getByTestId("gag-fold-run").textContent).toContain("Run on 4 versions");
  });

  it("starts a run on Run and says how many were queued", async () => {
    const calls = stub(REPORT);
    render(<GagFoldPanel />);
    await screen.findByTestId("gag-fold-counts");
    fireEvent.click(screen.getByTestId("gag-fold-run"));
    await waitFor(() => expect(screen.getByTestId("gag-fold-started").textContent).toContain("4 queued"));
    expect(calls.some((c) => c.url === "/api/admin/gag-fold/run" && c.method === "POST")).toBe(true);
  });

  it("has nothing to run when every version is done, and says both lists are empty", async () => {
    stub({ ...REPORT, fold: { nothing: 3, would_convert: 0, listed: 0, already_converted: 2 }, cast: { extracted: 5, missing: 0, stale: 0, failed: 0 }, forModerator: [], castMissing: [] });
    render(<GagFoldPanel />);
    await screen.findByTestId("gag-fold-counts");
    expect((screen.getByTestId("gag-fold-run") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Nothing listed/)).toBeTruthy();
    expect(screen.getByText(/Every version has a cast/)).toBeTruthy();
  });
});
