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
  panels: { total: 33, judged: 31, judgeable: 31, skipped: 2 },
  wins: {
    overall: { "flux-3": 20, "gpt-image-2-5": 13 },
    byMode: { t2i: { "flux-3": 9, "gpt-image-2-5": 6 }, i2i: { "flux-3": 9, "gpt-image-2-5": 9 } },
    byStyle: { none: { "flux-3": 8 }, anime: { "gpt-image-2-5": 4 } },
    byScenario: { generic_t2i: { "flux-3": 9 } },
  },
  leaders: { t2i: { families: ["flux-3"], wins: 9, judged: 15 }, i2i: { families: ["flux-3", "gpt-image-2-5"], wins: 9, judged: 18 } },
  faceMismatches: { "gpt-image-2-5": 3 },
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
    expect(leaders.textContent).toMatch(/Text-to-image.*flux-3 — 9 of 15 panels/);
    expect(leaders.textContent).toMatch(/Reference edit.*flux-3 = gpt-image-2-5 — 9 of 18 panels \(tied\)/);
    expect(screen.getByTestId("results-summary").textContent).toMatch(/31 of 33 panels judged.*2 panels were skipped at preparation and will never be judged/);
    expect(screen.getByTestId("results-by-style").textContent).toMatch(/anime/);
    expect(screen.getByTestId("results-faces").textContent).toMatch(/of 12 judged.*gpt-image-2-5 3/);
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
