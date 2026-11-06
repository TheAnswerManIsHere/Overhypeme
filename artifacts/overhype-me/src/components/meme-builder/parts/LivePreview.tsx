import { useEffect, useRef, useState } from "react";
import {
  MEME_CANVAS_DIMS,
  WATERMARK_FONT_ID,
  captionFontById,
  captionFontStack,
  drawMeme,
  memeCaption,
} from "@workspace/api-zod";
import { useCaptionFont } from "@/lib/captionFontLoader";
import { captionFontOf } from "../captionFont";
import type { AspectRatio, MemeTextOptions } from "../types";

const watermarkFont = captionFontById(WATERMARK_FONT_ID);

interface Props {
  factText: string;
  name: string;
  pronouns: string;
  /** URL to the background image (`/api/storage/objects/...`). */
  backgroundUrl: string | null;
  textOptions: MemeTextOptions;
  aspectRatio: AspectRatio;
  /** Pan offset in canvas pixels. Positive x shifts image right, positive y down. */
  framingOffset?: { x: number; y: number };
  /** Optional ref to the canvas element — used by the wizard's drag-to-reposition gesture. */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /**
   * Optional CSS styles applied directly to the `<canvas>` element.
   * Use to constrain the display size without clipping the canvas:
   * e.g. `{ maxWidth: "100%", maxHeight: "300px", width: "auto", height: "auto" }`
   * The inline style overrides Tailwind's `w-full` so portrait canvases scale down
   * proportionally rather than being cropped by an `overflow-hidden` wrapper.
   */
  canvasStyle?: React.CSSProperties;
}

/**
 * Client-side canvas preview, drawn by `drawMeme` from `@workspace/api-zod`:
 * the same routine, in the same logical canvas, that draws the saved file on
 * the server (#870), so what this shows is what is saved — the crop, the
 * caption's lines and colours (the name in its own colour), and the
 * watermark.
 *
 * Performance:
 *   - The background image is loaded once per URL and cached in state so
 *     drag/slider updates don't trigger a new `Image()` per render.
 *   - Canvas redraws are coalesced through `requestAnimationFrame` so rapid
 *     prop changes (drag-to-reposition, slider scrubbing) paint at most one
 *     frame per tick.
 */
export function LivePreview({
  factText,
  name,
  pronouns,
  backgroundUrl,
  textOptions,
  aspectRatio,
  framingOffset,
  canvasRef: externalCanvasRef,
  canvasStyle,
}: Props) {
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const dims = MEME_CANVAS_DIMS[aspectRatio];
  // The caption is drawn only once its face has loaded, in that face at its
  // fixed weight, so the preview never shows a fallback font the saved meme
  // would not have (names-and-fonts plan).
  const fontId = captionFontOf(textOptions);
  const captionFont = captionFontById(fontId);
  const { status: fontStatus } = useCaptionFont(fontId);
  const { status: watermarkStatus } = useCaptionFont(WATERMARK_FONT_ID);

  // Cache the background image by URL so we don't recreate an `Image` on
  // every redraw (which would also re-fire `onload` and flicker).
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!backgroundUrl) {
      setBgImage(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setBgImage(img);
    };
    img.onerror = () => {
      if (!cancelled) setBgImage(null);
    };
    img.src = backgroundUrl;
    return () => {
      cancelled = true;
    };
  }, [backgroundUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rafId = requestAnimationFrame(() => {
      canvas.width = dims.w;
      canvas.height = dims.h;
      // The caption is drawn only once its face has loaded, and the watermark
      // only once its own has, each independently, so the preview never shows a
      // fallback face the saved meme would not have, and a slow or failed
      // watermark face never hides the caption (#872).
      const captionReady = fontStatus === "ready";
      const watermarkReady = watermarkStatus === "ready";
      const fontStyle = textOptions.italic ? "italic" : "normal";
      drawMeme(ctx, {
        image: bgImage,
        drawImage: (image, x, y, w, h) => ctx.drawImage(image, x, y, w, h),
        aspectRatio,
        framingOffset: framingOffset ? { x: framingOffset.x, y: framingOffset.y } : null,
        caption: captionReady
          ? memeCaption(factText, textOptions, name || "___", pronouns || "they/them")
          : { mode: "single", text: [] },
        style: textOptions,
        captionFont: (size) => `${fontStyle} ${captionFont.weight} ${size}px ${captionFontStack(captionFont)}`,
        watermarkFont: (size) => `${watermarkFont.weight} ${size}px ${captionFontStack(watermarkFont)}`,
        watermark: watermarkReady,
      });
    });
    return () => cancelAnimationFrame(rafId);
  }, [
    canvasRef,
    bgImage,
    factText,
    name,
    pronouns,
    textOptions,
    captionFont,
    fontStatus,
    watermarkStatus,
    aspectRatio,
    dims.w,
    dims.h,
    framingOffset?.x,
    framingOffset?.y,
  ]);

  return (
    <div className="flex justify-center overflow-hidden rounded-md border border-border bg-black">
      <canvas
        ref={canvasRef}
        className="block h-auto w-full"
        style={canvasStyle}
        aria-label="Meme preview"
        data-caption-font={captionFont.family}
        data-caption-font-status={fontStatus}
      />
    </div>
  );
}
