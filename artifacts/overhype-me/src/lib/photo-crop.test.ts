import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  clampView,
  defaultView,
  outputSize,
  panView,
  sourceSquare,
  squareSide,
  zoomView,
  type CropView,
  type ImageSize,
} from "./photo-crop";

const SIZES: ImageSize[] = [
  { width: 4000, height: 3000 },
  { width: 3000, height: 4000 },
  { width: 1000, height: 1000 },
  { width: 640, height: 200 },
  { width: 37, height: 1500 },
];
const ZOOMS = [1, 1.37, 2, 3.9, 4];
const STAGE = 288;

function inside(size: ImageSize, view: CropView) {
  const s = sourceSquare(size, view);
  expect(s.sx).toBeGreaterThanOrEqual(-1e-9);
  expect(s.sy).toBeGreaterThanOrEqual(-1e-9);
  expect(s.sx + s.side).toBeLessThanOrEqual(size.width + 1e-9);
  expect(s.sy + s.side).toBeLessThanOrEqual(size.height + 1e-9);
}

describe("photo crop geometry", () => {
  it("opens on today's centre square — the result of confirming untouched", () => {
    for (const size of SIZES) {
      const side = Math.min(size.width, size.height);
      const s = sourceSquare(size, defaultView(size));
      expect(s.side).toBe(side);
      // Today's crop: floor((w - side) / 2); the editor's is the exact centre, within a pixel.
      expect(Math.abs(s.sx - Math.floor((size.width - side) / 2))).toBeLessThan(1);
      expect(Math.abs(s.sy - Math.floor((size.height - side) / 2))).toBeLessThan(1);
    }
  });

  it("keeps the framed square inside the photo for any zoom and any drag", () => {
    for (const size of SIZES) {
      for (const zoom of ZOOMS) {
        for (const [dx, dy] of [[0, 0], [1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6], [1e6, -1e6], [-37, 52]]) {
          const v = panView(size, { ...defaultView(size), zoom }, dx, dy, STAGE);
          inside(size, v);
          expect(sourceSquare(size, v).side).toBeCloseTo(Math.min(size.width, size.height) / zoom, 9);
        }
      }
    }
  });

  it("clamps the zoom to its range, including nonsense input", () => {
    const size = SIZES[0];
    expect(clampView(size, { zoom: 0.2, cx: 0, cy: 0 }).zoom).toBe(1);
    expect(clampView(size, { zoom: 99, cx: 0, cy: 0 }).zoom).toBe(MAX_ZOOM);
    expect(clampView(size, { zoom: Number.NaN, cx: 0, cy: 0 }).zoom).toBe(1);
  });

  it("moves the photo with the finger: a drag right shows more of the left", () => {
    const size = { width: 4000, height: 3000 };
    const v0 = { zoom: 2, cx: 2000, cy: 1500 };
    const v1 = panView(size, v0, 72, 0, STAGE);
    // 72 of 288 screen px is a quarter of the frame; the frame is 1500 source px at zoom 2.
    expect(v1.cx).toBeCloseTo(2000 - 375, 9);
    expect(v1.cy).toBe(1500);
  });

  it("zooms about the anchor point: the source pixel under the fingers stays under them", () => {
    for (const size of SIZES) {
      for (const [ax, ay] of [[0, 0], [STAGE / 2, STAGE / 2], [200, 40], [STAGE, STAGE]]) {
        const before = { zoom: 1.5, cx: size.width / 2, cy: size.height / 2 };
        const after = zoomView(size, before, 2.5, STAGE, ax, ay);
        inside(size, after);
        const b = sourceSquare(size, before);
        const a = sourceSquare(size, after);
        const pBefore = [b.sx + (ax / STAGE) * b.side, b.sy + (ay / STAGE) * b.side];
        const pAfter = [a.sx + (ax / STAGE) * a.side, a.sy + (ay / STAGE) * a.side];
        // Exact unless the clamp had to pull the square back inside the photo.
        const clamped = a.sx <= 1e-9 || a.sy <= 1e-9 || a.sx + a.side >= size.width - 1e-9 || a.sy + a.side >= size.height - 1e-9;
        if (!clamped) {
          expect(pAfter[0]).toBeCloseTo(pBefore[0], 6);
          expect(pAfter[1]).toBeCloseTo(pBefore[1], 6);
        }
      }
    }
  });

  it("saves the framed square at its own size, never enlarged, capped at 1024", () => {
    expect(outputSize({ sx: 0, sy: 0, side: 3000 })).toBe(1024);
    expect(outputSize({ sx: 0, sy: 0, side: 1024 })).toBe(1024);
    expect(outputSize({ sx: 0, sy: 0, side: 500 })).toBe(500);
    expect(outputSize({ sx: 0, sy: 0, side: 9.25 })).toBe(9);
    expect(outputSize({ sx: 0, sy: 0, side: 0.2 })).toBe(1);
    const small = { width: 640, height: 200 };
    expect(outputSize(sourceSquare(small, { zoom: 4, cx: 0, cy: 0 }))).toBe(squareSide(small, 4));
  });
});
