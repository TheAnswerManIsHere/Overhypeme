/**
 * The one drawing of a meme (#870). The builder's preview and the server's
 * save both call `drawMeme` with the same recipe, in the same logical canvas,
 * so the saved file is the preview: same crop, same caption lines, same
 * colours, same watermark. Until 2026-11-04 the server had its own renderer,
 * written separately, and every place the two disagreed reached the saved
 * file (a different canvas size, so a different crop; a different font size,
 * line height and wrap width; a white name; an orange bar, a darkening wash
 * and ghost "OM" letters the preview never drew).
 *
 * The canvas is typed structurally (`MemeCanvasContext`) so the same code runs
 * on a browser `CanvasRenderingContext2D` and on `@napi-rs/canvas`. Each side
 * supplies only what genuinely differs: the photo object and how a caption
 * font string is spelled for it.
 *
 * @purpose The shared meme drawing routine and its caption segmentation, called by the builder's live preview and the server's meme renderer so a saved meme is drawn exactly as its preview was.
 * @subsystem meme-studio
 */
import { renderTemplateSegments, resolveIdentityForms } from "./resolvedIdentityForms";

export type MemeCanvasAspectRatio = "landscape" | "square" | "portrait";

/**
 * The logical canvas each aspect ratio is laid out in. These are the
 * preview's dimensions, and the units a stored recipe's `framingTransform`
 * and `fontSize` were chosen in, so they cannot change without migrating
 * stored recipes.
 */
export const MEME_CANVAS_DIMS: Record<MemeCanvasAspectRatio, { w: number; h: number }> = {
  landscape: { w: 1280, h: 720 },
  square: { w: 1080, h: 1080 },
  portrait: { w: 720, h: 1280 },
};

/** The colour the person's name is drawn in, everywhere a caption names them. */
export const MEME_NAME_COLOR = "#ff6b35";

/**
 * The caption-font catalogue face the watermark is drawn in. A catalogue face
 * ships to both the browser and the server, so the mark is the same glyphs in
 * the preview and the file (a bare `sans-serif` resolves differently in each).
 */
export const WATERMARK_FONT_ID = "sans" as const;

/** The text of the watermark every meme carries. */
export const MEME_WATERMARK_TEXT = "overhype.me";

/** One run of caption text; `isName` runs are drawn in `MEME_NAME_COLOR`. */
export interface CaptionSegment {
  text: string;
  isName: boolean;
}

export type MemeCaption =
  | { mode: "split"; top: CaptionSegment[]; bottom: CaptionSegment[] }
  | { mode: "single"; text: CaptionSegment[] };

/** The caption styling a recipe carries (the builder's `MemeTextOptions`). */
export interface MemeCaptionStyle {
  fontSize?: number;
  textColor?: string;
  /** Older server-side spelling of `textColor`; read only when `textColor` is absent. */
  color?: string;
  outlineColor?: string;
  textEffect?: "shadow" | "outline" | "none";
  allCaps?: boolean;
  topY?: number;
  bottomY?: number;
}

export const DEFAULT_CAPTION_TOP_Y = 17;
export const DEFAULT_CAPTION_BOTTOM_Y = 88;

/** The subset of the 2D canvas API the drawing uses: both browser and `@napi-rs/canvas` satisfy it. */
export interface MemeCanvasContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  save(): void;
  restore(): void;
}

export interface DrawMemeInput<Img extends { width: number; height: number }> {
  /** The photo, or null to draw the dark backdrop alone. */
  image: Img | null;
  /** Draws `image` at (x, y) scaled to w×h, in logical units. */
  drawImage: (image: Img, x: number, y: number, w: number, h: number) => void;
  aspectRatio: MemeCanvasAspectRatio;
  /** Pan offset in logical canvas units; positive x shifts the photo right, positive y down. */
  framingOffset?: { x: number; y: number } | null;
  caption: MemeCaption;
  style: MemeCaptionStyle;
  /** The canvas `font` for the caption face at a size. */
  captionFont: (fontSize: number) => string;
  /** The canvas `font` for the watermark at a size. */
  watermarkFont: (fontSize: number) => string;
  /**
   * Device pixels per logical unit. Canvas shadows are not transformed by
   * `scale()`, so a renderer drawing at a larger size passes its scale and the
   * shadow grows with everything else.
   */
  deviceScale?: number;
  /** Draw the watermark (default true). The preview holds it back until its face has loaded. */
  watermark?: boolean;
}

/** Where a photo of `imageW×imageH` is drawn to cover the canvas, with the pan clamped to the photo's edges. */
export function coverPlacement(
  imageW: number,
  imageH: number,
  canvasW: number,
  canvasH: number,
  framingOffset?: { x: number; y: number } | null,
): { x: number; y: number; w: number; h: number; ratio: number } {
  const ratio = Math.max(canvasW / imageW, canvasH / imageH);
  const w = imageW * ratio;
  const h = imageH * ratio;
  const maxOffsetX = Math.max(0, (w - canvasW) / 2);
  const maxOffsetY = Math.max(0, (h - canvasH) / 2);
  const ox = framingOffset && Number.isFinite(framingOffset.x)
    ? Math.min(maxOffsetX, Math.max(-maxOffsetX, framingOffset.x))
    : 0;
  const oy = framingOffset && Number.isFinite(framingOffset.y)
    ? Math.min(maxOffsetY, Math.max(-maxOffsetY, framingOffset.y))
    : 0;
  return { x: (canvasW - w) / 2 + ox, y: (canvasH - h) / 2 + oy, w, h, ratio };
}

/** The caption's font size in logical units: the recipe's, or 7% of the canvas height. */
export function captionFontSize(style: MemeCaptionStyle, aspectRatio: MemeCanvasAspectRatio): number {
  return style.fontSize ?? Math.floor(MEME_CANVAS_DIMS[aspectRatio].h * 0.07);
}

/**
 * A fact template personalised into caption runs, the name (and its
 * possessive) marked so it can be drawn in its own colour. The words are
 * exactly what `renderTemplateWithIdentityForms` produces for the same
 * identity: the same token resolution, run by run.
 */
export function captionSegments(template: string, name: string, pronouns: string | null | undefined): CaptionSegment[] {
  return renderTemplateSegments(template, resolveIdentityForms(name, pronouns));
}

/**
 * The caption a recipe draws: its split halves when it has both, otherwise
 * the whole fact as one block. `fact` and the halves are templates.
 */
export function memeCaption(
  fact: string,
  halves: { topText?: string; bottomText?: string } | null | undefined,
  name: string,
  pronouns: string | null | undefined,
): MemeCaption {
  const forms = resolveIdentityForms(name, pronouns);
  if (halves && halves.topText !== undefined && halves.bottomText !== undefined) {
    return { mode: "split", top: renderTemplateSegments(halves.topText, forms), bottom: renderTemplateSegments(halves.bottomText, forms) };
  }
  return { mode: "single", text: renderTemplateSegments(fact, forms) };
}

/** The caption's plain text, for logs and tests. */
export function captionText(segments: CaptionSegment[]): string {
  return segments.map((s) => s.text).join("");
}

type Token = { word: string; isName: boolean };

/** Draws a meme into `ctx`, in the logical canvas of `input.aspectRatio`. */
export function drawMeme<Img extends { width: number; height: number }>(
  ctx: MemeCanvasContext,
  input: DrawMemeInput<Img>,
): void {
  const dims = MEME_CANVAS_DIMS[input.aspectRatio];
  const deviceScale = input.deviceScale ?? 1;

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, dims.w, dims.h);

  if (input.image) {
    const p = coverPlacement(input.image.width, input.image.height, dims.w, dims.h, input.framingOffset);
    input.drawImage(input.image, p.x, p.y, p.w, p.h);
  }

  const style = input.style;
  const fontSize = captionFontSize(style, input.aspectRatio);
  const allCaps = style.allCaps !== false;
  const textColor = style.textColor ?? style.color ?? "#ffffff";
  const effect = style.textEffect ?? "outline";

  ctx.save();
  ctx.font = input.captionFont(fontSize);
  ctx.strokeStyle = style.outlineColor ?? "#000000";
  ctx.lineWidth = 6;

  if (effect === "shadow") {
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = Math.max(8, Math.round(fontSize * 0.18)) * deviceScale;
    ctx.shadowOffsetX = Math.max(3, Math.round(fontSize * 0.06)) * deviceScale;
    ctx.shadowOffsetY = Math.max(3, Math.round(fontSize * 0.06)) * deviceScale;
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  const tokensOf = (segments: CaptionSegment[]): Token[] => {
    const tokens: Token[] = [];
    for (const seg of segments) {
      const raw = allCaps ? seg.text.toUpperCase() : seg.text;
      for (const w of raw.split(/\s+/).filter(Boolean)) tokens.push({ word: w, isName: seg.isName });
    }
    return tokens;
  };

  const wrap = (tokens: Token[], maxWidth: number): Token[][] => {
    const lines: Token[][] = [];
    let current: Token[] = [];
    for (const token of tokens) {
      const candidate = [...current, token];
      if (ctx.measureText(candidate.map((t) => t.word).join(" ")).width > maxWidth && current.length > 0) {
        lines.push(current);
        current = [token];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) lines.push(current);
    return lines;
  };

  // Each block is centred horizontally, its vertical midpoint at yPct% of the height.
  const drawBlock = (segments: CaptionSegment[], yPct: number) => {
    const lines = wrap(tokensOf(segments), dims.w * 0.92);
    if (lines.length === 0) return;
    const lineH = fontSize * 1.1;
    const startY = (yPct / 100) * dims.h - (lines.length * lineH) / 2 + fontSize / 2;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    lines.forEach((line, li) => {
      const y = startY + li * lineH;
      let x = (dims.w - ctx.measureText(line.map((t) => t.word).join(" ")).width) / 2;
      line.forEach(({ word, isName }, ti) => {
        const text = ti < line.length - 1 ? word + " " : word;
        ctx.fillStyle = isName ? MEME_NAME_COLOR : textColor;
        if (effect === "outline") ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
        x += ctx.measureText(text).width;
      });
    });
  };

  const caption = input.caption;
  if (caption.mode === "split") {
    drawBlock(caption.top, style.topY ?? DEFAULT_CAPTION_TOP_Y);
    drawBlock(caption.bottom, style.bottomY ?? DEFAULT_CAPTION_BOTTOM_Y);
  } else {
    drawBlock(caption.text, 50);
  }
  ctx.restore();

  if (input.watermark === false) return;
  // The watermark, bottom right, the same on every meme.
  const unit = Math.min(dims.w, dims.h) / 450;
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = input.watermarkFont(Math.round(13 * unit));
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(MEME_WATERMARK_TEXT, dims.w - Math.round(18 * unit), dims.h - Math.round(14 * unit));
  ctx.restore();
}
