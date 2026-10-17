import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUploadModeration } from "../hooks/useUploadModeration";

// jsdom cannot decode images, so the canvas re-encode is stubbed: a PNG or WebP
// comes back as a JPEG blob, which is what the real helper produces.
const preProcessImageFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/image-upload", () => ({ preProcessImageFile }));

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

  // #702: upload-meme accepts JPEG only, so a PNG or WebP the picker offers must
  // reach the server as a JPEG, never as its original type.
  for (const type of ["image/png", "image/webp"]) {
    it(`converts ${type} to JPEG before uploading (#702)`, async () => {
      const jpeg = new Blob([new Uint8Array(512)], { type: "image/jpeg" });
      preProcessImageFile.mockResolvedValueOnce({ blob: jpeg, width: 800, height: 600 });
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ objectPath: "/objects/uploads/p.jpg", width: 800, height: 600, isLowRes: true, fileSizeBytes: 512 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const { result } = renderHook(() => useUploadModeration());

      await act(async () => {
        await result.current.upload(new File([new Uint8Array(1024)], "p.img", { type }));
      });

      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
      expect(new Uint8Array(init.body as ArrayBuffer).byteLength).toBe(512);
    });
  }

  it("sends a JPEG unchanged, without re-encoding it", async () => {
    preProcessImageFile.mockClear();
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      await result.current.upload(validFile(2048));
    });

    expect(preProcessImageFile).not.toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
    expect(new Uint8Array(init.body as ArrayBuffer).byteLength).toBe(2048);
  });

  it("maps a failed conversion to invalid-format without hitting the network", async () => {
    preProcessImageFile.mockRejectedValueOnce(new Error("Failed to load image"));
    const fetchSpy = vi.spyOn(global, "fetch");
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      await result.current.upload(new File([new Uint8Array(10)], "bad.png", { type: "image/png" }));
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("invalid-format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // #714 round 1 (4304456527): the thumbnail must show what is stored, so a
  // converted PNG's preview comes from the JPEG that was sent, not the original.
  it("builds the preview from the converted JPEG for a PNG, and from the file itself for a JPEG", async () => {
    const jpeg = new Blob([new Uint8Array(256)], { type: "image/jpeg" });
    preProcessImageFile.mockResolvedValueOnce({ blob: jpeg, width: 10, height: 10 });
    const ok = () =>
      new Response(
        JSON.stringify({ objectPath: "/objects/uploads/x.jpg", width: 10, height: 10, isLowRes: true, fileSizeBytes: 256 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    vi.spyOn(global, "fetch").mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    const { result } = renderHook(() => useUploadModeration());

    const png = new File([new Uint8Array(1024)], "p.png", { type: "image/png" });
    await act(async () => {
      await result.current.upload(png);
    });
    expect(URL.createObjectURL).toHaveBeenLastCalledWith(jpeg);

    const original = validFile(512);
    await act(async () => {
      await result.current.upload(original);
    });
    expect(URL.createObjectURL).toHaveBeenLastCalledWith(original);
  });

  // #714 round 1 (4304456538): the converter can hand back a JPEG still over
  // the limit; that must be refused locally, never uploaded to meet a 413.
  it("refuses a converted file still over 15 MB without hitting the network", async () => {
    const tooBig = new Blob([new Uint8Array(15 * 1024 * 1024 + 1)], { type: "image/jpeg" });
    preProcessImageFile.mockResolvedValueOnce({ blob: tooBig, width: 6000, height: 6000 });
    const fetchSpy = vi.spyOn(global, "fetch");
    const { result } = renderHook(() => useUploadModeration());

    await act(async () => {
      await result.current.upload(new File([new Uint8Array(2048)], "big.webp", { type: "image/webp" }));
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("too-large");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
