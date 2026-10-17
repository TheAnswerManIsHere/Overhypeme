/**
 * @purpose Real-browser check of the meme upload's PNG/WebP-to-JPEG re-encode (#702, #714): loads the app's own lib/image-upload.ts from the dev server and runs preProcessImageFile on images the browser itself draws, because jsdom cannot decode or encode images.
 * @subsystem studio
 */
import { expect, test, type Page } from "@playwright/test";

interface Converted {
  type: string;
  size: number;
  /** The first two bytes, as hex: a JPEG starts ffd8. */
  magic: string;
  /** RGBA of a pixel that was fully transparent in the source. */
  transparentPixel: [number, number, number, number];
  /** RGBA of a pixel that was solid red in the source. */
  opaquePixel: [number, number, number, number];
}

/**
 * Draws a 64×64 image whose left half is solid red and right half fully
 * transparent, encodes it as `sourceType` in the browser, converts it with the
 * app's own helper, and reads back the result.
 */
async function convertInBrowser(page: Page, sourceType: "image/png" | "image/webp"): Promise<Converted> {
  return page.evaluate(async (type) => {
    const mod = (await import(/* @vite-ignore */ "/src/lib/image-upload.ts")) as {
      preProcessImageFile: (file: File) => Promise<{ blob: Blob }>;
    };

    const src = document.createElement("canvas");
    src.width = 64;
    src.height = 64;
    const sctx = src.getContext("2d")!;
    sctx.clearRect(0, 0, 64, 64);
    sctx.fillStyle = "rgb(255,0,0)";
    sctx.fillRect(0, 0, 32, 64);
    const sourceBlob = await new Promise<Blob>((resolve) => src.toBlob((b) => resolve(b!), type, 1));
    const file = new File([sourceBlob], "source", { type });

    const { blob } = await mod.preProcessImageFile(file);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const bitmap = await createImageBitmap(blob);
    const out = document.createElement("canvas");
    out.width = bitmap.width;
    out.height = bitmap.height;
    const octx = out.getContext("2d")!;
    octx.drawImage(bitmap, 0, 0);
    const px = (x: number, y: number) => Array.from(octx.getImageData(x, y, 1, 1).data) as [number, number, number, number];

    return {
      type: blob.type,
      size: blob.size,
      magic: Array.from(bytes.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join(""),
      transparentPixel: px(48, 32),
      opaquePixel: px(16, 32),
    };
  }, sourceType);
}

test.describe("Meme upload re-encode in a real browser (#702)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  for (const sourceType of ["image/png", "image/webp"] as const) {
    test(`a ${sourceType} becomes a JPEG under the 15 MB limit`, async ({ page }) => {
      const result = await convertInBrowser(page, sourceType);
      expect(result.type).toBe("image/jpeg");
      expect(result.magic).toBe("ffd8");
      expect(result.size).toBeGreaterThan(0);
      expect(result.size).toBeLessThanOrEqual(15 * 1024 * 1024);
    });
  }

  test("a transparent region becomes black and an opaque region keeps its colour", async ({ page }) => {
    const result = await convertInBrowser(page, "image/png");
    const [r, g, b, a] = result.transparentPixel;
    expect(a).toBe(255);
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(16);
    const [or, og, ob] = result.opaquePixel;
    expect(or).toBeGreaterThanOrEqual(230);
    expect(Math.max(og, ob)).toBeLessThanOrEqual(30);
  });
});
