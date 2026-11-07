/**
 * EngineComparison — the launch Phase 8 comparison section on /admin/eval.
 * Creating a set from a round preset, the per-cell grid and aggregate, the
 * bounded estimate, a planned run's worst case, and the links to judging.
 * Pricing does not gate a run (David, 2026-11-07): no week figure is asked.
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

  it("shows a planned run's worst case, and asks for no week figure", async () => {
    vi.stubGlobal("fetch", routeFetch({ admitted: true, items: Array.from({ length: 6 }, (_, i) => ({ ref: `panel:${i}`, label: "", boundUsd: 0.728 })), boundUsd: 4.368, refusal: null }));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    const plan = await screen.findByTestId("comparison-plan");
    expect(plan.textContent).toMatch(/takes all 6 items still to do, at most \$4\.37/);
    expect(posts.at(-1)!.body).toEqual({ kind: "prepare" });
    expect(screen.queryByTestId("comparison-week-remaining")).toBeNull();
    expect(screen.queryByTestId("comparison-settle-bills")).toBeNull();
  });

  it("shows a refusal", async () => {
    vi.stubGlobal("fetch", routeFetch({ admitted: false, items: [], boundUsd: 0, refusal: "nothing left to do" }));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    expect((await screen.findByTestId("comparison-plan-refusal")).textContent).toMatch(/nothing left to do/);
  });

  it("links the selected set to its blind judging page and its results", async () => {
    vi.stubGlobal("fetch", routeFetch(null));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    expect((await screen.findByTestId("comparison-judge-link")).getAttribute("href")).toBe("/admin/eval/judge/7");
    expect(screen.getByTestId("comparison-results-link").getAttribute("href")).toBe("/admin/eval/results?sets=7");
  });
});

describe("EngineComparison — responses for an earlier selection", () => {
  const detailFor = (id: number) => ({ ...DETAIL, set: { ...DETAIL.set, id, label: `Set ${id}` } });
  const SETS = [7, 8].map((id) => ({ id, label: `Set ${id}`, round: 1, createdAt: new Date().toISOString(), panels: 1, cells: 2 }));
  const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

  /** Every request for `deferred` URLs waits until its release is called. */
  function controlledFetch(deferred: Record<string, { status?: number; body: unknown }>) {
    const release: Record<string, () => void> = {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/comparison/sets")) return ok({ sets: SETS });
      const match = Object.keys(deferred).find((k) => url.endsWith(k));
      if (match) {
        await new Promise<void>((resolve) => { release[match] = resolve; });
        const d = deferred[match]!;
        return { ok: (d.status ?? 200) < 400, status: d.status ?? 200, json: async () => d.body } as unknown as Response;
      }
      if (url.endsWith("/comparison/sets/8")) return ok(detailFor(8));
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    return { fetchMock, release };
  }

  it("a late detail for the previous set never replaces the selected set's", async () => {
    const { fetchMock, release } = controlledFetch({ "/comparison/sets/7": { body: detailFor(7) } });
    vi.stubGlobal("fetch", fetchMock);
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Set 7/));
    fireEvent.click(screen.getByText(/#8 Set 8/));
    await waitFor(() => expect(screen.getByTestId("comparison-detail").textContent).toMatch(/Set #8/));
    release["/comparison/sets/7"]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("comparison-detail").textContent).toMatch(/Set #8/);
  });

  it("a late failure for the previous set shows no error", async () => {
    const { fetchMock, release } = controlledFetch({ "/comparison/sets/7": { status: 500, body: { error: "boom" } } });
    vi.stubGlobal("fetch", fetchMock);
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Set 7/));
    fireEvent.click(screen.getByText(/#8 Set 8/));
    await screen.findByTestId("comparison-detail");
    release["/comparison/sets/7"]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("comparison-error")).toBeNull();
  });

  it("a plan requested for the previous set never appears under the selected one", async () => {
    const plan = { admitted: true, items: [{ ref: "panel:1", label: "", boundUsd: 0.768 }], boundUsd: 0.768, refusal: null };
    const { fetchMock, release } = controlledFetch({ "/comparison/sets/7": { body: detailFor(7) }, "/comparison/sets/7/plan": { body: plan } });
    vi.stubGlobal("fetch", fetchMock);
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Set 7/));
    await new Promise((r) => setTimeout(r, 0));
    release["/comparison/sets/7"]!();
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    fireEvent.click(screen.getByText(/#8 Set 8/));
    await waitFor(() => expect(screen.getByTestId("comparison-detail").textContent).toMatch(/Set #8/));
    release["/comparison/sets/7/plan"]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("comparison-plan")).toBeNull();
  });
});

describe("EngineComparison — starting a run", () => {
  const PLAN = { admitted: true, items: [{ ref: "panel:1", label: "", boundUsd: 0.768 }], boundUsd: 0.768, refusal: null };
  const FAILED = {
    ...DETAIL,
    panels: [{ ...DETAIL.panels[0]!, state: "prepared", cells: [
      { id: 1, engineId: "flux-3", state: "failed", skipReason: null, error: "storage failed", vendorResultUrl: "https://v/1.png", rerunCount: 0 },
      { id: 2, engineId: "muse-image", state: "failed", skipReason: null, error: "render failed", vendorResultUrl: null, rerunCount: 0 },
    ] }],
  };
  function startFetch(runResponse: { status: number; body: unknown }, detail: unknown = DETAIL) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/comparison/sets")) return { ok: true, json: async () => ({ sets: [{ id: 7, label: "Round 1", round: 1, createdAt: new Date().toISOString(), panels: 1, cells: 2 }] }) } as unknown as Response;
      if (url.endsWith("/comparison/sets/7")) return { ok: true, json: async () => detail } as unknown as Response;
      if (url.endsWith("/plan")) return { ok: true, json: async () => PLAN } as unknown as Response;
      if (url.endsWith("/runs")) return { ok: runResponse.status < 400, status: runResponse.status, json: async () => runResponse.body } as unknown as Response;
      if (url.includes("/cells/")) return { ok: true, json: async () => ({ cell: {} }) } as unknown as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
  }

  it("starts the planned run and reports it", async () => {
    vi.stubGlobal("fetch", startFetch({ status: 202, body: { run: { id: 3, kind: "prepare", state: "running", boundUsd: "0.7680", refusal: null, createdAt: "" }, plan: PLAN } }));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    fireEvent.click(await screen.findByTestId("comparison-start-run"));
    expect((await screen.findByTestId("comparison-notice")).textContent).toMatch(/Run #3 started: 1 item, at most \$0\.77/);
    expect(posts.at(-1)).toEqual({ url: "/api/admin/comparison/sets/7/runs", body: { kind: "prepare" } });
  });

  it("shows a refused start", async () => {
    vi.stubGlobal("fetch", startFetch({ status: 409, body: { error: "run_refused", refusal: "paid comparison runs never run in CI" } }));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    fireEvent.click(await screen.findByTestId("comparison-start-run"));
    expect((await screen.findByTestId("comparison-error")).textContent).toMatch(/Run refused: paid comparison runs never run in CI/);
  });

  it("offers storage-only retry for a stored-at-vendor failure and a re-run otherwise", async () => {
    vi.stubGlobal("fetch", startFetch({ status: 202, body: {} }, FAILED));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Round 1/));
    fireEvent.click(await screen.findByTestId("comparison-retry-storage-1"));
    await waitFor(() => expect(posts.at(-1)?.url).toBe("/api/admin/comparison/cells/1/retry-storage"));
    expect(screen.queryByTestId("comparison-rerun-1")).toBeNull();
    fireEvent.click(screen.getByTestId("comparison-rerun-2"));
    await waitFor(() => expect(posts.at(-1)?.url).toBe("/api/admin/comparison/cells/2/rerun"));
  });
});

describe("EngineComparison — a start that finishes after the selection changed", () => {
  it("leaves the start button usable on the set now selected", async () => {
    const PLAN = { admitted: true, items: [{ ref: "panel:1", label: "", boundUsd: 0.768 }], boundUsd: 0.768, refusal: null };
    let releaseStart: () => void = () => {};
    const detailFor = (id: number) => ({ ...DETAIL, set: { ...DETAIL.set, id, label: `Set ${id}` } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/comparison/sets")) return { ok: true, json: async () => ({ sets: [7, 8].map((id) => ({ id, label: `Set ${id}`, round: 1, createdAt: "", panels: 1, cells: 2 })) }) } as unknown as Response;
      if (url.endsWith("/comparison/sets/7") || url.endsWith("/comparison/sets/8")) return { ok: true, json: async () => detailFor(Number(url.slice(-1))) } as unknown as Response;
      if (url.endsWith("/plan")) return { ok: true, json: async () => PLAN } as unknown as Response;
      if (url.endsWith("/runs")) {
        await new Promise<void>((r) => { releaseStart = r; });
        return { ok: true, status: 202, json: async () => ({ run: { id: 1, kind: "prepare", state: "running", boundUsd: "0.7680", refusal: null, createdAt: "" }, plan: PLAN }) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }));
    render(<EngineComparison />);
    fireEvent.click(await screen.findByText(/#7 Set 7/));
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    fireEvent.click(await screen.findByTestId("comparison-start-run"));
    fireEvent.click(screen.getByText(/#8 Set 8/));
    await waitFor(() => expect(screen.getByTestId("comparison-detail").textContent).toMatch(/Set #8/));
    releaseStart();
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(await screen.findByTestId("comparison-plan-prepare"));
    const button = await screen.findByTestId("comparison-start-run");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
