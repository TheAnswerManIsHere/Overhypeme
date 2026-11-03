/**
 * The caption fonts (names-and-fonts plan, David 2026-11-03): one list the
 * picker, the browser preview, request validation and the server renderer all
 * read, so a meme saved in a face is drawn in exactly the face its preview
 * showed. Each face is shipped twice from the same file: in the server's
 * `assets/fonts/` (registered with the canvas) and in the web app's
 * `public/fonts/caption/` (loaded with `@font-face`), both under the
 * internal family below.
 *
 * The internal families are new names on purpose: no caption font string a
 * stored recipe already holds (`Impact`, `'Bebas Neue', Impact, sans-serif`)
 * can name one, so stored recipes keep drawing exactly as before.
 *
 * Every face draws every letter the name rule admits, in both cases; the rule's
 * letters are derived from these files (`artifacts/api-server/scripts/derive-name-letters.ts`).
 *
 * @purpose The shared list of caption fonts — id, label, internal family, file and fixed weight — read by the meme builder's pickers and preview, the render request schema and the server renderer.
 * @subsystem meme-studio
 */

export interface CaptionFont {
  /** Stable id carried in `textOptions.fontFamily` for new memes. */
  readonly id: string;
  /** What the picker shows. */
  readonly label: string;
  /** The typeface it is cut from: the internal family names don't say. */
  readonly typeface: string;
  /** The family both the canvas and `@font-face` register it under. */
  readonly family: string;
  /** The file, the same name in both asset directories. */
  readonly file: string;
  /** The one weight it is drawn at, in the browser and on the server. */
  readonly weight: number;
}

export const CAPTION_FONTS = [
  { id: "block", label: "Block", typeface: "Anton", family: "OH Block", file: "Anton-Regular.ttf", weight: 400 },
  { id: "sans", label: "Clean sans", typeface: "Montserrat", family: "OH Sans", file: "OHSans-ExtraBold.ttf", weight: 800 },
  { id: "serif", label: "Elegant serif", typeface: "Playfair Display", family: "OH Serif", file: "OHSerif-Bold.ttf", weight: 700 },
  { id: "slab", label: "Slab poster", typeface: "Alfa Slab One", family: "OH Slab", file: "AlfaSlabOne-Regular.ttf", weight: 400 },
  { id: "comic", label: "Comic shout", typeface: "Bangers", family: "OH Comic", file: "Bangers-Regular.ttf", weight: 400 },
  { id: "stencil", label: "Stencil", typeface: "Black Ops One", family: "OH Stencil", file: "BlackOpsOne-Regular.ttf", weight: 400 },
  { id: "rounded", label: "Rounded", typeface: "Baloo 2", family: "OH Rounded", file: "OHRounded-Bold.ttf", weight: 700 },
  { id: "hand", label: "Handwritten", typeface: "Patrick Hand", family: "OH Hand", file: "PatrickHand-Regular.ttf", weight: 400 },
  { id: "sketch", label: "Sketched capitals", typeface: "Amatic SC", family: "OH Sketch", file: "AmaticSC-Bold.ttf", weight: 700 },
  { id: "script", label: "Script", typeface: "Lobster", family: "OH Script", file: "Lobster-Regular.ttf", weight: 400 },
  { id: "terminal", label: "Retro terminal", typeface: "VT323", family: "OH Terminal", file: "VT323-Regular.ttf", weight: 400 },
] as const satisfies readonly CaptionFont[];

export type CaptionFontId = (typeof CAPTION_FONTS)[number]["id"];

export const CAPTION_FONT_IDS = CAPTION_FONTS.map((f) => f.id) as [CaptionFontId, ...CaptionFontId[]];

/** New memes start in Anton, the face every meme has used so far. */
export const DEFAULT_CAPTION_FONT_ID: CaptionFontId = "block";

export function isCaptionFontId(value: unknown): value is CaptionFontId {
  return typeof value === "string" && (CAPTION_FONT_IDS as readonly string[]).includes(value);
}

export function captionFontById(id: CaptionFontId): CaptionFont {
  return CAPTION_FONTS.find((f) => f.id === id)!;
}

/** The CSS / canvas `font` family list for a face. */
export function captionFontStack(font: CaptionFont): string {
  return `"${font.family}", sans-serif`;
}

/**
 * The font stacks the builder's old picker stored, mapped to the nearest
 * catalogue face, so a wizard draft restored from before this change keeps a
 * sensible choice and saves (plan: restored drafts are moved to ids).
 */
const LEGACY_PICKER_FONTS: Readonly<Record<string, CaptionFontId>> = {
  "'Bebas Neue', Impact, sans-serif": "block",
  "'Anton', Impact, sans-serif": "block",
  "'DM Sans', system-ui, sans-serif": "sans",
  "'JetBrains Mono', monospace": "terminal",
  "Impact, sans-serif": "block",
};

/** A stored picker value as a catalogue id: an id as is, an old stack mapped, anything else the default. */
export function captionFontIdFromStored(value: unknown): CaptionFontId {
  if (isCaptionFontId(value)) return value;
  if (typeof value === "string" && value in LEGACY_PICKER_FONTS) return LEGACY_PICKER_FONTS[value]!;
  return DEFAULT_CAPTION_FONT_ID;
}
