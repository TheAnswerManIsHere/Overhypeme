import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUploadModeration } from "../hooks/useUploadModeration";

const validFile = (size = 1024) => new File([new Uint8Array(size)], "p.jpg", { type: "image/jpeg" });

describe("useUploadModeration", () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it("rejects an invalid format without hitting the network", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      const file = new File([new Uint8Array(10)], "x.tiff", { type: "image/tiff" });
      await result.current.upload(file);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("invalid-format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized files without hitting the network", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      const huge = new File([new Uint8Array(16 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" });
      await result.current.upload(huge);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("too-large");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps HTTP 422 → moderation rejection (generic)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(null, { status: 422 }));
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      await result.current.upload(validFile());
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("rejected");
  });

  it("maps HTTP 503 → network error class", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      await result.current.upload(validFile());
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("network");
  });

  it("maps HTTP 200 → ready, exposes objectPath + dims", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          objectPath: "/objects/uploads/abc.jpg",
          width: 1280,
          height: 720,
          isLowRes: false,
          fileSizeBytes: 4321,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      await result.current.upload(validFile());
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.image?.objectPath).toBe("/objects/uploads/abc.jpg");
    expect(result.current.image?.width).toBe(1280);
  });
});
