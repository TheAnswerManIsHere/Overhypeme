/**
 * @purpose The one crop calculation behind the profile-photo zoom-and-crop editor: from an image's size, a zoom and a centre point it gives the square of source pixels that both the on-screen preview and the saved JPEG draw, clamped inside the image; plus pan, zoom-about-a-point, decoding a picked file to a still opaque snapshot, and encoding the chosen square as a JPEG of at most 1024 px.
 * @subsystem studio
 */

import { CLIENT_JPEG_QUALITY } from "@/lib/image-upload";

/** Largest zoom: the framed square is a quarter of the image's short side. */
export const MAX_ZOOM = 4;
export const MIN_ZOOM = 1;

/** Where the editor is framed: `zoom` 1 shows the largest square that fits; `cx`/`cy` are the square's centre in source pixels. */
export interface CropView {
  zoom: number;
  cx: number;
  cy: number;
}

export interface SourceSquare {
  sx: number;
  sy: number;
  side: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function clampZoom(zoom: number): number {
  return clamp(Number.isFinite(zoom) ? zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
}

/** The side, in source pixels, of the square framed at `zoom`. */
export function squareSide(size: ImageSize, zoom: number): number {
  return Math.min(size.width, size.height) / clampZoom(zoom);
}

/** The view brought back inside the image: zoom within range, and the square never leaving the photo. */
export function clampView(size: ImageSize, view: CropView): CropView {
  const zoom = clampZoom(view.zoom);
  const half = squareSide(size, zoom) / 2;
  return {
    zoom,
    cx: clamp(view.cx, half, size.width - half),
    cy: clamp(view.cy, half, size.height - half),
  };
}

/** The opening view: today's centre square at minimum zoom. */
export function defaultView(size: ImageSize): CropView {
  return { zoom: MIN_ZOOM, cx: size.width / 2, cy: size.height / 2 };
}

/** The square of source pixels the view frames — what the preview shows and the export saves. */
export function sourceSquare(size: ImageSize, view: CropView): SourceSquare {
  const v = clampView(size, view);
  const side = squareSide(size, v.zoom);
  return { sx: v.cx - side / 2, sy: v.cy - side / 2, side };
}

/** Move the photo by a drag of (dx, dy) screen pixels on a stage `stageSize` pixels across. */
export function panView(size: ImageSize, view: CropView, dx: number, dy: number, stageSize: number): CropView {
  const v = clampView(size, view);
  const perScreenPx = squareSide(size, v.zoom) / stageSize;
  return clampView(size, { zoom: v.zoom, cx: v.cx - dx * perScreenPx, cy: v.cy - dy * perScreenPx });
}

/**
 * Change zoom keeping the source point under stage point (ax, ay) where it is — a pinch
 * zooms about the fingers, the slider about the centre.
 */
export function zoomView(
  size: ImageSize,
  view: CropView,
  nextZoom: number,
  stageSize: number,
  ax = stageSize / 2,
  ay = stageSize / 2,
): CropView {
  const before = sourceSquare(size, view);
  const px = before.sx + (ax / stageSize) * before.side;
  const py = before.sy + (ay / stageSize) * before.side;
  const zoom = clampZoom(nextZoom);
  const side = squareSide(size, zoom);
  const sx = px - (ax / stageSize) * side;
  const sy = py - (ay / stageSize) * side;
  return clampView(size, { zoom, cx: sx + side / 2, cy: sy + side / 2 });
}

/** The saved file's width and height: the framed square at its own pixel size, never enlarged, capped at `maxSize`. */
export function outputSize(square: SourceSquare, maxSize = 1024): number {
  return Math.max(1, Math.min(Math.round(square.side), maxSize));
}

/**
 * The largest pixel area a canvas may hold on iOS Safari (4096 × 4096); a bigger
 * snapshot fails to draw there. A photo above it is snapshotted at reduced scale.
 */
export const MAX_SNAPSHOT_PIXELS = 16_777_216;

/**
 * The snapshot's short side never needs to exceed this: at the largest zoom the framed
 * square is a quarter of it, which is still the 1024-px output. More pixels only cost memory
 * and slow every preview redraw.
 */
export const MAX_SNAPSHOT_SHORT_SIDE = 1024 * MAX_ZOOM;

/**
 * Decode a picked file once into a still, opaque canvas — the first frame of an animated
 * image, transparency flattened onto black as JPEG encoding would — so the preview and
 * the export draw from exactly the same pixels. Orientation is applied by the browser's
 * decode, as today's conversion relies on.
 */
export async function decodeToSnapshot(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new globalThis.Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not decode image"));
      i.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w <= 0 || h <= 0) throw new Error("Image has no pixels");
    const scale = Math.min(1, Math.sqrt(MAX_SNAPSHOT_PIXELS / (w * h)), MAX_SNAPSHOT_SHORT_SIDE / Math.min(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(w * scale));
    canvas.height = Math.max(1, Math.floor(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draw the framed square of `source` to fill `ctx`'s canvas — shared by the preview and the export. */
export function drawSquare(ctx: CanvasRenderingContext2D, source: CanvasImageSource, square: SourceSquare): void {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, square.sx, square.sy, square.side, square.side, 0, 0, width, height);
}

/** Encode the framed square as the square JPEG the profile photo is stored as. */
export async function exportSquareJpeg(
  snapshot: HTMLCanvasElement,
  view: CropView,
  fileName: string,
  maxSize = 1024,
): Promise<File> {
  const square = sourceSquare({ width: snapshot.width, height: snapshot.height }, view);
  const out = outputSize(square, maxSize);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  drawSquare(ctx, snapshot, square);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", CLIENT_JPEG_QUALITY));
  if (!blob) throw new Error("Could not encode image");
  const baseName = fileName.replace(/\.[^.]+$/, "") || "photo";
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
}
