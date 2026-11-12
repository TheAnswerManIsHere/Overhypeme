/**
 * ComparisonResults on a second-edition set (plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* C): each engine's pick
 * share is the headline, beside its average on each category asked, its
 * broken and lost counts, cost and time; a category never asked is not a
 * column; the server's refusal to mix editions is explained.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ComparisonResults from "./comparisonResults";

const cats = (vq: number, gf: number, re: number, li: number | null) => ({
  visualQuality: { mean: vq, count: 4 }, gagFidelity: { mean: gf, count: 4 }, realism: { mean: re, count: 4 },
  styleInterpretation: { mean: null, count: 0 }, likeness: li == null ? { mean: null, count: 0 } : { mean: li, count: 4 },
});
const row = (engineId: string, picked: number, panels: number, c: ReturnType<typeof cats>, extra: Record<string, unknown> = {}) => ({
  family: engineId.replace(/-edit$/, ""), engineId, panels, picked, pickShare: panels ? Math.round((picked / panels) * 100) / 100 : null,
  categories: c, scored: panels, lost: 0, broken: 0, billedUsdPerImage: 0.04, billedMinUsd: 0.04, billedMaxUsd: 0.04, billed: panels,
  medianSeconds: 20, slowestSeconds: 30, timed: panels, ...extra,
});

const JUDGED = {
  edition: 2,
  sets: [{ id: 9, label: "Tuning", round: 1, imageSize: "comparison" }],
  panels: { total: 8, judged: 8, judgeable: 8, skipped: 0, lost: 0 },
  rows: {
    i2i: [
      row("nano-banana-2-1-edit", 3, 4, cats(4.25, 4, 3.75, 4.5)),
      row("gpt-image-2-6-edit", 1, 4, cats(3.5, 3, 3, 2.75), { broken: 1, lost: 1 }),
    ],
  },
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("ComparisonResults, second edition", () => {
  it("leads with the pick share and shows only the categories asked", async () => {
    window.history.replaceState(null, "", "/admin/eval/results?sets=9");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => JUDGED }) as unknown as Response));
    render(<ComparisonResults />);
    const table = await screen.findByTestId("results-judged-Reference edit");
    expect(table.textContent).toMatch(/Picked to send/);
    expect(table.textContent).toMatch(/Likeness/);
    expect(table.textContent).not.toMatch(/Style interpretation/); // never asked on these panels
    const nb = within(screen.getByTestId("results-row-nano-banana-2-1-edit"));
    expect(nb.getByText("75% (3 of 4)")).toBeTruthy();
    expect(nb.getByText("4.50")).toBeTruthy();
    const gpt = screen.getByTestId("results-row-gpt-image-2-6-edit").textContent!;
    expect(gpt).toMatch(/25% \(1 of 4\)/);
    expect(screen.queryByTestId("results-leaders")).toBeNull(); // the first edition's views are not shown
  });

  it("on a prompt comparison, lists each wording and promotes one from its results", async () => {
    window.history.replaceState(null, "", "/admin/eval/results?sets=12");
    const tuned = { ...row("gpt-image-2-6-edit", 3, 4, cats(4, 4, 4, 4.5)), recipeVersionId: 5, recipeLabel: "Version 2", recipeNote: "tighter likeness" };
    const base = { ...row("gpt-image-2-6-edit", 1, 4, cats(3, 3, 3, 3)), recipeVersionId: null, recipeLabel: "Baseline", recipeNote: null };
    const body = { ...JUDGED, kind: "prompt", family: "gpt-image-2-6", rows: { i2i: [tuned, base] }, byLook: {}, pictures: [] };
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return { ok: true, status: 200, json: async () => ({}), clone() { return this; } } as unknown as Response; }
      return { ok: true, json: async () => body } as unknown as Response;
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ComparisonResults />);
    expect((await screen.findByTestId("results-row-gpt-image-2-6-edit-5")).textContent).toMatch(/Version 2.*tighter likeness/);
    fireEvent.click(screen.getByTestId("results-promote-5"));
    await waitFor(() => expect(posts).toEqual([{ versionId: 5 }]));
    expect((await screen.findByTestId("results-notice")).textContent).toMatch(/Version 2 is now live for gpt-image-2-6/);
  });

  it("names every row by its wording in the by-look tables, where Promote is not offered", async () => {
    window.history.replaceState(null, "", "/admin/eval/results?sets=12,13");
    const v = (picked: number) => ({ ...row("gpt-image-2-6-edit", picked, 4, cats(4, 4, 4, 4)), recipeVersionId: 5, recipeLabel: "Version 2", recipeNote: "tighter likeness" });
    const b = (picked: number) => ({ ...row("gpt-image-2-6-edit", picked, 4, cats(3, 3, 3, 3)), recipeVersionId: null, recipeLabel: "Baseline", recipeNote: null });
    const body = { ...JUDGED, kind: "prompt", family: "gpt-image-2-6", rows: { i2i: [v(4), b(4)] }, byLook: { none: { i2i: [v(3), b(1)] }, anime: { i2i: [b(3), v(1)] } }, pictures: [] };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response));
    render(<ComparisonResults />);
    const anime = await screen.findByTestId("results-judged-anime · Reference edit");
    const firstRow = anime.querySelectorAll("tbody tr")[0]!.textContent!;
    expect(firstRow).toMatch(/Baseline/);
    expect(firstRow).toMatch(/75% \(3 of 4\)/);
    expect(anime.querySelectorAll("tbody tr")[1]!.textContent).toMatch(/Version 2.*tighter likeness/);
    expect(within(anime).queryByText("Promote")).toBeNull();
  });

  it("tells two wordings of one engine apart on engine results", async () => {
    window.history.replaceState(null, "", "/admin/eval/results?sets=20,21");
    const older = { ...row("nano-banana-2-1-edit", 1, 4, cats(3, 3, 3, 3)), recipeVersionId: null, recipeLabel: "Baseline", recipeNote: null };
    const newer = { ...row("nano-banana-2-1-edit", 3, 4, cats(4, 4, 4, 4)), recipeVersionId: 7, recipeLabel: "Version 1", recipeNote: "brighter" };
    const body = { ...JUDGED, kind: "engine", rows: { i2i: [newer, older] }, byLook: {}, pictures: [] };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response));
    render(<ComparisonResults />);
    expect((await screen.findByTestId("results-row-nano-banana-2-1-edit-v7")).textContent).toMatch(/nano-banana-2-1.*Version 1 wording/);
    expect(screen.getByTestId("results-row-nano-banana-2-1-edit").textContent).toMatch(/Baseline wording/);
    expect(screen.queryByText("Promote")).toBeNull();
  });

  it("explains a refusal to read the two editions together", async () => {
    window.history.replaceState(null, "", "/admin/eval/results?sets=4,9");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }) as unknown as Response));
    render(<ComparisonResults />);
    expect((await screen.findByTestId("results-error")).textContent).toMatch(/judged in different ways/);
  });
});
