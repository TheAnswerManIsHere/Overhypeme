/**
 * #870: the builder's preview is drawn by the same routine as the saved file
 * (`drawMeme`, `@workspace/api-zod`). The server side of that is held
 * pixel-for-pixel in the api-server's `memePreviewParity.test.ts`, given the
 * inputs this component passes; this test pins those inputs.
 *
 * @purpose Proves LivePreview draws through the shared drawMeme with the recipe's caption runs, aspect ratio, pan, style and catalogue font strings, and draws the caption once its face has loaded and the watermark once its own has, independently.
 * @subsystem meme-studio
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { memeCaption } from "@workspace/api-zod";
import { resetCaptionFontsForTest } from "@/lib/captionFontLoader";

const drawMeme = vi.fn();
vi.mock("@workspace/api-zod", async (orig) => ({ ...(await orig<typeof import("@workspace/api-zod")>()), drawMeme: (...a: unknown[]) => drawMeme(...a) }));

const { LivePreview } = await import("../parts/LivePreview");

let faces: { family: string; resolve: () => void }[] = [];
beforeEach(() => {
  drawMeme.mockReset();
  resetCaptionFontsForTest();
  faces = [];
  class FakeFontFace {
    constructor(public family: string) {}
    load() {
      return new Promise<FakeFontFace>((resolve) => faces.push({ family: this.family, resolve: () => resolve(this) }));
    }
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: vi.fn() } });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
});
afterEach(() => vi.unstubAllGlobals());

const textOptions = { topText: "{NAME} doesn't wear a watch.", bottomText: "{Subj} decides.", topY: 20, fontFamily: "block" };

describe("#870: LivePreview draws through the shared drawing", () => {
  it("passes the recipe, and draws the caption once its face loads and the watermark once its own does", async () => {
    render(
      <LivePreview factText="{NAME} doesn't wear a watch. {Subj} decides." name="David Franklin" pronouns="he/him"
        backgroundUrl={null} textOptions={textOptions} aspectRatio="portrait" framingOffset={{ x: 12, y: -30 }} />,
    );
    const before = drawMeme.mock.calls.at(-1)![1];
    expect(before.watermark).toBe(false);
    expect(before.caption).toEqual({ mode: "single", text: [] });

    // The caption face alone: the caption draws, the watermark waits (#872).
    await act(async () => faces.find((f) => f.family === "OH Block")!.resolve());
    const captionOnly = drawMeme.mock.calls.at(-1)![1];
    expect(captionOnly.watermark).toBe(false);
    expect(captionOnly.caption.mode).toBe("split");

    await act(async () => faces.find((f) => f.family === "OH Sans")!.resolve());
    expect(faces.map((f) => f.family).sort()).toEqual(["OH Block", "OH Sans"]);

    const input = drawMeme.mock.calls.at(-1)![1];
    expect(input.aspectRatio).toBe("portrait");
    expect(input.framingOffset).toEqual({ x: 12, y: -30 });
    expect(input.style).toBe(textOptions);
    expect(input.watermark).toBe(true);
    expect(input.caption).toEqual(memeCaption("{NAME} doesn't wear a watch. {Subj} decides.", textOptions, "David Franklin", "he/him"));
    expect(input.caption.top[0]).toEqual({ text: "David Franklin", isName: true });
    expect(input.captionFont(50)).toBe('normal 400 50px "OH Block", sans-serif');
    expect(input.watermarkFont(21)).toBe('800 21px "OH Sans", sans-serif');
  });
});
