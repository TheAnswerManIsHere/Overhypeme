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

/** One caption block as it is drawn: its lines and where they sit, in logical canvas units. */
export interface CaptionBlockLayout {
  role: "top" | "bottom" | "single";
  lines: CaptionWord[][];
  /** The alphabetic baseline of the first line; each later line is one `lineHeight` lower. */
  firstBaseline: number;
  /** The top and bottom of the block's ink, outline included. */
  inkTop: number;
  inkBottom: number;
  /** The block's vertical midpoint as drawn, as a percentage of the height: what a position slider shows. */
  yPct: number;
  /**
   * The positions (same unit as `yPct`) the block can take with the other
   * block where it is: from touching the top margin, or the block above, to
   * touching the bottom margin, or the block below. A position inside the
   * range is drawn exactly there.
   */
  minPct: number;
  maxPct: number;
}

/** Where a meme's caption is drawn (`captionLayout`). */
export interface CaptionLayout {
  /** The size the caption is drawn at: the recipe's, or smaller when the caption would not fit the picture at it. */
  fontSize: number;
  lineHeight: number;
  blocks: CaptionBlockLayout[];
}

/**
 * Where a caption is drawn: the one place its geometry is decided, used by
 * `drawMeme` (so by the preview and the saved file) and by the builder's
 * position sliders, which take their limits from it. Three rules always hold
 * (#1254, #1260): no line crosses the top edge, none crosses the bottom edge,
 * and the top and bottom blocks never overlap.
 *
 * Each block's midpoint sits at its position (`topY` / `bottomY`, 50% for a
 * single block) whenever the rules allow, exactly as before they existed.
 * Otherwise: a block that would cross an edge slides in to the margin; two
 * blocks that would overlap move apart equally, as far as the edges allow;
 * and a caption too tall for the picture at its font size (both blocks and
 * the gap between them) is drawn smaller, both blocks alike, until it fits.
 *
 * `measure` gives the width of a string at a font size, in the caption's face.
 */
export function captionLayout(
  measure: (text: string, fontSize: number) => number,
  input: { aspectRatio: MemeCanvasAspectRatio; caption: MemeCaption; style: MemeCaptionStyle },
): CaptionLayout {
  const dims = MEME_CANVAS_DIMS[input.aspectRatio];
  const { caption, style } = input;
  const allCaps = style.allCaps !== false;
  const wanted: { role: CaptionBlockLayout["role"]; words: CaptionWord[]; yPct: number }[] = (
    caption.mode === "split"
      ? [
          { role: "top" as const, words: captionWords(caption.top, allCaps), yPct: style.topY ?? DEFAULT_CAPTION_TOP_Y },
          { role: "bottom" as const, words: captionWords(caption.bottom, allCaps), yPct: style.bottomY ?? DEFAULT_CAPTION_BOTTOM_Y },
        ]
      : [{ role: "single" as const, words: captionWords(caption.text, allCaps), yPct: 50 }]
  ).filter((b) => b.words.length > 0);

  const wrap = (words: CaptionWord[], size: number): CaptionWord[][] => {
    const maxWidth = dims.w * 0.92;
    const lines: CaptionWord[][] = [];
    let current: CaptionWord[] = [];
    for (const word of words) {
      const candidate = [...current, word];
      if (measure(candidate.map((w) => w.text).join(" "), size) > maxWidth && current.length > 0) {
        lines.push(current);
        current = [word];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) lines.push(current);
    return lines;
  };

  const margin = Math.round(Math.min(dims.w, dims.h) * CAPTION_EDGE_MARGIN);
  const room = dims.h - 2 * margin;
  // The ink a block of n lines spans, top of the first line's capitals to the foot of the last line's descenders.
  const inkHeight = (n: number, s: number) => (n - 1) * s * CAPTION_LINE_EM + s * (GLYPH_ASCENT_EM + GLYPH_DESCENT_EM) + 2 * CAPTION_INK_PAD;
  const gapAt = (s: number) => Math.round(s * CAPTION_BLOCK_GAP_EM);

  let size = captionFontSize(style, input.aspectRatio);
  let wrapped = wanted.map((b) => wrap(b.words, size));
  const total = () => wrapped.reduce((sum, lines) => sum + inkHeight(lines.length, size), 0) + gapAt(size) * (wrapped.length - 1);
  while (wanted.length > 0 && total() > room && size > MIN_CAPTION_FONT_SIZE) {
    size = Math.max(MIN_CAPTION_FONT_SIZE, Math.floor(size * 0.95));
    wrapped = wanted.map((b) => wrap(b.words, size));
  }
  const lineHeight = size * CAPTION_LINE_EM;
  const gap = gapAt(size);

  // Everything below works on block midpoints (y), so a block nothing moves keeps its position exactly.
  const h = wrapped.map((lines) => inkHeight(lines.length, size));
  // From a block's midpoint to the top of its ink: the first line's centre is half a block up and half a
  // font size down, its baseline CAPTION_BASELINE_EM below that, the ink GLYPH_ASCENT_EM above the baseline.
  const k = wrapped.map((lines) => -(lines.length * lineHeight) / 2 + size / 2 + size * (CAPTION_BASELINE_EM - GLYPH_ASCENT_EM) - CAPTION_INK_PAD);
  const y = wanted.map((b) => (b.yPct / 100) * dims.h);
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  const top = margin;
  const bottom = dims.h - margin;

  if (wanted.length === 1) {
    // Centred when even the smallest size is too tall (unreachable for a caption the save validator accepts).
    if (h[0]! > room) y[0] = (dims.h - h[0]!) / 2 - k[0]!;
    else y[0] = clamp(y[0]!, top - k[0]!, bottom - h[0]! - k[0]!);
  } else if (wanted.length === 2) {
    if (h[0]! + gap + h[1]! > room) {
      // Stacked and centred when even the smallest size is too tall (unreachable, as above).
      const start = (dims.h - (h[0]! + gap + h[1]!)) / 2;
      y[0] = start - k[0]!;
      y[1] = start + h[0]! + gap - k[1]!;
    } else {
      // Each block inside the picture, leaving room for the other...
      y[0] = clamp(y[0]!, top - k[0]!, bottom - h[1]! - gap - h[0]! - k[0]!);
      y[1] = clamp(y[1]!, top + h[0]! + gap - k[1]!, bottom - h[1]! - k[1]!);
      // ...then apart, equally, when they would overlap, and back inside if that pushed one out.
      const overlap = y[0]! + k[0]! + h[0]! + gap - (y[1]! + k[1]!);
      if (overlap > 0) {
        y[0] = y[0]! - overlap / 2;
        y[1] = y[1]! + overlap / 2;
        const over = Math.max(0, top - (y[0]! + k[0]!)) - Math.max(0, y[1]! + k[1]! + h[1]! - bottom);
        y[0] = y[0]! + over;
        y[1] = y[1]! + over;
      }
    }
  }

  const pct = (ink: number, i: number) => ((ink - k[i]!) / dims.h) * 100;
  const blocks = wanted.map((b, i): CaptionBlockLayout => {
    const inkTop = y[i]! + k[i]!;
    const above = i === 1 ? y[0]! + k[0]! + h[0]! + gap : top;
    const below = i === 0 && wanted.length === 2 ? y[1]! + k[1]! - gap : bottom;
    return {
      role: b.role,
      lines: wrapped[i]!,
      firstBaseline: y[i]! - (wrapped[i]!.length * lineHeight) / 2 + size / 2 + size * CAPTION_BASELINE_EM,
      inkTop,
      inkBottom: inkTop + h[i]!,
      yPct: (y[i]! / dims.h) * 100,
      minPct: pct(above, i),
      maxPct: pct(below - h[i]!, i),
    };
  });
  return { fontSize: size, lineHeight, blocks };
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
  const textColor = style.textColor ?? style.color ?? "#ffffff";
  const effect = style.textEffect ?? "outline";

  ctx.save();
  let fontAt = NaN;
  const measure = (text: string, size: number) => {
    if (size !== fontAt) {
      ctx.font = input.captionFont(size);
      fontAt = size;
    }
    return ctx.measureText(text).width;
  };
  const layout = captionLayout(measure, { aspectRatio: input.aspectRatio, caption: input.caption, style });
  const fontSize = layout.fontSize;
  ctx.font = input.captionFont(fontSize);
  ctx.strokeStyle = style.outlineColor ?? "#000000";
  ctx.lineWidth = 2 * CAPTION_INK_PAD;
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

  // Where the caption's ink sits, line by line, so the watermark can keep clear of it.
  const captionBoxes: Box[] = [];
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  // Each block is centred horizontally; `captionLayout` decides where it sits vertically.
  for (const block of layout.blocks) {
    block.lines.forEach((line, li) => {
      const y = block.firstBaseline + li * layout.lineHeight;
      const lineWidth = ctx.measureText(line.map((w) => w.text).join(" ")).width;
      let x = (dims.w - lineWidth) / 2;
      captionBoxes.push({
        x0: x - CAPTION_INK_PAD, x1: x + lineWidth + CAPTION_INK_PAD,
        y0: y - fontSize * GLYPH_ASCENT_EM - CAPTION_INK_PAD, y1: y + fontSize * GLYPH_DESCENT_EM + CAPTION_INK_PAD,
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

/** The clear band a caption keeps from the top and bottom edges, as a fraction of the canvas's shorter side. */
const CAPTION_EDGE_MARGIN = 0.03;
/** The clear band between the top and bottom blocks, as a fraction of the font size. */
const CAPTION_BLOCK_GAP_EM = 0.25;
/** From one line's baseline to the next, as a fraction of the font size. */
const CAPTION_LINE_EM = 1.1;
/** How far the outline reaches past a glyph: half the outline's width. */
const CAPTION_INK_PAD = 3;
/**
 * The smallest a caption is drawn when shrinking it to fit the picture: the
 * save validator's own font-size minimum. Two 500-character halves, the
 * longest the validator accepts, fit every ratio well above it.
 */
const MIN_CAPTION_FONT_SIZE = 14;

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
