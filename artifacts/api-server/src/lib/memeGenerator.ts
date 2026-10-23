import { createCanvas, loadImage, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  BRAND_ORANGE,
  MEME_ASPECT_RATIOS,
  DEFAULT_MEME_ASPECT_RATIO,
  type MemeAspectRatio,
} from "@workspace/api-zod";
import { hasUnresolvedFactTokens } from "./renderCanonical";
import { logger } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve and lazily register the bundled Anton font as both "Anton" and
 * "Impact" so that meme captions render with a chunky condensed display
 * face matching the client-side LivePreview (which asks for Impact).
 * Linux containers do not ship with Impact; without this the previous
 * default fell back to a generic sans-serif and produced a render that
 * did not match the studio preview at all.
 */
const ANTON_FONT_PATH = (() => {
  const candidates = [
    path.resolve(__dirname, "assets/fonts/Anton-Regular.ttf"),       // built layout
    path.resolve(__dirname, "..", "assets/fonts/Anton-Regular.ttf"), // src/lib → src/assets
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  return candidates[0]!;
})();

let fontsRegistered = false;
function ensureFontsRegistered() {
  if (fontsRegistered) return;
  try {
    GlobalFonts.registerFromPath(ANTON_FONT_PATH, "Anton");
    // Alias Anton as Impact so callers that ask for "Impact" (matching the
    // client-side LivePreview's font stack) get a visually equivalent face.
    GlobalFonts.registerFromPath(ANTON_FONT_PATH, "Impact");
  } catch {
    // Non-fatal: registration may fail in some test/dist layouts. The
    // canvas will fall back to a system sans-serif, which is the
    // pre-existing behaviour.
  }
  fontsRegistered = true;
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

export interface FramingTransform {
  offsetX?: number;
  offsetY?: number;
}

export interface TextOptions {
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  verticalPosition?: "top" | "middle" | "bottom";
  topText?: string;
  bottomText?: string;
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
 * Center-crops src dimensions to match the target aspect ratio,
 * returning {sx, sy, sw, sh} for ctx.drawImage.
 */
function centerCropParams(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  transform?: FramingTransform | null,
): { sx: number; sy: number; sw: number; sh: number } {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  let sx = 0, sy = 0, sw = srcW, sh = srcH;
  if (srcAspect > dstAspect) {
    sw = srcH * dstAspect;
    sx = (srcW - sw) / 2;
  } else {
    sh = srcW / dstAspect;
    sy = (srcH - sh) / 2;
  }

  if (transform) {
    const offsetX = Number.isFinite(transform.offsetX) ? transform.offsetX ?? 0 : 0;
    const offsetY = Number.isFinite(transform.offsetY) ? transform.offsetY ?? 0 : 0;
    sx -= offsetX * (sw / dstW);
    sy -= offsetY * (sh / dstH);
    sx = Math.max(0, Math.min(srcW - sw, sx));
    sy = Math.max(0, Math.min(srcH - sh, sy));
  }

  return { sx, sy, sw, sh };
}

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

export async function generateMemeBuffer(
  background: BackgroundSource,
  factText: string,
  options?: TextOptions,
  aspectRatio: MemeAspectRatio = DEFAULT_MEME_ASPECT_RATIO,
  framingTransform?: FramingTransform | null,
): Promise<Buffer> {
  ensureFontsRegistered();
  const { w: logicalW, h: logicalH } = MEME_ASPECT_RATIOS[aspectRatio];

  // Render at the cropped source resolution so we keep every available pixel,
  // capped on the longest edge (MAX_PHOTO_RENDER_PX) to bound output size.
  const img = await loadImage(background.imageData);
  const crop = centerCropParams(img.width, img.height, logicalW, logicalH, framingTransform);
  let renderW = Math.round(crop.sw);
  let renderH = Math.round(crop.sh);
  const longest = Math.max(renderW, renderH);
  if (longest > MAX_PHOTO_RENDER_PX) {
    const shrink = MAX_PHOTO_RENDER_PX / longest;
    renderW = Math.round(renderW * shrink);
    renderH = Math.round(renderH * shrink);
  }
  // Snap to the exact aspect ratio (rounding may have introduced ±1px drift).
  renderH = Math.round(renderW * (logicalH / logicalW));

  const canvas: Canvas = createCanvas(renderW, renderH);
  const ctx = canvas.getContext("2d");
  // @napi-rs/canvas defaults imageSmoothingQuality to "low" (bilinear).
  // Force "high" so any drawImage resampling (e.g. when the cropped source
  // does not exactly equal renderW×renderH after rounding) uses a better
  // resampler. Essentially free at our render sizes.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Render in logical coordinates; the canvas is scaled up uniformly.
  const scale = renderW / logicalW;
  ctx.scale(scale, scale);

  // ── Background ────────────────────────────────────────────────────
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, logicalW, logicalH);

  // Light vignette only — preserves the photo's colour. The client-side
  // LivePreview draws the photo with no overlay, and the bold outlined
  // caption (default) provides text readability without needing a heavy
  // wash. A previous 48% black overlay was making saved photos look
  // desaturated/posterised compared to the preview.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, 0, logicalW, logicalH);

  // ── Left accent bar ───────────────────────────────────────────────
  const sidebarW = 12;
  ctx.fillStyle = BRAND_ORANGE;
  ctx.fillRect(0, 0, sidebarW, logicalH);

  // ── Ghost watermark letters ───────────────────────────────────────
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(logicalH * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("OM", logicalW - 24, logicalH * 0.72);

  // ── Text ──────────────────────────────────────────────────────────
  const blocks = resolveTextBlocks(factText, options);
  // Type-size selection deliberately keys off the *requested* format (whether
  // the caller sent a split pair), not off `blocks.mode` — so the token
  // fallback above changes only WHICH text is drawn, never how large it is.
  const hasNewFormat = !!(options?.topText !== undefined || options?.bottomText !== undefined);
  // Defaults below mirror the client-side LivePreview so the saved/downloaded
  // render is visually consistent with what the user saw in the studio. Prior
  // to this change, when callers omitted textOptions (the studio sent
  // `textOptions: {}` for its photo memes), the server fell into a legacy
  // sans-serif / lowercase / shadow / left-aligned path that did not match
  // the client preview at all.
  const autoLegacySize = factText.length > 120 ? 22 : factText.length > 70 ? 26 : 32;
  const defaultSize = hasNewFormat ? 30 : autoLegacySize;
  const fontSize = Math.min(Math.max(options?.fontSize ?? defaultSize, 14), 100);
  const textColor = options?.color ?? "#ffffff";
  const textAlign = options?.align ?? "center";
  const fontFamily = options?.fontFamily ?? "Impact";
  const textEffect = options?.textEffect ?? "outline";
  const outlineColor = options?.outlineColor ?? "#000000";
  const outlineWidthVal = options?.outlineWidth ?? 5;
  const allCaps = options?.allCaps ?? true;
  const isBold = options?.bold ?? true;
  const isItalic = options?.italic ?? false;
  const textOpacity = options?.opacity ?? 1;

  const padding = 40;
  const maxW = logicalW - padding * 2 - sidebarW;
  const fontStyle = `${isItalic ? "italic " : ""}${isBold ? "bold " : ""}`;
  const fontStr = `${fontStyle}${fontSize}px "${fontFamily}", sans-serif`;

  const textAreaLeft = padding + sidebarW;
  const textAreaRight = logicalW - padding;
  const textX =
    textAlign === "right" ? textAreaRight
    : textAlign === "center" ? (textAreaLeft + textAreaRight) / 2
    : textAreaLeft + 4;

  function wrapText(text: string): string[] {
    const display = allCaps ? text.toUpperCase() : text;
    ctx.font = fontStr;
    const words = display.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function renderBlock(lines: string[], position: "top" | "middle" | "bottom") {
    if (lines.length === 0) return;
    const lineH = fontSize * 1.25;
    const totalH = lines.length * lineH;
    let startY: number;
    if (position === "top") startY = padding + fontSize;
    else if (position === "bottom") startY = logicalH - padding - totalH + fontSize;
    else startY = (logicalH - totalH) / 2 + fontSize;

    ctx.save();
    ctx.globalAlpha = textOpacity;
    ctx.font = fontStr;
    ctx.textAlign = textAlign;

    lines.forEach((line, i) => {
      const y = startY + i * lineH;
      if (textEffect === "outline") {
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = outlineWidthVal * 2;
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(line, textX, y);
      }
      if (textEffect === "shadow") {
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
      }
      ctx.fillStyle = textColor;
      ctx.fillText(line, textX, y);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    });
    ctx.restore();
  }

  if (blocks.mode === "split") {
    if (blocks.topText.trim()) renderBlock(wrapText(blocks.topText), "top");
    if (blocks.bottomText.trim()) renderBlock(wrapText(blocks.bottomText), "bottom");
  } else {
    renderBlock(wrapText(blocks.text), options?.verticalPosition ?? "middle");
  }

  // ── Watermark ─────────────────────────────────────────────────────
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("overhype.me", logicalW - 18, logicalH - 14);

  return canvas.toBuffer("image/jpeg", OUTPUT_JPEG_QUALITY);
}
