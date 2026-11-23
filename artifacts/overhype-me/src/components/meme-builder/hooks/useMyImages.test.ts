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
});
