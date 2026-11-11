/**
 * ComparisonResults — /admin/eval/results?sets=…, where the comparison's
 * engines are revealed. AdminLayout is stubbed. Reads the set ids from the
 * URL, shows the leader per mode, the wins tables, the face marks and costs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ComparisonResults from "./comparisonResults";

const RESULTS = {
  sets: [{ id: 4, label: "Round 1", round: 1 }, { id: 5, label: "Round 2", round: 2 }],
  families: ["flux-3", "gpt-image-2-5"],
  panels: { total: 33, judged: 30, judgeable: 30, skipped: 2, lost: 1 },
  scores: {
    overall: { "flux-3": { mean: 3.9, count: 33 }, "gpt-image-2-5": { mean: 3.4, count: 31 } },
    byMode: { t2i: { "flux-3": { mean: 4.2, count: 15 }, "gpt-image-2-5": { mean: 3.1, count: 14 } }, i2i: { "flux-3": { mean: 3.75, count: 18 }, "gpt-image-2-5": { mean: 3.75, count: 17 } } },
    byStyle: { none: { "flux-3": { mean: 4, count: 15 } }, anime: { "gpt-image-2-5": { mean: 4.5, count: 6 } } },
    byScenario: { generic_t2i: { "flux-3": { mean: 4.2, count: 3 } } },
  },
  leaders: { t2i: { families: ["flux-3"], pictures: [15], mean: 4.2, judged: 15 }, i2i: { families: ["flux-3", "gpt-image-2-5"], pictures: [18, 17], mean: 3.75, judged: 18 } },
  faceMismatches: { "gpt-image-2-5": 3 },
  styleCaptured: { anime: { "flux-3": { captured: 4, pictures: 6 } } },
  ranking: {
    t2i: [
      { rank: 1, family: "flux-3", engineId: "flux-3", mean: 4.2, scored: 15, lost: 0, usdPerImage: 0.048, exact: true, billedUsdPerImage: 0.048, billedMinUsd: 0.048, billedMaxUsd: 0.048, billed: 15, medianSeconds: 9.4, slowestSeconds: 21.3, timed: 15 },
      { rank: 2, family: "gpt-image-2-5", engineId: "gpt-image-2-5", mean: 3.1, scored: 14, lost: 1, usdPerImage: 0.058, exact: false, billedUsdPerImage: 0.0339, billedMinUsd: 0.0336, billedMaxUsd: 0.0412, billed: 3, medianSeconds: 118, slowestSeconds: 240, timed: 14 },
    ],
    i2i: [
      { rank: 1, family: "flux-3", engineId: "flux-3-edit", mean: 3.75, scored: 18, lost: 0, usdPerImage: 0.048, exact: true },
      { rank: 1, family: "gpt-image-2-5", engineId: "gpt-image-2-5-edit", mean: 3.75, scored: 17, lost: 0, usdPerImage: 0.066, exact: false },
    ],
  },
  humanReferencePanelsJudged: 12,
  costs: { "flux-3": { family: "flux-3", calls: 15, boundUsd: 0.72 } },
  preparationBoundUsd: 2.5,
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("ComparisonResults", () => {
  it("loads the sets named in the URL and shows the leader per mode, ties included", async () => {
    window.history.replaceState(null, "", "/admin/eval/results?sets=4,5");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => RESULTS }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<ComparisonResults />);
    const leaders = await screen.findByTestId("results-leaders");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/comparison/results?setIds=4,5", expect.anything());
    expect(leaders.textContent).toMatch(/Text-to-image.*flux-3 \(15 pictures\) — average 4\.20 of 5, 15 panels judged/);
    expect(leaders.textContent).toMatch(/Reference edit.*flux-3 \(18 pictures\) = gpt-image-2-5 \(17 pictures\) — average 3\.75 of 5, 18 panels judged \(tied\)/);
    expect(screen.getByTestId("results-summary").textContent).toMatch(/30 of 33 panels judged.*1 panel lost every image for good.*2 panels were skipped at preparation and will never be judged/);
    const ranking = screen.getByTestId("results-ranking");
    const t2iRows = [...ranking.querySelectorAll("table")[0]!.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(t2iRows).toEqual([
      ["1", "flux-3", "4.20", "15", "0", "$0.048 (15 billed)", "$0.048", "9.4s (slowest 21s)"],
      ["2", "gpt-image-2-5", "3.10", "14", "1", "$0.034 ($0.034–$0.041, 3 billed)", "about $0.058", "118s (slowest 240s)"],
    ]);
    const i2iRanks = [...ranking.querySelectorAll("table")[1]!.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")!.textContent);
    expect(i2iRanks).toEqual(["1", "1"]); // an equal average shares a rank
    expect(ranking.textContent).toMatch(/Reference edit: quality, then price/);
    expect(ranking.textContent).toMatch(/at the comparison's size/);
    expect(screen.getByTestId("results-by-style").textContent).toMatch(/anime.*4\.50/);
    expect(screen.getByTestId("results-faces").textContent).toMatch(/of 12 judged.*gpt-image-2-5 3/);
    expect(screen.getByTestId("results-style-captured").textContent).toMatch(/anime.*4 of 6.*—/); // an engine with no styled pictures reads as a dash
    expect(screen.getByTestId("results-costs").textContent).toMatch(/flux-3 \(flux-3\) · 15 calls · \$0\.72.*total, at most · \$3\.22/);
  });

  it("refuses set ids that are not numbers without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ComparisonResults />);
    fireEvent.change(screen.getByTestId("results-set-ids"), { target: { value: "4, x" } });
    fireEvent.click(screen.getByTestId("results-load"));
    await waitFor(() => expect(screen.getByTestId("results-error").textContent).toMatch(/set ids/));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
