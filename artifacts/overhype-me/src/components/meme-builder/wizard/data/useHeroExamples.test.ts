import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useHeroExamples } from "./useHeroExamples";
import type { HeroExamplesResponse } from "./heroExamplesClient";

function fakeFetcher(resp: HeroExamplesResponse) {
  return vi.fn().mockResolvedValue(resp);
}

const IMG = (suffix: string) => ({
  id: parseInt(suffix, 10) || 0,
  artifactType: "image" as const,
  assetUrl: `img-${suffix}`,
  posterUrl: null,
  captionLabel: "",
});
const VID = (suffix: string) => ({
  id: parseInt(suffix, 10) || 0,
  artifactType: "video" as const,
  assetUrl: `vid-${suffix}`,
  posterUrl: null,
  captionLabel: "",
});

describe("useHeroExamples", () => {
  it("returns null entries while loading", () => {
    const fetcher = fakeFetcher({ image: [], video: [] });
    const { result } = renderHook(() => useHeroExamples({ fetcher }));
    expect(result.current.loading).toBe(true);
    expect(result.current.image).toBeNull();
    expect(result.current.video).toBeNull();
  });

  it("returns null when the response is empty", async () => {
    const fetcher = fakeFetcher({ image: [], video: [] });
    const { result } = renderHook(() => useHeroExamples({ fetcher }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.image).toBeNull();
    expect(result.current.video).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("picks one row per artifact type using the supplied randomizer", async () => {
    const fetcher = fakeFetcher({
      image: [IMG("1"), IMG("2"), IMG("3")],
      video: [VID("10"), VID("20")],
    });
    const randomIndex = vi.fn((len: number) => (len === 3 ? 2 : 1));

    const { result } = renderHook(() =>
      useHeroExamples({ fetcher, randomIndex }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.image?.assetUrl).toBe("img-3");
    expect(result.current.video?.assetUrl).toBe("vid-20");
  });

  it("keeps the same pick across re-renders within one mount", async () => {
    const fetcher = fakeFetcher({
      image: [IMG("1"), IMG("2"), IMG("3"), IMG("4"), IMG("5")],
      video: [],
    });
    let callCount = 0;
    // Returns different indices on each call — would reshuffle if not stable.
    const randomIndex = vi.fn(() => callCount++);

    const { result, rerender } = renderHook(() =>
      useHeroExamples({ fetcher, randomIndex }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstPick = result.current.image?.assetUrl;

    rerender();
    rerender();
    rerender();

    expect(result.current.image?.assetUrl).toBe(firstPick);
  });

  it("surfaces fetch errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useHeroExamples({ fetcher }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("boom");
  });
});
