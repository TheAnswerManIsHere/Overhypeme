// #875 R6: the builder's photo picker pages through every upload, not only the
// server's first page (Library already did).
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMyImages } from "./useMyImages";

const row = (n: number) => ({
  objectPath: `/objects/uploads/p${n}.jpg`, width: 1, height: 1, isLowRes: false, fileSizeBytes: 1,
  createdAt: "2026-11-23T00:00:00Z", transform: null, sourceObjectPath: null, factId: null,
  transformParamsHash: null, isProfile: n === 1,
});

afterEach(() => vi.unstubAllGlobals());

describe("useMyImages", () => {
  it("loads the next page on loadMore and stops when there is no cursor", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const second = url.includes("cursor=");
      return new Response(JSON.stringify({
        uploads: second ? [row(3)] : [row(1), row(2)],
        uploadCount: 3, maxUploads: 100, displayLimit: 2,
        nextCursor: second ? null : "c1",
      }), { status: 200 });
    }));
    const { result } = renderHook(() => useMyImages({ enabled: true }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.hasMore).toBe(false);
    expect(urls[1]).toBe("/api/users/me/uploads?transform=raw&cursor=c1");
  });

  it("a page that answers after the list was reset is dropped, so the fresh list still pages to the end (Codex 4662294957)", async () => {
    let releaseOld: (r: Response) => void = () => {};
    let cursorCalls = 0;
    const page = (uploads: unknown[], nextCursor: string | null) =>
      new Response(JSON.stringify({ uploads, uploadCount: 4, maxUploads: 100, displayLimit: 2, nextCursor }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (!url.includes("cursor=")) return Promise.resolve(page([row(1), row(2)], "c1"));
      cursorCalls += 1;
      // The first "load more" is held until after the reset; the second answers at once.
      if (cursorCalls === 1) return new Promise<Response>((r) => { releaseOld = r; });
      return Promise.resolve(page([row(3), row(4)], null));
    }));
    const { result, rerender } = renderHook((p: { enabled: boolean }) => useMyImages(p), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => result.current.loadMore());

    // The member leaves My photos and comes back before that page answers.
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    await act(async () => { releaseOld(page([row(9)], null)); await Promise.resolve(); });
    expect(result.current.rows.map((r) => r.objectPath)).toEqual(["/objects/uploads/p1.jpg", "/objects/uploads/p2.jpg"]);
    expect(result.current.hasMore, "the stale last page did not end the fresh list").toBe(true);
    expect(result.current.loadingMore).toBe(false);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toHaveLength(4));
    expect(result.current.hasMore).toBe(false);
  });
});
