/**
 * EngineComparison — the launch Phase 8 comparison section on /admin/eval.
 * Creating a set from a round preset, the per-cell grid and aggregate, the
 * bounded estimate, and a planned run's bound or its refusal with the figure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { COMPARISON_DEFAULT_FAMILIES, COMPARISON_ROUND_PRESETS } from "@workspace/api-zod";

import { EngineComparison } from "./EngineComparison";

const DETAIL = {
  set: { id: 7, label: "Round 1", round: 1, engineFamilies: ["a", "b"] },
  panels: [
    { id: 1, factId: 11, scenarioKey: "generic_t2i", lookStyleId: "none", imageMode: "t2i", state: "pending", skipReason: null, error: null,
      cells: [{ id: 1, engineId: "flux-3", state: "expected", skipReason: null, error: null }, { id: 2, engineId: "muse-image", state: "expected", skipReason: null, error: null }] },
  ],
  aggregate: { panels: { pending: 1, prepared: 0, failed: 0, skipped: 0 }, cells: { expected: 2, enqueued: 0, rendered: 0, failed: 0, skipped: 0 } },
  estimate: { preparationBoundUsd: 0.728, renderBoundUsd: 0.058, perEngineBoundUsd: { "flux-3": 0.048, "muse-image": 0.01 } },
};

let posts: Array<{ url: string; body: unknown }> = [];

function routeFetch(plan: unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/comparison/sets") && init?.method === "POST") return { ok: true, json: async () => ({ setId: 7, panels: 15, cells: 90 }) } as unknown as Response;
    if (url.endsWith("/comparison/sets")) return { ok: true, json: async () => ({ sets: [{ id: 7, label: "Round 1", round: 1, createdAt: new Date().toISOString(), panels: 1, cells: 2 }] }) } as unknown as Response;
    if (url.endsWith("/comparison/sets/7")) return { ok: true, json: async () => DETAIL } as unknown as Response;
    if (url.endsWith("/comparison/sets/7/plan")) return { ok: true, json: async () => plan } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
}

beforeEach(() => { posts = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("EngineComparison", () => {
  it("creates a round-1 set from the preset and shows its grid, aggregate and estimate", async () => {
    vi.stubGlobal("fetch", routeFetch(null));
    render(<EngineComparison />);
    fireEvent.change(screen.getByTestId("comparison-fact-ids"), { target: { value: "11, 12 13" } });
    fireEvent.click(screen.getByTestId("comparison-create-submit"));
    await waitFor(() => expect(screen.getByTestId("comparison-detail")).toBeTruthy());
    expect(posts[0]!.body).toMatchObject({
      round: 1,
      factIds: [11, 12, 13],
      scenarioKeys: [...COMPARISON_ROUND_PRESETS[1].scenarioKeys],
      lookStyleIds: ["none"],
      engineFamilies: [...COMPARISON_DEFAULT_FAMILIES],
    });
    expect(screen.getByTestId("comparison-aggregate").textContent).toMatch(/1 pending.*2 expected/);
    expect(screen.getByTestId("comparison-estimate").textContent).toMatch(/preparing \$0\.73 · rendering \$0\.06/);
    expect(screen.getByTestId("comparison-grid").textContent).toMatch(/flux-3.*muse-image/);
  });

  it("refuses fact ids that are not whole numbers without calling the server", async () => {
    vi.stubGlobal("fetch", routeFetch(null));
    render(<EngineComparison />);
    fireEvent.change(screen.getByTestId("comparison-fact-ids"), { target: { value: "11, x" } });
    fireEvent.click(screen.getByTestId("comparison-create-submit"));
    expect((await screen.findByTestId("comparison-error")).textContent).toMatch(/positive whole numbers/);
    expect(posts).toEqual([]);
  });

  it("shows a planned run's bound and the runs left", async () => {
    vi.stubGlobal("fetch", routeFetch({ admitted: true, items: Array.from({ length: 6 }, (_, i) => ({ ref: `panel:${i}`, label: "", boundUsd: 0.728 })), boundUsd: 4.368, allowanceUsd: 5, remainingItems: 9, remainingBoundUsd: 6.552, runsNeeded: 3, refusal: null }));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    const plan = await screen.findByTestId("comparison-plan");
    expect(plan.textContent).toMatch(/takes 6 items, bounded at \$4\.37 of the \$5\.00 allowance/);
    expect(plan.textContent).toMatch(/9 more .* need 2 further runs/);
    expect(posts.at(-1)!.body).toEqual({ kind: "prepare", weekRemainingUsd: 25 });
  });

  it("shows a refusal with its figure", async () => {
    vi.stubGlobal("fetch", routeFetch({ admitted: false, items: [], boundUsd: 0, allowanceUsd: 5, remainingItems: 1, remainingBoundUsd: 0.7, runsNeeded: 1, refusal: "this run is bounded at $0.7280 … above the $0.50 left this week" }));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    fireEvent.change(await screen.findByTestId("comparison-week-remaining"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByTestId("comparison-plan-prepare"));
    expect((await screen.findByTestId("comparison-plan-refusal")).textContent).toMatch(/above the \$0\.50 left this week/);
  });
});
