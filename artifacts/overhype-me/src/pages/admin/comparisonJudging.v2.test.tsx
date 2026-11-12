/**
 * ComparisonJudging on a second-edition set (plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* C): the frozen fact
 * and gag are shown and the prompt is not; each picture is scored on the
 * panel's categories only; saving needs every score and a pick; a broken mark
 * and the pick are sent by token; a saved judgement loads back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ComparisonJudging from "./comparisonJudging";

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const img = (token: string) => ({ token, src: `/api/admin/comparison/panels/1/images/${token}` });

let judgement: unknown = null;
let posts: unknown[] = [];

function blindSet() {
  return {
    set: { id: 9, label: "Tuning", round: 1, judgingEdition: 2 },
    progress: { panels: 1, judgeable: 1, judged: judgement ? 1 : 0 },
    panels: [{
      panelId: 1, position: 1, factId: 11, factText: "Alex lifts a mountain", scenarioKey: "i2i_male_default",
      scenarioLabel: "Male subject (image-to-image)", lookStyleId: "none", imageMode: "i2i", faceMarkable: true,
      styleMarkable: false, gag: "Alex holds a mountain overhead like a barbell", categories: ["visualQuality", "gagFidelity", "realism", "likeness"],
      reference: { src: "https://fal.test/ref.jpg", identityType: "male" }, prompt: null, judgeable: true, skipped: false, skipReason: null,
      waiting: null, imagesReady: 2, imagesExpected: 2, imagesMissing: 0, images: [img(A), img(B)], pick: null, judgement,
    }],
  };
}

function routeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { scores: Array<Record<string, unknown> & { token: string }>; bestToken: string; brokenTokens: string[] };
      posts.push(body);
      judgement = {
        scores: Object.fromEntries(body.scores.map(({ token, ...s }) => [token, s])),
        bestToken: body.bestToken, brokenTokens: body.brokenTokens, judgedAt: new Date().toISOString(),
      };
      return { ok: true, json: async () => ({ judgement: body }) } as unknown as Response;
    }
    if (url.endsWith("/comparison/sets/9/judging")) return { ok: true, json: async () => blindSet() } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
}

beforeEach(() => { judgement = null; posts = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const CATS = ["visualQuality", "gagFidelity", "realism", "likeness"];

describe("ComparisonJudging, second edition", () => {
  it("shows the frozen fact and gag and no prompt, asks only the panel's categories, and saves every score with the pick and broken marks", async () => {
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "9" }} />);
    await screen.findByTestId("judging-images");
    expect(screen.getByTestId("judging-fact").textContent).toMatch(/Alex lifts a mountain/);
    expect(screen.getByTestId("judging-gag").textContent).toMatch(/holds a mountain overhead like a barbell/);
    expect(screen.queryByTestId("judging-prompt")).toBeNull();
    expect(screen.getByTestId("judging-categories").textContent).toMatch(/Likeness/);
    expect(screen.queryByTestId("judging-styleInterpretation-A-3")).toBeNull(); // not a styled panel
    expect(screen.queryByTestId("judging-face-A")).toBeNull(); // the broken flag replaces the face mark

    const save = () => screen.getByTestId("judging-save") as HTMLButtonElement;
    for (const k of CATS) fireEvent.click(screen.getByTestId(`judging-${k}-A-4`));
    for (const k of CATS.slice(0, 3)) fireEvent.click(screen.getByTestId(`judging-${k}-B-2`));
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId("judging-unscored").textContent).toMatch(/1 score still to give; pick the one you would send/);
    fireEvent.click(screen.getByTestId("judging-likeness-B-1"));
    expect(save().disabled).toBe(true); // still no pick
    fireEvent.click(screen.getByTestId("judging-best-A"));
    fireEvent.click(screen.getByTestId("judging-broken-B"));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      scores: [
        { token: A, visualQuality: 4, gagFidelity: 4, realism: 4, likeness: 4 },
        { token: B, visualQuality: 2, gagFidelity: 2, realism: 2, likeness: 1 },
      ],
      bestToken: A,
      brokenTokens: [B],
    });
  });

  it("loads a saved judgement, and saving is offered only after a change", async () => {
    judgement = {
      scores: { [A]: { visualQuality: 3, gagFidelity: 3, realism: 3, likeness: 3 }, [B]: { visualQuality: 5, gagFidelity: 5, realism: 5, likeness: 5 } },
      bestToken: B, brokenTokens: [], judgedAt: "2026-11-12T00:00:00Z",
    };
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "9" }} />);
    await screen.findByTestId("judging-images");
    expect((screen.getByTestId("judging-best-B") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("judging-realism-B-5").getAttribute("aria-pressed")).toBe("true");
    const save = () => screen.getByTestId("judging-save") as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByTestId("judging-broken-A"));
    expect(save().disabled).toBe(false);
  });
});
