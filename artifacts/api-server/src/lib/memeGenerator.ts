import { createCanvas, loadImage, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  MEME_CANVAS_DIMS,
  WATERMARK_FONT_ID,
  coverPlacement,
  drawMeme,
  type MemeCanvasContext,
  type MemeCaption,
  DEFAULT_MEME_ASPECT_RATIO,
  type MemeAspectRatio,
  CAPTION_FONTS,
  captionFontById,
  captionFontStack,
  isCaptionFontId,
  type CaptionFontId,
} from "@workspace/api-zod";
import { hasUnresolvedFactTokens } from "./renderCanonical";
import { logger } from "./logger";
import { watermarkPixels } from "./provenance/watermark";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the renderer looks for a bundled font file, given the directory this
 * module runs from. The fonts live in `src/assets/fonts/`, which the build
 * copies to `dist/assets/` (`build.mjs`), so one candidate serves the bundle
 * (whose `__dirname` is `dist/`) and the other the source tree (`src/lib/`).
 * Until 2026-11-01 Anton sat in `src/lib/assets/`, which the build never
 * copies, so built servers drew captions in a fallback face.
 */
export function fontFileCandidates(dir: string, file: string): string[] {
  return [
    path.resolve(dir, "assets/fonts", file),       // built layout: dist/ → dist/assets
    path.resolve(dir, "..", "assets/fonts", file), // src/lib → src/assets
  ];
}

function resolveFontFile(file: string): string {
  const candidates = fontFileCandidates(__dirname, file);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  return candidates[0]!;
}

/** Caption faces that registered, by catalogue id. */
const registeredCaptionFonts = new Set<CaptionFontId>();

/**
 * Test seam: run `fn` as if `id` had failed to register. The registry is
 * process-wide and the test runner shares one process, so a test cannot
 * observe a real registration failure without one.
 */
export async function withCaptionFontUnregisteredForTest<T>(id: CaptionFontId, fn: () => Promise<T>): Promise<T> {
  ensureFontsRegistered();
  const had = registeredCaptionFonts.delete(id);
  try {
    return await fn();
  } finally {
    if (had) registeredCaptionFonts.add(id);
  }
}

let fontsRegistered = false;
function ensureFontsRegistered() {
  if (fontsRegistered) return;
  // registerFromPath reports a missing or unreadable file by returning null,
  // not by throwing, so each result is checked rather than caught.
  const register = (file: string, family: string): boolean => {
    try {
      return GlobalFonts.registerFromPath(resolveFontFile(file), family) != null;
    } catch {
      return false;
    }
  };
  // Stored recipes from before the caption-font catalogue name "Impact" (or
  // nothing, which means Impact), and Anton has always stood in for it. They
  // keep exactly that.
  const anton = register("Anton-Regular.ttf", "Anton") && register("Anton-Regular.ttf", "Impact");
  if (!anton) {
    logger.warn({ file: "Anton-Regular.ttf" }, "meme font Anton could not be registered; legacy captions use a fallback face");
  }
  for (const font of CAPTION_FONTS) {
    if (register(font.file, font.family)) registeredCaptionFonts.add(font.id);
    else logger.error({ font: font.id, file: font.file }, "caption font could not be registered; memes in it will not render");
  }
  fontsRegistered = true;
}

/**
 * The canvas font for a caption. A catalogue id draws its own face at its one
 * weight, and refuses when that face did not register, rather than storing a
 * meme in a fallback face that does not match its preview (the PR #831
 * failure). Anything else is a stored recipe from before the catalogue and
 * resolves exactly as it always has.
 */
export function captionCanvasFont(options: Pick<TextOptions, "fontFamily" | "bold" | "italic"> | undefined, fontSize: number): string {
  const italic = options?.italic ? "italic " : "";
  const fontFamily = options?.fontFamily;
  if (isCaptionFontId(fontFamily)) {
    if (!registeredCaptionFonts.has(fontFamily)) {
      throw new Error(`caption font "${fontFamily}" is not available on this server`);
    }
    const font = captionFontById(fontFamily);
    return `${italic}${font.weight} ${fontSize}px ${captionFontStack(font)}`;
  }
  const bold = (options?.bold ?? true) ? "bold " : "";
  return `${italic}${bold}${fontSize}px "${fontFamily ?? "Impact"}", sans-serif`;
}

/**
 * Maximum longest-edge resolution for photo-backed meme renders.
 * Matches the client-side upload cap so the server never produces
 * an output larger than the source the user uploaded.
 */
const MAX_PHOTO_RENDER_PX = 6000;

/**
 * Output JPEG quality used for the final encode.
 *
 * @napi-rs/canvas's `toBuffer("image/jpeg", quality)` takes a 0-100 INTEGER
 * (see node_modules/@napi-rs/canvas/index.d.ts: "Encoding quality: 0-100 for
 * lossy JPEG"). The previous value of 0.9 was being interpreted as quality 0
 * or 1 — rounding to the worst possible JPEG and producing ~22 KB outputs
 * for 1880×1058 photos with the chunky 8×8 block artifacts the user reported.
 * 90 is the standard "high quality" JPEG setting.
 */
const OUTPUT_JPEG_QUALITY = 90;

/** The face the watermark is drawn in: a catalogue face, so the preview draws it identically. */
const WATERMARK_FONT = captionFontById(WATERMARK_FONT_ID);

export interface FramingTransform {
  offsetX?: number;
  offsetY?: number;
}

export interface TextOptions {
  fontSize?: number;
  /** The caption colour, as the builder sends it. */
  textColor?: string;
  /** The older spelling; read only when `textColor` is absent. */
  color?: string;
  align?: "left" | "center" | "right";
  verticalPosition?: "top" | "middle" | "bottom";
  topText?: string;
  bottomText?: string;
  /**
   * Where the builder's position slider put each caption half: the half's
   * vertical midpoint, as a percentage (0–100) of the image height, the same
   * rule LivePreview's `drawBlock` draws by. Absent: the fixed top/bottom
   * bands, as before (#707).
   */
  topY?: number;
  bottomY?: number;
  fontFamily?: string;
  outlineColor?: string;
  textEffect?: "shadow" | "outline" | "none";
  outlineWidth?: number;
  allCaps?: boolean;
  bold?: boolean;
  italic?: boolean;
  opacity?: number;
}

/**
 * Where the background image comes from: a Buffer (the user's own photo) or a
 * URL string. The gradient templates and stock photos were deleted in Launch
 * Phase 4, removals 5 and 6.
 */
export type BackgroundSource = { type: "image"; imageData: string | Buffer };

/**
 * Which text this render actually draws.
 *
 * `factText` and `options.topText`/`options.bottomText` are two representations
 * of the SAME sentence: the split pair is the fact cut in two by the studio's
 * split slider. Whenever either half is present the split pair wins and
 * `factText` is never drawn — which is why a caller that personalises only
 * `factText` silently bakes raw `{NAME}` into the finished meme.
 *
 * Callers MUST personalise the split halves too (see
 * `personalizeMemeTextOptions` in `memeComposite.ts`). This function is the
 * last line of defence for the ones that don't: when a half still carries
 * unresolved template tokens but `factText` does not, the split is abandoned
 * and the resolved `factText` is drawn as one block. A meme whose caption sits
 * in the wrong position is bad; a public, shareable image reading "{NAME}
 * MAKES ONIONS CRY" is worse.
 */
export type ResolvedTextBlocks =
  | { mode: "split"; topText: string; bottomText: string }
  | { mode: "single"; text: string };

export function resolveTextBlocks(
  factText: string,
  options?: Pick<TextOptions, "topText" | "bottomText">,
): ResolvedTextBlocks {
  const hasSplit = options?.topText !== undefined || options?.bottomText !== undefined;
  if (!hasSplit) return { mode: "single", text: factText };

  const topText = options?.topText ?? "";
  const bottomText = options?.bottomText ?? "";
  const splitHasTokens =
    hasUnresolvedFactTokens(topText) || hasUnresolvedFactTokens(bottomText);

  if (splitHasTokens && !hasUnresolvedFactTokens(factText)) {
    logger.error(
      { topText, bottomText },
      "[memeGenerator] split caption still carries unresolved fact tokens — " +
        "falling back to the personalised factText. The calling render path is " +
        "missing personalizeMemeTextOptions().",
    );
    return { mode: "single", text: factText };
  }

  return { mode: "split", topText, bottomText };
}

/**
 * The caption a render draws, in runs, when the caller has only the
 * personalised words (no template, so the name cannot be told apart and is
 * drawn in the caption colour).
 */
function captionFromText(factText: string, options?: TextOptions): MemeCaption {
  const blocks = resolveTextBlocks(factText, options);
  const run = (text: string) => (text ? [{ text, isName: false }] : []);
  return blocks.mode === "split"
    ? { mode: "split", top: run(blocks.topText), bottom: run(blocks.bottomText) }
    : { mode: "single", text: run(blocks.text) };
}

/**
 * The caption a render with these inputs draws, in runs: `caption` when the
 * caller passed one, otherwise the runs `generateMemeBuffer` builds from the
 * words and options. A provenance record keeps exactly this (image tracing).
 */
export function drawnCaption(factText: string, options?: TextOptions, caption?: MemeCaption): MemeCaption {
  return caption ?? captionFromText(factText, options);
}

/** The words a caption draws, as plain text: one line, or the top and bottom lines. */
export function captionPlainText(caption: MemeCaption): string {
  const words = (runs: { text: string }[]) => runs.map((r) => r.text).join("");
  return caption.mode === "split" ? `${words(caption.top)}\n${words(caption.bottom)}` : words(caption.text);
}

/**
 * Renders a meme to a JPEG with the shared drawing (`drawMeme`, #870), the
 * one the builder's preview uses, in the same logical canvas, so the file is
 * what the preview showed. The output is drawn at the photo's own resolution
 * for the visible area (never below the logical canvas, capped at
 * MAX_PHOTO_RENDER_PX on the longest edge), the logical canvas scaled up
 * uniformly.
 *
 * `caption` carries the name marked so it is drawn in its colour; callers
 * holding the template build it with `memeCaption`. Without it the caption is
 * `factText` (or the split halves of `options`) with no name marked.
 *
 * `watermarkId`, when given, is the provenance record id the pixels are marked
 * with (lib/provenance/watermark.ts) before the JPEG is encoded; only the
 * provenance layer passes it (lib/provenance/meme.ts), never a caller that
 * would then send the picture without its record.
 */
export async function generateMemeBuffer(
  background: BackgroundSource,
  factText: string,
  options?: TextOptions,
  aspectRatio: MemeAspectRatio = DEFAULT_MEME_ASPECT_RATIO,
  framingTransform?: FramingTransform | null,
  caption?: MemeCaption,
  watermarkId?: number,
): Promise<Buffer> {
  ensureFontsRegistered();
  const { w: logicalW, h: logicalH } = MEME_CANVAS_DIMS[aspectRatio];
  const img = await loadImage(background.imageData);
  const framingOffset = framingTransform
    ? { x: Number(framingTransform.offsetX ?? 0), y: Number(framingTransform.offsetY ?? 0) }
    : null;

  // The visible part of the photo, in its own pixels, sets the output size.
  const placement = coverPlacement(img.width, img.height, logicalW, logicalH, framingOffset);
  let renderW = Math.max(logicalW, Math.round(logicalW / placement.ratio));
  let renderH = Math.round(renderW * (logicalH / logicalW));
  const longest = Math.max(renderW, renderH);
  if (longest > MAX_PHOTO_RENDER_PX) {
    const shrink = MAX_PHOTO_RENDER_PX / longest;
    renderW = Math.round(renderW * shrink);
    renderH = Math.round(renderW * (logicalH / logicalW));
  }

  const canvas: Canvas = createCanvas(renderW, renderH);
  const ctx = canvas.getContext("2d");
  // @napi-rs/canvas defaults imageSmoothingQuality to "low" (bilinear).
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const scale = renderW / logicalW;
  ctx.scale(scale, scale);

  drawMeme(ctx as unknown as MemeCanvasContext, {
    image: img,
    drawImage: (image, x, y, w, h) => ctx.drawImage(image, x, y, w, h),
    aspectRatio,
    framingOffset,
    caption: drawnCaption(factText, options, caption),
    style: options ?? {},
    captionFont: (size) => captionCanvasFont(options, size),
    watermarkFont: (size) => `${WATERMARK_FONT.weight} ${size}px ${captionFontStack(WATERMARK_FONT)}`,
    deviceScale: scale,
  });

  if (watermarkId !== undefined) {
    // Pixel reads and writes in device pixels: @napi-rs/canvas applies the
    // drawing transform to getImageData/putImageData, so the scale goes first.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const pixels = ctx.getImageData(0, 0, renderW, renderH);
    await watermarkPixels(pixels.data, renderW, renderH, 4, watermarkId);
    ctx.putImageData(pixels, 0, 0);
  }

  return canvas.toBuffer("image/jpeg", OUTPUT_JPEG_QUALITY);
}
