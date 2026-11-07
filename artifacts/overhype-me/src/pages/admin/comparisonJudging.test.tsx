/**
 * ComparisonJudging — /admin/eval/judge/:setId, the blind page of the launch
 * Phase 8 comparison. AdminLayout is stubbed. Opens on the first panel still to
 * judge, letters the images with nothing naming an engine, picks and marks
 * faces by token, refuses a panel that is not ready, and moves on after saving.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ComparisonJudging, { REFRESH_MS } from "./comparisonJudging";

const img = (panelId: number, token: string) => ({ token, src: `/api/admin/comparison/panels/${panelId}/images/${token}` });
const panel = (over: Record<string, unknown>): Record<string, unknown> => ({
  factId: 11, factText: "Alex lifts a mountain", lookStyleId: "none", imagesReady: 2, imagesExpected: 2, judgeable: true, pick: null, ...over,
});

function blindSet(picks: Record<number, unknown> = {}) {
  return {
    set: { id: 7, label: "Round 1", round: 1 },
    progress: { panels: 3, judgeable: 2, judged: Object.keys(picks).length },
    panels: [
      panel({ panelId: 1, position: 1, scenarioKey: "generic_t2i", scenarioLabel: "Generic (text-to-image)", imageMode: "t2i", faceMarkable: false, images: [img(1, "aaaaaaaaaaaaaaaa"), img(1, "bbbbbbbbbbbbbbbb")], pick: picks[1] ?? null }),
      panel({ panelId: 2, position: 2, scenarioKey: "i2i_male_default", scenarioLabel: "Male subject (image-to-image)", imageMode: "i2i", faceMarkable: true, images: [img(2, "cccccccccccccccc"), img(2, "dddddddddddddddd")], pick: picks[2] ?? null }),
      panel({ panelId: 3, position: 3, scenarioKey: "i2i_female_default", scenarioLabel: "Female subject (image-to-image)", imageMode: "i2i", faceMarkable: true, judgeable: false, imagesReady: 1, images: [] }),
    ],
  };
}

let posts: Array<{ url: string; body: unknown }> = [];
let picks: Record<number, unknown> = {};

function routeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { pickedToken: string; faceMismatchTokens: string[] };
      posts.push({ url, body });
      const panelId = Number(url.match(/panels\/(\d+)\/pick/)![1]);
      picks[panelId] = { ...body, judgedAt: new Date().toISOString() };
      return { ok: true, json: async () => ({ pick: body }) } as unknown as Response;
    }
    if (url.endsWith("/comparison/sets/7/judging")) return { ok: true, json: async () => blindSet(picks) } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
}

beforeEach(() => { posts = []; picks = {}; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ComparisonJudging", () => {
  it("shows a panel's images lettered, naming no engine, and saves the pick by token", async () => {
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "7" }} />);
    const images = await screen.findByTestId("judging-images");
    expect(screen.getByTestId("judging-progress").textContent).toMatch(/0 of 3 judged · 2 ready to judge/);
    expect(screen.getByTestId("judging-fact").textContent).toMatch(/Alex lifts a mountain/);
    expect(images.querySelectorAll("img")).toHaveLength(2);
    expect(images.textContent).toMatch(/^A.*B/);
    expect(screen.queryByTestId("judging-face-A")).toBeNull(); // text-to-image: no face to mark
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("judging-pick-B"));
    fireEvent.click(screen.getByTestId("judging-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/admin/comparison/panels/1/pick", body: { pickedToken: "bbbbbbbbbbbbbbbb", faceMismatchTokens: [] } });
    // Saving moves to the next panel still to judge.
    await waitFor(() => expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 2 of 3/));
  });

  it("marks faces on a panel with a person's photo", async () => {
    picks = { 1: { pickedToken: "aaaaaaaaaaaaaaaa", faceMismatchTokens: [], judgedAt: "2026-11-07T00:00:00Z" } };
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "7" }} />);
    await waitFor(() => expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 2 of 3/));
    fireEvent.click(screen.getByTestId("judging-pick-A"));
    fireEvent.click(screen.getByTestId("judging-face-B"));
    fireEvent.click(screen.getByTestId("judging-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ pickedToken: "cccccccccccccccc", faceMismatchTokens: ["dddddddddddddddd"] });
  });

  it("shows how many images are in for a panel that is not ready, and no images", async () => {
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "7" }} />);
    await screen.findByTestId("judging-images");
    fireEvent.click(screen.getByTestId("judging-prev")); // wraps to panel 3
    expect((await screen.findByTestId("judging-not-ready")).textContent).toMatch(/1 of 2 images are ready/);
    expect(screen.queryByTestId("judging-images")).toBeNull();
    expect(screen.queryByTestId("judging-save")).toBeNull();
  });

  it("re-opens a judged panel with its saved pick, and saves only a change", async () => {
    picks = { 1: { pickedToken: "bbbbbbbbbbbbbbbb", faceMismatchTokens: [], judgedAt: "2026-11-07T00:00:00Z" }, 2: { pickedToken: "cccccccccccccccc", faceMismatchTokens: [], judgedAt: "2026-11-07T00:00:00Z" } };
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "7" }} />);
    await screen.findByTestId("judging-images");
    expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 1 of 3.*judged/);
    expect(screen.getByTestId("judging-pick-B").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("judging-pick-A"));
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("refreshes while images render, keeping the panel and an unsaved pick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let ready = false;
      vi.stubGlobal("fetch", vi.fn(async () => {
        const body = blindSet();
        body.panels[1] = { ...body.panels[1]!, judgeable: ready, imagesReady: ready ? 2 : 1, images: ready ? body.panels[1]!.images : [] };
        return { ok: true, json: async () => body } as unknown as Response;
      }));
      render(<ComparisonJudging params={{ setId: "7" }} />);
      await screen.findByTestId("judging-images");
      fireEvent.click(screen.getByTestId("judging-pick-B")); // unsaved
      ready = true;
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
      await waitFor(() => expect(screen.getByTestId("judging-progress").textContent).toMatch(/2 ready to judge/));
      expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 1 of 3/);
      expect(screen.getByTestId("judging-pick-B").getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(screen.getByTestId("judging-next"));
      expect(screen.getByTestId("judging-images").querySelectorAll("img")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists a skipped panel with its reason, and counts it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = blindSet();
      body.panels[2] = { ...body.panels[2]!, skipped: true, skipReason: "the fact's enrichment does not validate" };
      return { ok: true, json: async () => ({ ...body, progress: { ...body.progress, skipped: 1 } }) } as unknown as Response;
    }));
    render(<ComparisonJudging params={{ setId: "7" }} />);
    await screen.findByTestId("judging-images");
    expect(screen.getByTestId("judging-progress").textContent).toMatch(/1 skipped, never judged/);
    fireEvent.click(screen.getByTestId("judging-prev"));
    expect((await screen.findByTestId("judging-skipped")).textContent).toMatch(/enrichment does not validate/);
    expect(screen.queryByTestId("judging-save")).toBeNull();
  });

  it("says a lost panel can never be judged, and stops refreshing for it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = vi.fn(async () => {
        const body = blindSet();
        body.panels[2] = { ...body.panels[2]!, waiting: "lost", imagesReady: 1 };
        return { ok: true, json: async () => ({ ...body, progress: { ...body.progress, lost: 1 } }) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<ComparisonJudging params={{ setId: "7" }} />);
      await screen.findByTestId("judging-images");
      expect(screen.getByTestId("judging-progress").textContent).toMatch(/1 lost an image for good/);
      fireEvent.click(screen.getByTestId("judging-prev"));
      expect((await screen.findByTestId("judging-lost")).textContent).toMatch(/can never be judged/);
      expect(screen.queryByTestId("judging-not-ready")).toBeNull();
      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("points a panel whose image failed, with a re-run left, to the comparison screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = blindSet();
      body.panels[2] = { ...body.panels[2]!, waiting: "needs_action" };
      return { ok: true, json: async () => body } as unknown as Response;
    }));
    render(<ComparisonJudging params={{ setId: "7" }} />);
    await screen.findByTestId("judging-images");
    fireEvent.click(screen.getByTestId("judging-prev"));
    expect((await screen.findByTestId("judging-needs-action")).textContent).toMatch(/re-run it or prepare the panel again on the comparison screen/);
  });
});
