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
import { BRAND_ORANGE } from "./brandTokens";
import { DEFAULT_CAPTION_FONT_ID } from "./captionFonts";
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
export const MEME_NAME_COLOR = BRAND_ORANGE;

/**
 * The face the watermark is drawn in: the default caption face (David,
 * 2026-11-06), a catalogue face, so the browser and the server draw the same
 * glyphs (a bare `sans-serif` resolves differently in each).
 */
export const WATERMARK_FONT_ID = DEFAULT_CAPTION_FONT_ID;

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
  lineJoin: string;
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

/**
 * Where a caption line's alphabetic baseline sits below the line's vertical
 * centre, as a fraction of the font size. Text is placed on the alphabetic
 * baseline because browsers and the server's canvas disagree about where
 * `textBaseline = "middle"` is (measured 2026-11-04: Chromium drew it 7–8 px
 * higher at 50 px than @napi-rs/canvas, while alphabetic text agreed), and font
 * metrics are no help: Chromium rounds them to whole pixels. A fixed fraction
 * is the same arithmetic on both. 0.42 centres Anton's capitals on the line.
 */
export const CAPTION_BASELINE_EM = 0.42;

/** One piece of a word, in one colour. */
export type CaptionPiece = { text: string; isName: boolean };
/** A word: what wrapping and spacing work on. Its pieces join with no space between them. */
export type CaptionWord = { text: string; pieces: CaptionPiece[] };

/**
 * The caption's words, split at whitespace only. A run boundary inside a word
 * (the name followed by a full stop, a comma, a possessive) keeps the pieces
 * together, so "David." is one word with the name piece coloured (#872).
 */
export function captionWords(segments: CaptionSegment[], allCaps: boolean): CaptionWord[] {
  const words: CaptionWord[] = [];
  let current: CaptionWord | null = null;
  for (const seg of segments) {
    const text = allCaps ? seg.text.toUpperCase() : seg.text;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        current = null;
        continue;
      }
      if (!current) {
        current = { text: "", pieces: [] };
        words.push(current);
      }
      current.text += part;
      const last = current.pieces[current.pieces.length - 1];
      if (last && last.isName === seg.isName) last.text += part;
      else current.pieces.push({ text: part, isName: seg.isName });
    }
  }
  return words;
}

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
  // Round joins: the default mitre join shoots spikes past the outline at the
  // sharp corners of condensed faces (seen under Anton's V, 2026-11-06).
  ctx.lineJoin = "round";

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

  const wrap = (words: CaptionWord[], maxWidth: number): CaptionWord[][] => {
    const lines: CaptionWord[][] = [];
    let current: CaptionWord[] = [];
    for (const word of words) {
      const candidate = [...current, word];
      if (ctx.measureText(candidate.map((w) => w.text).join(" ")).width > maxWidth && current.length > 0) {
        lines.push(current);
        current = [word];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) lines.push(current);
    return lines;
  };

  // Where the caption's ink sits, line by line, so the watermark can keep clear of it.
  const captionBoxes: Box[] = [];
  const inkPad = 3; // half the outline width

  // Each block is centred horizontally, its vertical midpoint at yPct% of the height.
  const drawBlock = (segments: CaptionSegment[], yPct: number) => {
    const lines = wrap(captionWords(segments, allCaps), dims.w * 0.92);
    if (lines.length === 0) return;
    const lineH = fontSize * 1.1;
    const firstCentre = (yPct / 100) * dims.h - (lines.length * lineH) / 2 + fontSize / 2;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    lines.forEach((line, li) => {
      const y = firstCentre + li * lineH + fontSize * CAPTION_BASELINE_EM;
      const lineWidth = ctx.measureText(line.map((w) => w.text).join(" ")).width;
      let x = (dims.w - lineWidth) / 2;
      captionBoxes.push({
        x0: x - inkPad, x1: x + lineWidth + inkPad,
        y0: y - fontSize * GLYPH_ASCENT_EM - inkPad, y1: y + fontSize * GLYPH_DESCENT_EM + inkPad,
      });
      line.forEach((word, wi) => {
        word.pieces.forEach((piece, pi) => {
          const lastOfWord = pi === word.pieces.length - 1;
          const text = lastOfWord && wi < line.length - 1 ? piece.text + " " : piece.text;
          ctx.fillStyle = piece.isName ? MEME_NAME_COLOR : textColor;
          if (effect === "outline") ctx.strokeText(text, x, y);
          ctx.fillText(text, x, y);
          x += ctx.measureText(text).width;
        });
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
  // The watermark: small, in the default caption face, bottom right unless the
  // caption covers that spot, in which case it moves to the nearest clear one
  // (watermarkPlacement). Its job is to tell anyone who sees the meme posted
  // elsewhere where it came from, so it is drawn to be read: light fill, a
  // thin dark outline.
  const unit = Math.min(dims.w, dims.h) / 450;
  const size = Math.round(13 * unit);
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = input.watermarkFont(size);
  const spot = watermarkPlacement({
    canvas: dims,
    textWidth: ctx.measureText(MEME_WATERMARK_TEXT).width,
    fontSize: size,
    margin: Math.round(14 * unit),
    avoid: captionBoxes,
  });
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, Math.round(size / 8));
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeText(MEME_WATERMARK_TEXT, spot.x, spot.baseline);
  ctx.fillText(MEME_WATERMARK_TEXT, spot.x, spot.baseline);
  ctx.restore();
}

/** A rectangle in logical canvas units. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** How far a line of text reaches above and below its alphabetic baseline, as fractions of the font size (fixed, so both canvases agree). */
const GLYPH_ASCENT_EM = 0.85;
const GLYPH_DESCENT_EM = 0.25;

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Where the watermark goes: the bottom-right corner when the caption leaves it
 * clear, otherwise the clear spot nearest it — up the right edge and the left
 * edge, one watermark height at a time, right before left at each height.
 * When nothing on either edge is clear, the bottom-right corner.
 */
export function watermarkPlacement(args: {
  canvas: { w: number; h: number };
  textWidth: number;
  fontSize: number;
  margin: number;
  avoid: Box[];
}): { x: number; baseline: number; box: Box } {
  const { canvas, textWidth, fontSize, margin, avoid } = args;
  const gap = Math.round(fontSize / 3);
  const boxAt = (x: number, baseline: number): Box => ({
    x0: x - gap, x1: x + textWidth + gap,
    y0: baseline - fontSize * GLYPH_ASCENT_EM - gap, y1: baseline + fontSize * GLYPH_DESCENT_EM + gap,
  });
  const rightX = canvas.w - margin - textWidth;
  const leftX = margin;
  const bottom = canvas.h - margin;
  const step = Math.ceil(fontSize * (GLYPH_ASCENT_EM + GLYPH_DESCENT_EM)) + gap;
  const top = margin + fontSize * GLYPH_ASCENT_EM;
  for (let baseline = bottom; baseline >= top; baseline -= step) {
    for (const x of [rightX, leftX]) {
      const box = boxAt(x, baseline);
      if (!avoid.some((b) => overlaps(b, box))) return { x, baseline, box };
    }
  }
  return { x: rightX, baseline: bottom, box: boxAt(rightX, bottom) };
}
