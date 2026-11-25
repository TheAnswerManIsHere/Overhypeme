/**
 * Where the builder's caption is drawn, for the controls that have to agree
 * with the preview (#1260): the position sliders take their limits and their
 * percentages from this, which is `captionLayout` — the same function
 * `drawMeme` draws the preview and the saved meme with — measured in the same
 * face. Until then the sliders worked their limits out from a guess (a line
 * count of split/8, a 64 px font, a 720 px canvas), so they stopped where the
 * text was not.
 *
 * @purpose Computes the caption layout the builder's preview is drawing (font size as drawn, each block's position and the range it can move in), measured on an offscreen canvas in the loaded caption face, for the position sliders.
 * @subsystem meme-studio
 */
import { useMemo } from "react";
import {
  captionFontById,
  captionFontStack,
  captionLayout,
  memeCaption,
  type CaptionBlockLayout,
  type CaptionLayout,
} from "@workspace/api-zod";
import { useCaptionFont } from "@/lib/captionFontLoader";
import { captionFontOf } from "./captionFont";
import type { AspectRatio, MemeTextOptions } from "./types";

/** The canvas `font` the builder draws its caption in, at a size: one spelling for the preview and for measuring. */
export function builderCaptionFont(textOptions: MemeTextOptions): (size: number) => string {
  const font = captionFontById(captionFontOf(textOptions));
  const fontStyle = textOptions.italic ? "italic" : "normal";
  return (size) => `${fontStyle} ${font.weight} ${size}px ${captionFontStack(font)}`;
}

let measuringContext: CanvasRenderingContext2D | null | undefined;
function measuring(): CanvasRenderingContext2D | null {
  if (measuringContext === undefined) {
    measuringContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  return measuringContext;
}

interface Args {
  factText: string;
  name: string;
  pronouns: string;
  /** The options the preview draws with: the split halves included. */
  textOptions: MemeTextOptions;
  aspectRatio: AspectRatio;
}

/**
 * The layout the preview is drawing, or null until the caption face has
 * loaded (the preview draws no caption until then either) or where there is
 * no canvas to measure with.
 */
export function useCaptionLayout({ factText, name, pronouns, textOptions, aspectRatio }: Args): CaptionLayout | null {
  const { status } = useCaptionFont(captionFontOf(textOptions));
  return useMemo(() => {
    if (status !== "ready") return null;
    const ctx = measuring();
    if (!ctx) return null;
    const font = builderCaptionFont(textOptions);
    return captionLayout(
      (text, size) => {
        ctx.font = font(size);
        return ctx.measureText(text).width;
      },
      {
        aspectRatio,
        // The same caption the preview draws (LivePreview).
        caption: memeCaption(factText, textOptions, name || "___", pronouns || "they/them"),
        style: textOptions,
      },
    );
  }, [status, factText, name, pronouns, textOptions, aspectRatio]);
}

/**
 * A position slider's whole-number range and value for a block: every
 * position in the range is drawn exactly there, the ends are where the block
 * meets the picture's edge or the other block, and the value is where the
 * block is drawn now. Null when the block is not drawn.
 */
export function sliderRange(block: CaptionBlockLayout | undefined): { min: number; max: number; value: number } | null {
  if (!block) return null;
  const min = Math.ceil(block.minPct - 1e-9);
  const max = Math.floor(block.maxPct + 1e-9);
  // No whole-number position fits: the block has nowhere to move, and the slider shows where it is.
  if (min > max) {
    const at = Math.round(block.yPct);
    return { min: at, max: at, value: at };
  }
  return { min, max, value: Math.min(max, Math.max(min, Math.round(block.yPct))) };
}
