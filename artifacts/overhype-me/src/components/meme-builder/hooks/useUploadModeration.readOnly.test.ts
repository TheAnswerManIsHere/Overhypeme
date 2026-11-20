/**
 * #1109 D8: a photo upload refused because the site is read-only says so,
 * instead of "Something went wrong. Check your connection and try again."
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUploadModeration } from "./useUploadModeration";
import { UPLOAD_ERROR_COPY } from "../copy";
import { READ_ONLY_REFUSED_FULL } from "@/lib/readOnlyNotice";

afterEach(() => vi.unstubAllGlobals());

const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], "me.jpg", { type: "image/jpeg" });

describe("a refused meme-builder upload", () => {
  it("is 'paused' for a read-only refusal, with the maintenance message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "READ_ONLY_MODE", error: "paused" }), { status: 503 })));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const { result } = renderHook(() => useUploadModeration());
    await act(async () => { await result.current.upload(jpeg()); });
    expect(result.current.error).toBe("paused");
    expect(UPLOAD_ERROR_COPY.paused).toBe(READ_ONLY_REFUSED_FULL);
  });

  it("is still 'network' for any other server failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const { result } = renderHook(() => useUploadModeration());
    await act(async () => { await result.current.upload(jpeg()); });
    expect(result.current.error).toBe("network");
  });
});
