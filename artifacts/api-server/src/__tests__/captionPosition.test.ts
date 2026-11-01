/**
 * The builder's caption-position slider (#707). The builder sends each
 * caption half's position as `topY` / `bottomY`, a percentage of the image
 * height at which the half's vertical midpoint sits (LivePreview's
 * `drawBlock`). The save path must carry those through to the rendered meme;
 * before this, the validator stripped them and the renderer placed the halves
 * at fixed top and bottom bands, so the slider moved only the preview.
 *
 * @purpose Proves the meme-save validator keeps topY/bottomY in 0–100 and refuses values outside it, that the caption placement puts a block's midpoint at the given percentage (clamped onto the canvas) and is unchanged when no position is given, and that a rendered meme draws its top caption where topY says rather than at the top band.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";

import { SaveMemeBody } from "../lib/validators/memeBuilder.js";
import { blockStartY, generateMemeBuffer } from "../lib/memeGenerator.js";

const BASE = { factId: 1, imageSource: { type: "identity" as const } };

describe("caption position: the save validator", () => {
  it("keeps topY and bottomY", () => {
    const parsed = SaveMemeBody.safeParse({ ...BASE, textOptions: { topText: "A", bottomText: "B", topY: 50, bottomY: 70 } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.textOptions?.topY, 50);
    assert.equal(parsed.data?.textOptions?.bottomY, 70);
  });

  it("refuses a position outside 0–100", () => {
    assert.equal(SaveMemeBody.safeParse({ ...BASE, textOptions: { topY: 120 } }).success, false);
    assert.equal(SaveMemeBody.safeParse({ ...BASE, textOptions: { bottomY: -5 } }).success, false);
  });
});

describe("caption position: blockStartY", () => {
  const geo = { totalH: 100, fontSize: 40, logicalH: 1000, padding: 40 };

  it("with no position, places exactly as before", () => {
    assert.equal(blockStartY({ ...geo, position: "top" }), 40 + 40);
    assert.equal(blockStartY({ ...geo, position: "bottom" }), 1000 - 40 - 100 + 40);
    assert.equal(blockStartY({ ...geo, position: "middle" }), (1000 - 100) / 2 + 40);
  });

  it("puts the block's midpoint at the given percentage", () => {
    // Block top = startY - fontSize; midpoint = top + totalH / 2.
    const startY = blockStartY({ ...geo, position: "top", yPct: 30 });
    assert.equal(startY - geo.fontSize + geo.totalH / 2, 300);
    assert.equal(blockStartY({ ...geo, position: "top", yPct: 50 }), blockStartY({ ...geo, position: "middle" }));
  });

  it("keeps the block on the canvas at the extremes", () => {
    const atTop = blockStartY({ ...geo, position: "top", yPct: 0 });
    assert.equal(atTop - geo.fontSize, 0);
    const atBottom = blockStartY({ ...geo, position: "bottom", yPct: 100 });
    assert.equal(atBottom - geo.fontSize + geo.totalH, 1000);
  });
});

/** A plain black photo, so the white caption is the only bright ink in the middle columns. */
function blackJpeg(w: number, h: number): Buffer {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer("image/jpeg", 0.95);
}

/** Mean row (as a fraction of height) of near-white pixels in the middle 40% of columns. */
async function captionRowFraction(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const x0 = Math.floor(info.width * 0.3);
  const x1 = Math.floor(info.width * 0.7);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i]! > 200 && data[i + 1]! > 200 && data[i + 2]! > 200) {
        sum += y;
        n++;
      }
    }
  }
  assert.ok(n > 0, "the caption drew some white ink");
  return sum / n / info.height;
}

describe("caption position: the rendered meme", () => {
  it("draws the top caption at topY, not at the top band", async () => {
    const photo = { type: "image" as const, imageData: blackJpeg(1200, 1200) };
    const opts = { topText: "WORDS", bottomText: "", textEffect: "none" as const };

    const atBand = await captionRowFraction(await generateMemeBuffer(photo, "WORDS", opts, "square"));
    const atMiddle = await captionRowFraction(await generateMemeBuffer(photo, "WORDS", { ...opts, topY: 50 }, "square"));

    assert.ok(atBand < 0.2, `without topY the caption sits in the top band (got ${atBand.toFixed(3)})`);
    assert.ok(Math.abs(atMiddle - 0.5) < 0.05, `with topY 50 the caption is centred (got ${atMiddle.toFixed(3)})`);
  });
});
