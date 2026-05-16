import { useEffect, useRef } from "react";
import { renderFact } from "@/lib/render-fact";
import type { AspectRatio, MemeTextOptions } from "../types";

interface Props {
  factText: string;
  name: string;
  pronouns: string;
  /** URL to the background image (stock photo URL or `/api/storage/objects/...`). */
  backgroundUrl: string | null;
  textOptions: MemeTextOptions;
  aspectRatio: AspectRatio;
  /** Pan offset in canvas pixels. Positive x shifts image right, positive y down. */
  framingOffset?: { x: number; y: number };
  /** Optional ref to the canvas element — used by the wizard's drag-to-reposition gesture. */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}

const ASPECT_DIMS: Record<AspectRatio, { w: number; h: number }> = {
  landscape: { w: 1280, h: 720 },
  square:    { w: 1080, h: 1080 },
  portrait:  { w: 720,  h: 1280 },
};

/**
 * Client-side canvas preview. Renders the background image (object-cover)
 * with the token-substituted fact text overlaid.
 *
 * The Phase-4 `/api/render-preview` endpoint will eventually be the source of
 * truth for pixel-perfect previews; until then this canvas covers the live
 * re-render path. Keeping the renderer client-side here is intentional — it
 * avoids hammering the server while the user scrubs through stock thumbnails.
 */
export function LivePreview({ factText, name, pronouns, backgroundUrl, textOptions, aspectRatio, framingOffset, canvasRef: externalCanvasRef }: Props) {
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const dims = ASPECT_DIMS[aspectRatio];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = dims.w;
    canvas.height = dims.h;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, dims.w, dims.h);

    const drawText = () => {
      const text = renderFact(factText, name || "___", pronouns || "they/them");
      ctx.save();
      ctx.fillStyle = textOptions.textColor ?? "#ffffff";
      ctx.strokeStyle = textOptions.outlineColor ?? "#000000";
      ctx.lineWidth = 6;
      const fontFamily = textOptions.fontFamily ?? "Impact, system-ui, sans-serif";
      const fontSize = textOptions.fontSize ?? Math.floor(dims.h * 0.07);
      const weight = textOptions.bold ? "bold" : "normal";
      const style = textOptions.italic ? "italic" : "normal";
      ctx.font = `${style} ${weight} ${fontSize}px ${fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const display = textOptions.allCaps !== false ? text.toUpperCase() : text;
      const lines = wrap(ctx, display, dims.w * 0.92);
      const totalH = lines.length * fontSize * 1.1;
      let y = (dims.h - totalH) / 2 + fontSize / 2;
      for (const line of lines) {
        if (textOptions.textEffect !== "none") ctx.strokeText(line, dims.w / 2, y);
        ctx.fillText(line, dims.w / 2, y);
        y += fontSize * 1.1;
      }
      ctx.restore();
    };

    if (!backgroundUrl) {
      drawText();
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const ratio = Math.max(dims.w / img.width, dims.h / img.height);
      const w = img.width * ratio;
      const h = img.height * ratio;
      // Clamp pan so the image never reveals empty canvas.
      const maxOffsetX = Math.max(0, (w - dims.w) / 2);
      const maxOffsetY = Math.max(0, (h - dims.h) / 2);
      const ox = framingOffset
        ? Math.min(maxOffsetX, Math.max(-maxOffsetX, framingOffset.x))
        : 0;
      const oy = framingOffset
        ? Math.min(maxOffsetY, Math.max(-maxOffsetY, framingOffset.y))
        : 0;
      ctx.drawImage(img, (dims.w - w) / 2 + ox, (dims.h - h) / 2 + oy, w, h);
      drawText();
    };
    img.onerror = () => drawText();
    img.src = backgroundUrl;
  }, [factText, name, pronouns, backgroundUrl, textOptions, dims.w, dims.h, framingOffset?.x, framingOffset?.y]);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-black">
      <canvas
        ref={canvasRef}
        className="h-auto w-full"
        aria-label="Meme preview"
      />
    </div>
  );
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
