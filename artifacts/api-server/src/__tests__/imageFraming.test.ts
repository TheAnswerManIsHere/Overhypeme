/**
 * Unit tests for the Stage-1 source-framing helper (imageFraming.ts).
 *
 * `computeCropRect` is pure geometry — exercised exhaustively here. The
 * `cropBufferToAspect` path is covered with a real sharp-generated buffer to
 * confirm the crop dimensions land at the requested aspect ratio.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import {
  computeCropRect,
  cropBufferToAspect,
  aspectRatioToPulidImageSize,
} from "../lib/imageFraming.js";

const CENTRE = { x: 0.5, y: 0.5 };

describe("aspectRatioToPulidImageSize", () => {
  it("maps each wizard aspect to a PuLID image_size", () => {
    assert.equal(aspectRatioToPulidImageSize("landscape"), "landscape_16_9");
    assert.equal(aspectRatioToPulidImageSize("square"), "square_hd");
    assert.equal(aspectRatioToPulidImageSize("portrait"), "portrait_16_9");
  });
});

describe("computeCropRect", () => {
  it("crops the sides of a landscape source down to a portrait window (centre)", () => {
    // 1600×900 source, want 9:16 → crop is tall+narrow, full height.
    const rect = computeCropRect(1600, 900, 9 / 16, CENTRE);
    assert.equal(rect.height, 900);
    assert.equal(rect.width, Math.round(900 * (9 / 16))); // 506
    // Centred horizontally.
    assert.equal(rect.top, 0);
    assert.equal(rect.left, Math.round((1600 - rect.width) / 2));
  });

  it("crops the top/bottom of a portrait source down to a landscape window (centre)", () => {
    // 900×1600 source, want 16:9 → crop is wide+short, full width.
    const rect = computeCropRect(900, 1600, 16 / 9, CENTRE);
    assert.equal(rect.width, 900);
    assert.equal(rect.height, Math.round(900 / (16 / 9))); // 506
    assert.equal(rect.left, 0);
    assert.equal(rect.top, Math.round((1600 - rect.height) / 2));
  });

  it("returns the whole image when source already matches target ratio", () => {
    const rect = computeCropRect(1000, 1000, 1, CENTRE);
    assert.deepEqual(rect, { left: 0, top: 0, width: 1000, height: 1000 });
  });

  it("focus 0 pins the crop to the left/top edge", () => {
    const rect = computeCropRect(1600, 900, 9 / 16, { x: 0, y: 0 });
    assert.equal(rect.left, 0);
    assert.equal(rect.top, 0);
  });

  it("focus 1 pins the crop to the right/bottom edge", () => {
    const rect = computeCropRect(1600, 900, 9 / 16, { x: 1, y: 1 });
    assert.equal(rect.left, 1600 - rect.width);
    // No vertical overflow here (full height), so top stays 0.
    assert.equal(rect.top, 0);
  });

  it("clamps out-of-range / NaN focus to a centre crop", () => {
    const centre = computeCropRect(1600, 900, 9 / 16, CENTRE);
    const high = computeCropRect(1600, 900, 9 / 16, { x: 5, y: 5 });
    const nan = computeCropRect(1600, 900, 9 / 16, { x: NaN, y: NaN });
    // x=5 clamps to 1 (right edge); NaN clamps to 0.5 (centre).
    assert.equal(high.left, 1600 - high.width);
    assert.equal(nan.left, centre.left);
  });
});

describe("cropBufferToAspect", () => {
  async function solid(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
  }

  it("crops a landscape source to a portrait (9:16) buffer", async () => {
    const src = await solid(1600, 900);
    const out = await cropBufferToAspect(src, "portrait", CENTRE);
    const meta = await sharp(out).metadata();
    assert.ok(meta.width && meta.height);
    // Ratio should be ~9:16 (allow ±1px rounding).
    const ratio = meta.width! / meta.height!;
    assert.ok(Math.abs(ratio - 9 / 16) < 0.02, `ratio ${ratio} not ~9:16`);
    assert.equal(meta.height, 900); // full height retained
  });

  it("crops a portrait source to a landscape (16:9) buffer", async () => {
    const src = await solid(900, 1600);
    const out = await cropBufferToAspect(src, "landscape", CENTRE);
    const meta = await sharp(out).metadata();
    const ratio = meta.width! / meta.height!;
    assert.ok(Math.abs(ratio - 16 / 9) < 0.02, `ratio ${ratio} not ~16:9`);
    assert.equal(meta.width, 900); // full width retained
  });

  it("returns a square-ratio buffer for an already-square source", async () => {
    const src = await solid(800, 800);
    const out = await cropBufferToAspect(src, "square", CENTRE);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 800);
  });
});
