/**
 * #1254: in the portrait ratio a long top caption ran off the top of the meme
 * — "When David Franklin does pushups, he doesn't push himself up –" wrapped to
 * five lines, and its first line was cut by the top edge. A caption block is
 * centred on its position (`topY` / `bottomY`, a percentage of the height), and
 * nothing kept a tall block inside the picture, so a block taller than twice
 * the distance to the nearer edge always crossed it. The intended behaviour
 * (David, 2026-11-24): the whole caption fits inside the picture, with no line
 * cut by an edge.
 *
 * #1260: the top and bottom blocks could also be drawn over each other, and the
 * builder's position sliders took their limits from a guess (a line count of
 * split/8, a 64 px font, a 720 px canvas) instead of from the drawing. One
 * layout (`captionLayout`) now decides all of it.
 *
 * @purpose Proves every line of a drawn caption lies inside the picture and the top and bottom blocks never overlap, for every aspect ratio, caption position, caption length and font size the builder can produce, on the shared drawing and on the server's rendered file, and that the position ranges the layout reports are exactly the positions it draws unchanged.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import {
  MEME_CANVAS_DIMS,
  CAPTION_BASELINE_EM,
  captionLayout,
  drawMeme,
  memeCaption,
  type MemeCanvasAspectRatio,
  type MemeCanvasContext,
} from "@workspace/api-zod";

import { generateMemeBuffer } from "../lib/memeGenerator.js";

/** How far ink reaches above and below the alphabetic baseline, in ems (the drawing's own figures). */
const ASCENT_EM = 0.85;
const DESCENT_EM = 0.25;

/** A canvas that records each caption run's baseline and font size; widths are half an em per character. */
function recordingContext() {
  const placed: { text: string; y: number; size: number }[] = [];
  const sizeOf = (font: string) => Number(/^cap:(\d+(?:\.\d+)?)$/.exec(font)?.[1] ?? NaN);
  const ctx = {
    fillStyle: "" as unknown, strokeStyle: "" as unknown, lineWidth: 0, lineJoin: "", font: "", textAlign: "", textBaseline: "",
    shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    fillRect() {}, strokeText() {}, save() {}, restore() {},
    fillText(text: string, _x: number, y: number) {
      if (ctx.font.startsWith("cap:")) placed.push({ text, y, size: sizeOf(ctx.font) });
    },
    measureText(text: string) {
      const size = ctx.font.startsWith("cap:") ? sizeOf(ctx.font) : 20;
      return { width: text.length * size * 0.5 };
    },
  };
  return { ctx: ctx as unknown as MemeCanvasContext, placed };
}

/** The recording canvas's widths, for `captionLayout` called directly: half an em per character. */
const measure = (text: string, size: number) => text.length * size * 0.5;

const RATIOS: MemeCanvasAspectRatio[] = ["portrait", "square", "landscape"];
const POSITIONS = [0, 5, 17, 50, 88, 95, 100];
const LENGTHS = [1, 4, 12, 30, 80, 200]; // words
const FONT_SIZES: (number | undefined)[] = [undefined, 32, 64, 120]; // the recipe default, and the builder slider's range

describe("caption fits the canvas: the shared drawing", () => {
  it("keeps every line's ink inside the picture, whatever the ratio, position, length and font size", () => {
    let checked = 0;
    for (const aspectRatio of RATIOS) {
      const { h } = MEME_CANVAS_DIMS[aspectRatio];
      for (const fontSize of FONT_SIZES) {
        for (const words of LENGTHS) {
          const text = "word ".repeat(words).trim();
          for (const y of POSITIONS) {
            for (const mode of ["top", "bottom", "single"] as const) {
              const { ctx, placed } = recordingContext();
              const caption = mode === "single"
                ? memeCaption(text, null, "David", "he/him")
                : memeCaption(text, mode === "top" ? { topText: text, bottomText: "" } : { topText: "", bottomText: text }, "David", "he/him");
              drawMeme(ctx, {
                image: null, drawImage: () => {}, aspectRatio, caption,
                style: { fontSize, topY: y, bottomY: y, textEffect: "none" },
                captionFont: (s) => `cap:${s}`, watermarkFont: () => "wm", watermark: false,
              });
              assert.ok(placed.length > 0, "the caption drew");
              for (const p of placed) {
                const top = p.y - p.size * ASCENT_EM;
                const bottom = p.y + p.size * DESCENT_EM;
                const where = `${aspectRatio}, ${mode} at ${y}%, ${words} words, font ${fontSize ?? "default"}`;
                assert.ok(top >= 0, `${where}: a line's ink starts ${top.toFixed(1)} px above the top edge`);
                assert.ok(bottom <= h, `${where}: a line's ink ends ${(bottom - h).toFixed(1)} px below the bottom edge`);
              }
              checked++;
            }
          }
        }
      }
    }
    assert.equal(checked, RATIOS.length * FONT_SIZES.length * LENGTHS.length * POSITIONS.length * 3);
  });

  it("never overlaps the top and bottom blocks, and keeps both inside the picture, whatever the positions, lengths and font size (#1260)", () => {
    let checked = 0;
    for (const aspectRatio of RATIOS) {
      const { h } = MEME_CANVAS_DIMS[aspectRatio];
      for (const fontSize of FONT_SIZES) {
        for (const topWords of [1, 10, 30, 90]) {
          for (const bottomWords of [1, 5, 30, 90]) {
            for (const topY of POSITIONS) {
              for (const bottomY of POSITIONS) {
                const topText = "word ".repeat(topWords).trim();
                const bottomText = "word ".repeat(bottomWords).trim();
                const layout = captionLayout(measure, {
                  aspectRatio,
                  caption: memeCaption(`${topText} ${bottomText}`, { topText, bottomText }, "David", "he/him"),
                  style: { fontSize, topY, bottomY },
                });
                const where = `${aspectRatio}, top ${topWords} words at ${topY}%, bottom ${bottomWords} words at ${bottomY}%, font ${fontSize ?? "default"}`;
                const [top, bottom] = layout.blocks;
                assert.equal(layout.blocks.length, 2, where);
                assert.ok(top!.inkTop >= 0, `${where}: the top block starts ${top!.inkTop.toFixed(1)} px above the top edge`);
                assert.ok(bottom!.inkBottom <= h, `${where}: the bottom block ends ${(bottom!.inkBottom - h).toFixed(1)} px below the bottom edge`);
                assert.ok(top!.inkBottom < bottom!.inkTop, `${where}: the blocks overlap by ${(top!.inkBottom - bottom!.inkTop).toFixed(1)} px`);
                checked++;
              }
            }
          }
        }
      }
    }
    assert.equal(checked, RATIOS.length * FONT_SIZES.length * 16 * POSITIONS.length * POSITIONS.length);
  });

  it("fits the two longest halves the save validator accepts, in every ratio", () => {
    const half = "wwww ".repeat(100).trim(); // 499 characters
    for (const aspectRatio of RATIOS) {
      const { h } = MEME_CANVAS_DIMS[aspectRatio];
      const layout = captionLayout(measure, {
        aspectRatio, caption: memeCaption(half, { topText: half, bottomText: half }, "David", "he/him"), style: { fontSize: 100 },
      });
      const [top, bottom] = layout.blocks;
      assert.ok(top!.inkTop >= 0 && bottom!.inkBottom <= h && top!.inkBottom < bottom!.inkTop, `${aspectRatio}: drawn at ${layout.fontSize} px`);
    }
  });

  it("draws David's screenshot case apart: portrait pushups, top at 51%, bottom at 72%", () => {
    const topText = "When David Franklin does pushups, he doesn't push himself up –";
    const bottomText = "He pushes the Earth down.";
    const layout = captionLayout(measure, {
      aspectRatio: "portrait", caption: memeCaption("", { topText, bottomText }, "David", "he/him"), style: { topY: 51, bottomY: 72 },
    });
    const [top, bottom] = layout.blocks;
    assert.ok(top!.inkBottom < bottom!.inkTop, `the blocks overlap by ${(top!.inkBottom - bottom!.inkTop).toFixed(1)} px`);
  });

  it("gives each slider a range in which every position is drawn exactly where it says, and the two ranges meet without overlap", () => {
    for (const aspectRatio of RATIOS) {
      for (const fontSize of FONT_SIZES) {
        for (const [topWords, bottomWords] of [[10, 5], [3, 3], [30, 12]] as const) {
          const topText = "word ".repeat(topWords).trim();
          const bottomText = "word ".repeat(bottomWords).trim();
          const caption = memeCaption("", { topText, bottomText }, "David", "he/him");
          const at = (topY: number, bottomY: number) => captionLayout(measure, { aspectRatio, caption, style: { fontSize, topY, bottomY } });
          const start = at(17, 88);
          const [top, bottom] = start.blocks;
          const where = `${aspectRatio}, ${topWords}/${bottomWords} words, font ${fontSize ?? "default"}`;
          // The integer positions a slider offers.
          const topMin = Math.ceil(top!.minPct), topMax = Math.floor(top!.maxPct);
          const bottomMin = Math.ceil(bottom!.minPct), bottomMax = Math.floor(bottom!.maxPct);
          assert.ok(top!.minPct <= top!.yPct + 1e-9 && top!.yPct <= top!.maxPct + 1e-9, `${where}: the top block sits inside its own range`);
          assert.ok(bottom!.minPct <= bottom!.yPct + 1e-9 && bottom!.yPct <= bottom!.maxPct + 1e-9, `${where}: the bottom block sits inside its own range`);
          for (const v of [topMin, topMax]) {
            if (topMin > topMax) break;
            const moved = at(v, bottom!.yPct);
            assert.ok(Math.abs(moved.blocks[0]!.yPct - v) < 1e-9, `${where}: top slider at ${v}% is drawn at ${moved.blocks[0]!.yPct.toFixed(3)}%`);
            assert.ok(Math.abs(moved.blocks[1]!.yPct - bottom!.yPct) < 1e-9, `${where}: moving the top slider to ${v}% moved the bottom block`);
          }
          for (const v of [bottomMin, bottomMax]) {
            if (bottomMin > bottomMax) break;
            const moved = at(top!.yPct, v);
            assert.ok(Math.abs(moved.blocks[1]!.yPct - v) < 1e-9, `${where}: bottom slider at ${v}% is drawn at ${moved.blocks[1]!.yPct.toFixed(3)}%`);
            assert.ok(Math.abs(moved.blocks[0]!.yPct - top!.yPct) < 1e-9, `${where}: moving the bottom slider to ${v}% moved the top block`);
          }
        }
      }
    }
  });

  it("leaves a caption that already fits exactly where its position puts it", () => {
    // One line, the top default, the portrait ratio: centred at 17% of the height, as before #1254.
    const { ctx, placed } = recordingContext();
    drawMeme(ctx, {
      image: null, drawImage: () => {}, aspectRatio: "portrait",
      caption: memeCaption("Short", { topText: "Short", bottomText: "" }, "David", "he/him"),
      style: { textEffect: "none" }, captionFont: (s) => `cap:${s}`, watermarkFont: () => "wm", watermark: false,
    });
    const size = Math.floor(1280 * 0.07);
    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.size, size);
    // The block's midpoint is at 17%; a one-line block's line sits half a line height above it, plus half the font size.
    assert.equal(placed[0]!.y, 0.17 * 1280 - (size * 1.1) / 2 + size / 2 + size * CAPTION_BASELINE_EM);
  });
});

/** A plain black photo, so the white caption is the only bright ink. */
function blackJpeg(w: number, h: number): Buffer {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer("image/jpeg", 0.95);
}

/** The first and last rows that hold near-white ink. */
async function inkRows(buf: Buffer): Promise<{ first: number; last: number; height: number }> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let first = -1;
  let last = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i]! > 200 && data[i + 1]! > 200 && data[i + 2]! > 200) {
        if (first < 0) first = y;
        last = y;
        break;
      }
    }
  }
  return { first, last, height: info.height };
}

describe("caption fits the canvas: the saved meme", () => {
  it("draws David's five-line pushups top caption in portrait with its first line inside the picture", async () => {
    const photo = { type: "image" as const, imageData: blackJpeg(900, 1600) };
    const top = "When David Franklin does pushups, he doesn't push himself up –";
    const buf = await generateMemeBuffer(
      photo, `${top} He pushes the Earth down.`,
      { topText: top, bottomText: "", textEffect: "none" }, "portrait",
    );
    const rows = await inkRows(buf);
    assert.ok(rows.first > 0, `the caption's ink touches the top edge (first ink row ${rows.first})`);
    assert.ok(rows.last < rows.height - 1, `the caption's ink touches the bottom edge (last ink row ${rows.last})`);
  });
});
