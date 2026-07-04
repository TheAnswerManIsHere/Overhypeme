/**
 * EvalDashboard — the /admin/eval page. AdminLayout is stubbed (it pulls auth +
 * wouter context); we test the dashboard content: golden set, runs, run N-vs-N-1
 * diff, opportunistic-separated-as-directional, and the cost-confirmed start-run
 * flow with per-item status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import EvalDashboard from "./evalDashboard";

const DASHBOARD = {
  goldenFacts: [{ id: 11, text: "Fact eleven" }, { id: 12, text: "Fact twelve" }],
  runs: [
    { id: 2, label: "cur", createdAt: new Date().toISOString(), aggregate: { count: 2, ratedCount: 2, avgRating: 4.5, tagDistribution: { concept: 0, compiler: 0, image_model: 0, none: 1 } }, byFact: [{ factId: 11, signatures: [{ signatureKey: "k", signature: { scenarioKey: "generic_t2i", actualImageEngineId: "nano", subjectRenderMode: "t2i_fallback" }, attempts: [{ attemptId: 100, factId: 11, status: "image_ready", rating: 4, failureTag: null }] }] }] },
    { id: 1, label: "prev", createdAt: new Date().toISOString(), aggregate: { count: 2, ratedCount: 2, avgRating: 3, tagDistribution: { concept: 1, compiler: 0, image_model: 0, none: 0 } }, byFact: [] },
  ],
  runDiff: { currentRunId: 2, previousRunId: 1, avgRatingDelta: 1.5, tagDeltas: [{ tag: "concept", current: 0, previous: 1, delta: -1 }] },
  opportunistic: { count: 1, ratedCount: 1, avgRating: 1, tagDistribution: { concept: 0, compiler: 0, image_model: 1, none: 0 } },
};

function routeFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/eval/dashboard")) return { ok: true, json: async () => DASHBOARD } as unknown as Response;
    if (url.endsWith("/eval/runs") && init?.method === "POST") return { ok: true, json: async () => ({ runId: 99, items: [] }) } as unknown as Response;
    if (url.includes("/eval/runs/99")) return { ok: true, json: async () => (overrides.runStatus ?? { run: { id: 99, label: null }, items: [{ attemptId: 1, factId: 11, scenarioKey: "generic_t2i", status: "pending" }], tally: { total: 1, done: 0, failed: 0, blocked: 0, working: 1 } }) } as unknown as Response;
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
}

beforeEach(() => { vi.stubGlobal("fetch", routeFetch()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("EvalDashboard", () => {
  it("renders the golden set, runs, the run N-vs-N-1 diff, and opportunistic (directional)", async () => {
    render(<EvalDashboard />);
    await waitFor(() => expect(screen.getByTestId("eval-golden-list")).toBeTruthy());
    expect(screen.getByText("Fact eleven")).toBeTruthy();
    expect(screen.getByText("Fact twelve")).toBeTruthy();
    // Two runs render.
    expect(screen.getAllByTestId("eval-run").length).toBe(2);
    // Run diff renders with the +1.50 avg delta.
    const diff = screen.getByTestId("eval-run-diff");
    expect(diff.textContent).toMatch(/\+1\.50/);
    // Opportunistic is separated + labeled directional.
    const opp = screen.getByTestId("eval-opportunistic");
    expect(opp.textContent?.toLowerCase()).toMatch(/directional only/);
  });

  it("Start eval run shows a cost confirmation, then posts and shows per-item status", async () => {
    const fetchFn = routeFetch();
    vi.stubGlobal("fetch", fetchFn);
    render(<EvalDashboard />);
    await waitFor(() => expect(screen.getByTestId("eval-golden-list")).toBeTruthy());

    fireEvent.click(screen.getByTestId("eval-start-run"));
    const confirm = screen.getByTestId("eval-run-confirm");
    expect(confirm.textContent).toMatch(/real image-model spend/i);
    expect(confirm.textContent).toMatch(/every golden fact \(2\)/i);

    await act(async () => { fireEvent.click(screen.getByTestId("eval-run-confirm-yes")); });
    // POST /eval/runs happened.
    expect(fetchFn.mock.calls.some((c) => String(c[0]).endsWith("/eval/runs") && (c[1] as RequestInit)?.method === "POST")).toBe(true);
    // The active-run per-item status panel appears.
    await waitFor(() => expect(screen.getByTestId("eval-active-run")).toBeTruthy());
  });

  it("disables Start when there are no golden facts", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/eval/dashboard")) return { ok: true, json: async () => ({ ...DASHBOARD, goldenFacts: [] }) } as unknown as Response;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }));
    render(<EvalDashboard />);
    await waitFor(() => expect(screen.getByTestId("eval-golden-empty")).toBeTruthy());
    expect((screen.getByTestId("eval-start-run") as HTMLButtonElement).disabled).toBe(true);
  });
});
