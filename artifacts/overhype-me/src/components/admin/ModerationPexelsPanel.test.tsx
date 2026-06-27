import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { ModerationPexelsPanel } from "./ModerationPexelsPanel";

function stubFetch(bodies: unknown[]) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const OK_WITH_IMAGES = {
  pexelsStatus: "ok",
  factType: "action",
  keywords: { male: "man lifting", female: "woman lifting", neutral: "person lifting" },
  images: {
    male: [{ id: 1, url: "https://x/1.jpg", photographer: "Ada" }],
    female: [],
    neutral: [{ id: 3, url: "https://x/3.jpg" }, { id: 4, url: "https://x/4.jpg" }],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ModerationPexelsPanel", () => {
  it("renders counts, the active gender grid, and Pexels attribution when ok", async () => {
    stubFetch([OK_WITH_IMAGES]);
    render(<ModerationPexelsPanel reviewId={42} />);
    await waitFor(() => expect(screen.getByTestId("pexels-counts").textContent).toContain("3 total"));
    // Neutral is the default active gender → its 2 thumbnails render.
    expect(screen.getByTestId("pexels-grid-neutral").querySelectorAll("img").length).toBe(2);
    expect(screen.getByText(/Photos provided by Pexels/)).toBeTruthy();
  });

  it("shows an explicit empty state for ok with zero images", async () => {
    stubFetch([{ pexelsStatus: "ok", factType: "abstract", keywords: null, images: { male: [], female: [], neutral: [] } }]);
    render(<ModerationPexelsPanel reviewId={1} />);
    await waitFor(() => expect(screen.getByTestId("pexels-empty")).toBeTruthy());
  });

  it("shows a non-blocking failure note when seeding failed", async () => {
    stubFetch([{ pexelsStatus: "failed", factType: null, keywords: null, images: { male: [], female: [], neutral: [] } }]);
    render(<ModerationPexelsPanel reviewId={2} />);
    await waitFor(() => expect(screen.getByTestId("pexels-failed")).toBeTruthy());
  });

  it("polls while pending and fills in once seeding completes", async () => {
    vi.useFakeTimers();
    const pending = { pexelsStatus: "pending", factType: null, keywords: null, images: { male: [], female: [], neutral: [] } };
    const fetchMock = stubFetch([pending, OK_WITH_IMAGES]);
    render(<ModerationPexelsPanel reviewId={7} />);
    // Initial load resolves to pending.
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("pexels-pending")).toBeTruthy();
    // Advance one poll tick → second fetch returns ok.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByTestId("pexels-counts").textContent).toContain("3 total");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
