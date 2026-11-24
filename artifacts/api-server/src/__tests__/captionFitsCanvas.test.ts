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
 * @purpose Proves every line of a drawn caption lies inside the picture, for every aspect ratio, caption position, caption length and font size the builder can produce, on the shared drawing and on the server's rendered file.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import {
  MEME_CANVAS_DIMS,
  CAPTION_BASELINE_EM,
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
