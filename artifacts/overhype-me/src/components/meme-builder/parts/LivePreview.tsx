import { useEffect, useRef } from "react";
import { renderFactSegments } from "@/lib/render-fact";
import type { AspectRatio, MemeTextOptions } from "../types";

const NAME_COLOR = "#ff6b35";

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
  /**
   * Optional CSS styles applied directly to the `<canvas>` element.
   * Use to constrain the display size without clipping the canvas:
   * e.g. `{ maxWidth: "100%", maxHeight: "300px", width: "auto", height: "auto" }`
   * The inline style overrides Tailwind's `w-full` so portrait canvases scale down
   * proportionally rather than being cropped by an `overflow-hidden` wrapper.
   */
  canvasStyle?: React.CSSProperties;
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
 * Text rendering rules:
 *   - When `textOptions.topText` and `textOptions.bottomText` are set (Step 2
 *     split-slider mode), each half is drawn at its respective `topY`/`bottomY`
 *     percentage along the canvas height.
 *   - Otherwise (legacy / single-block mode) the full `factText` is centred.
 *   - In both modes the name token (`{NAME}`) is always drawn in brand orange
 *     (`#ff6b35`); every other token uses `textOptions.textColor`.
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
      ctx.save();

      const fontFamily = textOptions.fontFamily ?? "Impact, system-ui, sans-serif";
      const fontSize = textOptions.fontSize ?? Math.floor(dims.h * 0.07);
      const weight = textOptions.bold ? "bold" : "normal";
      const fontStyle = textOptions.italic ? "italic" : "normal";
      ctx.font = `${fontStyle} ${weight} ${fontSize}px ${fontFamily}`;
      ctx.strokeStyle = textOptions.outlineColor ?? "#000000";
      ctx.lineWidth = 6;

      const allCaps = textOptions.allCaps !== false;
      const effectiveTextColor = textOptions.textColor ?? "#ffffff";

      type Token = { word: string; isName: boolean };

      // Build a flat list of word-tokens from a template block, applying allCaps
      // and preserving the `isName` flag from `renderFactSegments`.
      const buildTokens = (blockText: string): Token[] => {
        const segments = renderFactSegments(
          blockText,
          name || "___",
          pronouns || "they/them",
        );
        const tokens: Token[] = [];
        for (const seg of segments) {
          const raw = allCaps ? seg.text.toUpperCase() : seg.text;
          for (const w of raw.split(/\s+/).filter(Boolean)) {
            tokens.push({ word: w, isName: seg.isName });
          }
        }
        return tokens;
      };

      // Word-wrap a flat token list into lines, keeping words on the same line
      // as long as the combined text fits within `maxWidth`.
      const wrapTokens = (tokens: Token[], maxWidth: number): Token[][] => {
        const lines: Token[][] = [];
        let current: Token[] = [];
        for (const token of tokens) {
          const candidate = [...current, token];
          const candidateText = candidate.map((t) => t.word).join(" ");
          if (ctx.measureText(candidateText).width > maxWidth && current.length > 0) {
            lines.push(current);
            current = [token];
          } else {
            current = candidate;
          }
        }
        if (current.length > 0) lines.push(current);
        return lines;
      };

      // Draw a block of wrapped lines, centred horizontally and anchored so the
      // block's vertical midpoint sits at `yPct`% of the canvas height.
      // The name segments are drawn in NAME_COLOR; everything else in effectiveTextColor.
      const drawBlock = (blockText: string, yPct: number) => {
        if (!blockText.trim()) return;
        const tokens = buildTokens(blockText);
        const lines = wrapTokens(tokens, dims.w * 0.92);
        if (lines.length === 0) return;

        const totalH = lines.length * fontSize * 1.1;
        const startY = (yPct / 100) * dims.h - totalH / 2 + fontSize / 2;

        ctx.textBaseline = "middle";
        ctx.textAlign = "left";

        for (let li = 0; li < lines.length; li++) {
          const line = lines[li]!;
          const y = startY + li * fontSize * 1.1;

          // Centre the line by computing total pixel width first.
          const lineText = line.map((t) => t.word).join(" ");
          const totalW = ctx.measureText(lineText).width;
          let x = (dims.w - totalW) / 2;

          for (let ti = 0; ti < line.length; ti++) {
            const { word, isName } = line[ti]!;
            const wordWithSpace = ti < line.length - 1 ? word + " " : word;
            ctx.fillStyle = isName ? NAME_COLOR : effectiveTextColor;
            if (textOptions.textEffect !== "none") ctx.strokeText(wordWithSpace, x, y);
            ctx.fillText(wordWithSpace, x, y);
            x += ctx.measureText(wordWithSpace).width;
          }
        }
      };

      if (
        textOptions.topText !== undefined &&
        textOptions.bottomText !== undefined
      ) {
        // Split mode — each half at its own vertical position.
        if (textOptions.topText) drawBlock(textOptions.topText, textOptions.topY ?? 17);
        if (textOptions.bottomText) drawBlock(textOptions.bottomText, textOptions.bottomY ?? 88);
      } else {
        // Legacy / single-block mode — full fact text centred.
        drawBlock(factText, 50);
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
  }, [
    factText,
    name,
    pronouns,
    backgroundUrl,
    textOptions,
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
      />
    </div>
  );
}
