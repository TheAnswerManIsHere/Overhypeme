import { describe, it, expect, vi, afterEach } from "vitest";
import { cropToSquareJpeg } from "./image-upload";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

interface MockCanvasState {
  width: number;
  height: number;
}

/**
 * Builds a minimal canvas/context mock and installs it via
 * document.createElement. Returns the shared state object so tests can
 * assert on width/height after the call.
 */
function installCanvasMock(): {
  state: MockCanvasState;
  drawImage: ReturnType<typeof vi.fn>;
} {
  const state: MockCanvasState = { width: 0, height: 0 };
  const drawImage = vi.fn();
  const ctx = { drawImage };

  const canvas = {
    get width() {
      return state.width;
    },
    set width(v: number) {
      state.width = v;
    },
    get height() {
      return state.height;
    },
    set height(v: number) {
      state.height = v;
    },
    getContext: vi.fn().mockReturnValue(ctx),
    toBlob: vi.fn((cb: BlobCallback) => {
      cb(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
    }),
  };

  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "canvas") return canvas as unknown as HTMLCanvasElement;
    // Fall through to real implementation for other tags
    return document.createElement.call(document, tag);
  });

  return { state, drawImage };
}

/**
 * Stubs FileReader so readAsDataURL resolves instantly with a dummy data URL,
 * and stubs globalThis.Image so src assignment resolves instantly with the
 * given natural dimensions.
 */
function installImageMocks(naturalWidth: number, naturalHeight: number): void {
  class MockFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    readAsDataURL(_file: File) {
      this.result = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      queueMicrotask(() => this.onload?.());
    }
  }

  class MockImage {
    naturalWidth = naturalWidth;
    naturalHeight = naturalHeight;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_url: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  vi.stubGlobal("FileReader", MockFileReader);
  vi.stubGlobal("Image", MockImage);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cropToSquareJpeg()", () => {
  it("returns a File with image/jpeg type and .jpg extension", async () => {
    installCanvasMock();
    installImageMocks(400, 300);

    const input = new File(["data"], "portrait.png", { type: "image/png" });
    const result = await cropToSquareJpeg(input);

    expect(result).toBeInstanceOf(File);
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("portrait.jpg");
  });

  it("produces a square canvas (width === height)", async () => {
    const { state } = installCanvasMock();
    installImageMocks(600, 400);

    const input = new File(["data"], "landscape.jpg", { type: "image/jpeg" });
    await cropToSquareJpeg(input);

    expect(state.width).toBe(state.height);
  });

  it("uses the shorter edge as the square side for a landscape image", async () => {
    const { state } = installCanvasMock();
    installImageMocks(800, 600);

    await cropToSquareJpeg(new File(["data"], "wide.jpg", { type: "image/jpeg" }));

    // side = min(800, 600) = 600; capped at maxSize=1024 → 600
    expect(state.width).toBe(600);
    expect(state.height).toBe(600);
  });

  it("uses the shorter edge as the square side for a portrait image", async () => {
    const { state } = installCanvasMock();
    installImageMocks(400, 900);

    await cropToSquareJpeg(new File(["data"], "tall.jpg", { type: "image/jpeg" }));

    expect(state.width).toBe(400);
    expect(state.height).toBe(400);
  });

  it("crops from the centre of a landscape image", async () => {
    const { drawImage } = installCanvasMock();
    installImageMocks(400, 200);

    await cropToSquareJpeg(new File(["data"], "w.jpg", { type: "image/jpeg" }));

    // side=200; sx=(400-200)/2=100; sy=0; out=min(200,1024)=200
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      100, 0,       // sx, sy
      200, 200,     // sWidth, sHeight (the source square)
      0, 0,         // dx, dy
      200, 200,     // dWidth, dHeight (the output square)
    );
  });

  it("crops from the centre of a portrait image", async () => {
    const { drawImage } = installCanvasMock();
    installImageMocks(200, 400);

    await cropToSquareJpeg(new File(["data"], "t.jpg", { type: "image/jpeg" }));

    // side=200; sx=0; sy=(400-200)/2=100
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0, 100,
      200, 200,
      0, 0,
      200, 200,
    );
  });

  it("scales down to maxSize when the square side exceeds it", async () => {
    const { state } = installCanvasMock();
    installImageMocks(2048, 2048);

    await cropToSquareJpeg(new File(["data"], "big.jpg", { type: "image/jpeg" }), 512);

    expect(state.width).toBe(512);
    expect(state.height).toBe(512);
  });

  it("does not upscale when the image is smaller than maxSize", async () => {
    const { state } = installCanvasMock();
    installImageMocks(100, 100);

    await cropToSquareJpeg(new File(["data"], "tiny.jpg", { type: "image/jpeg" }));

    // out = Math.min(100, 1024) = 100
    expect(state.width).toBe(100);
    expect(state.height).toBe(100);
  });

  it("preserves the base filename and appends .jpg", async () => {
    installCanvasMock();
    installImageMocks(300, 300);

    const result = await cropToSquareJpeg(
      new File(["data"], "my-selfie.webp", { type: "image/webp" }),
    );

    expect(result.name).toBe("my-selfie.jpg");
  });
});
