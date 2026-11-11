/**
 * ComparisonJudging — /admin/eval/judge/:setId, the blind page of the launch
 * Phase 8 comparison. AdminLayout is stubbed. Opens on the first panel still to
 * judge, letters the images with nothing naming an engine, scores every image
 * 1 to 5 and marks faces by token, saves only when every image is scored,
 * refuses a panel that is not ready, and moves on after saving.
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

/** When set, panel 1 is a styled panel, offering "captured the style". */
let styled = false;

function blindSet(picks: Record<number, unknown> = {}) {
  return {
    set: { id: 7, label: "Round 1", round: 1 },
    progress: { panels: 3, judgeable: 2, judged: Object.keys(picks).length },
    panels: [
      panel({ panelId: 1, position: 1, scenarioKey: "generic_t2i", scenarioLabel: "Generic (text-to-image)", imageMode: "t2i", faceMarkable: false, ...(styled ? { lookStyleId: "anime", styleMarkable: true } : {}), images: [img(1, "aaaaaaaaaaaaaaaa"), img(1, "bbbbbbbbbbbbbbbb")], pick: picks[1] ?? null }),
      panel({ panelId: 2, position: 2, scenarioKey: "i2i_male_default", scenarioLabel: "Male subject (image-to-image)", imageMode: "i2i", faceMarkable: true, reference: { src: "https://fal.test/ref-male.jpg", identityType: "male" }, prompt: "A man lifts a mountain at dawn, photographed from below.", images: [img(2, "cccccccccccccccc"), img(2, "dddddddddddddddd")], pick: picks[2] ?? null }),
      panel({ panelId: 3, position: 3, scenarioKey: "i2i_female_default", scenarioLabel: "Female subject (image-to-image)", imageMode: "i2i", faceMarkable: true, judgeable: false, imagesReady: 1, images: [] }),
    ],
  };
}

let posts: Array<{ url: string; body: unknown }> = [];
let picks: Record<number, unknown> = {};

function routeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { ratings: Array<{ token: string; score: number }>; faceMismatchTokens: string[]; styleCapturedTokens: string[] };
      posts.push({ url, body });
      const panelId = Number(url.match(/panels\/(\d+)\/pick/)![1]);
      picks[panelId] = { ratings: Object.fromEntries(body.ratings.map((r) => [r.token, r.score])), faceMismatchTokens: body.faceMismatchTokens, styleCapturedTokens: body.styleCapturedTokens, judgedAt: new Date().toISOString() };
      return { ok: true, json: async () => ({ pick: body }) } as unknown as Response;
    }
    if (url.endsWith("/comparison/sets/7/judging")) return { ok: true, json: async () => blindSet(picks) } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
}

beforeEach(() => { posts = []; picks = {}; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ComparisonJudging", () => {
  it("offers \"Captured the style\" on a styled panel only, loads saved marks and saves a change", async () => {
    styled = true;
    try {
      picks = { 1: { ratings: { aaaaaaaaaaaaaaaa: 2, bbbbbbbbbbbbbbbb: 4 }, faceMismatchTokens: [], styleCapturedTokens: ["aaaaaaaaaaaaaaaa"], judgedAt: "2026-11-07T00:00:00Z" } };
      vi.stubGlobal("fetch", routeFetch());
      render(<ComparisonJudging params={{ setId: "7" }} />);
      await screen.findByTestId("judging-images");
      fireEvent.click(screen.getByTestId("judging-prev")); // back to the judged styled panel
      await waitFor(() => expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 1 of 3/));
      expect((screen.getByTestId("judging-style-A") as HTMLInputElement).checked).toBe(true); // the saved mark is shown
      expect((screen.getByTestId("judging-style-B") as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(true); // nothing changed yet
      fireEvent.click(screen.getByTestId("judging-style-B"));
      expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(false); // a mark alone is a change
      fireEvent.click(screen.getByTestId("judging-save"));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.body).toMatchObject({ styleCapturedTokens: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"] });
    } finally {
      styled = false;
    }
  });

  it("shows a panel's images lettered, naming no engine, and saves a score for each by token", async () => {
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "7" }} />);
    const images = await screen.findByTestId("judging-images");
    expect(screen.getByTestId("judging-progress").textContent).toMatch(/0 of 3 judged · 2 ready to judge/);
    expect(screen.getByTestId("judging-fact").textContent).toMatch(/Alex lifts a mountain/);
    expect(images.querySelectorAll("img")).toHaveLength(2);
    expect(images.textContent).toMatch(/^A.*B/);
    expect(screen.queryByTestId("judging-face-A")).toBeNull(); // text-to-image: no face to mark
    expect(screen.queryByTestId("judging-style-A")).toBeNull(); // no look style: no style to mark
    expect(screen.queryByTestId("judging-reference")).toBeNull(); // and no source photo
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("judging-score-B-4"));
    expect(screen.getByTestId("judging-unscored").textContent).toMatch(/1 still to score/);
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(true); // A is unscored
    fireEvent.click(screen.getByTestId("judging-score-A-2"));
    fireEvent.click(screen.getByTestId("judging-score-B-5")); // a score can be changed before saving
    expect(screen.getByTestId("judging-score-B-5").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("judging-score-B-4").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("judging-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: "/api/admin/comparison/panels/1/pick",
      body: { ratings: [{ token: "aaaaaaaaaaaaaaaa", score: 2 }, { token: "bbbbbbbbbbbbbbbb", score: 5 }], faceMismatchTokens: [], styleCapturedTokens: [] },
    });
    // Saving moves to the next panel still to judge.
    await waitFor(() => expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 2 of 3/));
  });

  it("marks faces on a panel with a person's photo", async () => {
    picks = { 1: { ratings: { aaaaaaaaaaaaaaaa: 3, bbbbbbbbbbbbbbbb: 3 }, faceMismatchTokens: [], judgedAt: "2026-11-07T00:00:00Z" } };
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "7" }} />);
    await waitFor(() => expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 2 of 3/));
    // The source photo sits beside the pictures, apart from the scored ones.
    const ref = screen.getByTestId("judging-reference");
    expect(ref.querySelector("img")!.getAttribute("src")).toBe("https://fal.test/ref-male.jpg");
    expect(ref.textContent).toMatch(/Every engine was given this same photo/);
    expect(screen.getByTestId("judging-images").querySelectorAll("img")).toHaveLength(2);
    // The prompt every engine was sent, word for word.
    expect(screen.getByTestId("judging-prompt-text").textContent).toBe("A man lifts a mountain at dawn, photographed from below.");
    expect(screen.getByTestId("judging-prompt").textContent).toMatch(/Prompt every engine was sent \(56 characters\)/);
    fireEvent.click(screen.getByTestId("judging-score-A-5"));
    fireEvent.click(screen.getByTestId("judging-score-B-1"));
    fireEvent.click(screen.getByTestId("judging-face-B"));
    fireEvent.click(screen.getByTestId("judging-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ ratings: [{ token: "cccccccccccccccc", score: 5 }, { token: "dddddddddddddddd", score: 1 }], faceMismatchTokens: ["dddddddddddddddd"], styleCapturedTokens: [] });
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

  it("re-opens a judged panel with its saved scores, and saves only a change", async () => {
    picks = {
      1: { ratings: { aaaaaaaaaaaaaaaa: 2, bbbbbbbbbbbbbbbb: 4 }, faceMismatchTokens: [], judgedAt: "2026-11-07T00:00:00Z" },
      2: { ratings: { cccccccccccccccc: 3, dddddddddddddddd: 3 }, faceMismatchTokens: [], judgedAt: "2026-11-07T00:00:00Z" },
    };
    vi.stubGlobal("fetch", routeFetch());
    render(<ComparisonJudging params={{ setId: "7" }} />);
    await screen.findByTestId("judging-images");
    expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 1 of 3.*judged/);
    expect(screen.getByTestId("judging-score-B-4").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("judging-score-A-2").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("judging-score-A-3"));
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("judging-score-A-2")); // back to what was saved
    expect((screen.getByTestId("judging-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("refreshes while images render, keeping the panel and an unsaved score", async () => {
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
      fireEvent.click(screen.getByTestId("judging-score-B-3")); // unsaved
      ready = true;
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
      await waitFor(() => expect(screen.getByTestId("judging-progress").textContent).toMatch(/2 ready to judge/));
      expect(screen.getByTestId("judging-panel").textContent).toMatch(/Panel 1 of 3/);
      expect(screen.getByTestId("judging-score-B-3").getAttribute("aria-pressed")).toBe("true");
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

  it("says a panel with every image lost has nothing to score, and stops refreshing for it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = vi.fn(async () => {
        const body = blindSet();
        body.panels[2] = { ...body.panels[2]!, waiting: "lost", imagesReady: 0 };
        return { ok: true, json: async () => ({ ...body, progress: { ...body.progress, lost: 1 } }) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<ComparisonJudging params={{ setId: "7" }} />);
      await screen.findByTestId("judging-images");
      expect(screen.getByTestId("judging-progress").textContent).toMatch(/1 lost every image for good/);
      fireEvent.click(screen.getByTestId("judging-prev"));
      expect((await screen.findByTestId("judging-lost")).textContent).toMatch(/nothing to score/);
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

  it("shows a lost image as missing, naming no engine, and scores the rest", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      const body = blindSet();
      body.panels[0] = { ...body.panels[0]!, imagesReady: 1, imagesMissing: 1, images: [img(1, "aaaaaaaaaaaaaaaa")] };
      return { ok: true, json: async () => body } as unknown as Response;
    }));
    render(<ComparisonJudging params={{ setId: "7" }} />);
    const images = await screen.findByTestId("judging-images");
    expect(images.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByTestId("judging-missing").textContent).toMatch(/1 engine could not draw this panel.*counts as a 1\. Score the 1 that exist/);
    fireEvent.click(screen.getByTestId("judging-score-A-4"));
    fireEvent.click(screen.getByTestId("judging-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ ratings: [{ token: "aaaaaaaaaaaaaaaa", score: 4 }], faceMismatchTokens: [], styleCapturedTokens: [] });
  });
});
