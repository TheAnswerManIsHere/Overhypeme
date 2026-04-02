/**
 * AI Meme Compositor
 *
 * Loads a generated AI scene background from object storage, composites
 * the personalized fact text (bold, ALL-CAPS, white with black outline) on
 * top, and returns a JPEG buffer.
 *
 * Text rendering specs:
 * - Font: Anton (meme-style), 48px max, scales down to 24px minimum
 * - White fill with 2-3px black outline + drop shadow
 * - 15-20% darkening overlay over the background
 * - Word-wrapped to fit within 85% of the 1024px width
 */

import { createCanvas, loadImage, registerFont } from "@napi-rs/canvas";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { ObjectStorageService } from "./objectStorage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.resolve(__dirname, "assets/fonts/Anton-Regular.ttf");

let fontRegistered = false;
function ensureFontRegistered() {
  if (!fontRegistered) {
    registerFont(FONT_PATH, { family: "Anton" });
    fontRegistered = true;
  }
}

const CANVAS_SIZE = 1024;
const PADDING_X = Math.round(CANVAS_SIZE * 0.075);
const TEXT_MAX_W = CANVAS_SIZE - PADDING_X * 2;
const MAX_FONT_SIZE = 72;
const MIN_FONT_SIZE = 24;

const objectStorage = new ObjectStorageService();

/**
 * Download a buffer from object storage.
 */
async function loadBufferFromStorage(storedPath: string): Promise<Buffer> {
  const objectFile = await objectStorage.getObjectEntityFile(storedPath);
  const response = await objectStorage.downloadObject(objectFile);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Word-wrap text to fit within maxWidth at the given font size.
 * Returns an array of lines.
 */
function wrapText(
  ctx: ReturnType<typeof createCanvas>["getContext"],
  text: string,
  maxWidth: number,
): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Find the largest font size that fits within maxWidth and a reasonable
 * number of lines (start at MAX_FONT_SIZE, reduce by 4px each step).
 */
function fitFont(
  ctx: ReturnType<typeof createCanvas>["getContext"],
  text: string,
  maxWidth: number,
  maxLines: number,
): { size: number; lines: string[] } {
  for (let size = MAX_FONT_SIZE; size >= MIN_FONT_SIZE; size -= 4) {
    ctx.font = `${size}px "Anton", sans-serif`;
    const lines = wrapText(ctx, text, maxWidth);
    if (lines.length <= maxLines) {
      return { size, lines };
    }
  }
  // Fallback: use minimum size
  ctx.font = `${MIN_FONT_SIZE}px "Anton", sans-serif`;
  return { size: MIN_FONT_SIZE, lines: wrapText(ctx, text, maxWidth) };
}

/**
 * Composite text on top of an image buffer loaded from storage.
 * Returns a JPEG buffer.
 */
export async function compositeAiMeme(
  backgroundStoragePath: string,
  factText: string,
): Promise<Buffer> {
  ensureFontRegistered();

  // Load background image
  const bgBuffer = await loadBufferFromStorage(backgroundStoragePath);
  const bgImage = await loadImage(bgBuffer);

  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");

  // Draw background (center-crop to square)
  const srcW = bgImage.width;
  const srcH = bgImage.height;
  const srcSize = Math.min(srcW, srcH);
  const sx = (srcW - srcSize) / 2;
  const sy = (srcH - srcSize) / 2;
  ctx.drawImage(bgImage, sx, sy, srcSize, srcSize, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Darkening overlay (15-20%)
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Determine font + line wrapping
  const MAX_LINES = 6;
  const { size: fontSize, lines } = fitFont(ctx, factText, TEXT_MAX_W, MAX_LINES);
  ctx.font = `${fontSize}px "Anton", sans-serif`;

  const lineHeight = fontSize * 1.2;
  const totalTextH = lines.length * lineHeight;
  const startY = (CANVAS_SIZE - totalTextH) / 2 + fontSize * 0.85;

  ctx.textAlign = "center";
  const centerX = CANVAS_SIZE / 2;
  const outlineWidth = Math.max(2, Math.round(fontSize * 0.05));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const y = startY + i * lineHeight;

    // Drop shadow
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = fontSize * 0.12;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    // Black outline
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = outlineWidth * 2;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(line, centerX, y);

    // White fill
    ctx.fillStyle = "#ffffff";
    ctx.fillText(line, centerX, y);
    ctx.restore();
  }

  // Watermark
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = "bold 18px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.textAlign = "right";
  ctx.fillText("overhype.me", CANVAS_SIZE - 20, CANVAS_SIZE - 16);

  return canvas.toBuffer("image/jpeg", 90);
}
