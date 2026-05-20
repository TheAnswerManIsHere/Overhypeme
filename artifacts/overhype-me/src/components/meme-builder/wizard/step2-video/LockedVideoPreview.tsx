/**
 * Top preview for Step 2 (video). Renders the chosen source still inside the
 * selected aspect-ratio frame, plus a one-line settings summary.
 *
 * Matches the image builder's LockedPreview contract:
 *   - Sits OUTSIDE the scrollable controls container (parent handles layout).
 *   - Drag-to-resize handle below the frame so the user can shrink the preview
 *     when the controls need more room. Height persists to localStorage under
 *     `mbfo_video_preview_max_h` (clamped 100–1200px). Double-tap/click resets.
 */

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { AspectRatio } from "../../types";
import { ImageIcon } from "lucide-react";

interface Props {
  sourceUrl: string | null;
  aspectRatio: AspectRatio;
  summary: {
    styleLabel?: string;
    motionLabel?: string;
    lengthSec?: number;
    resolution?: string;
  };
}

const CANVAS_HEIGHT_KEY = "mbfo_video_preview_max_h";
const DEFAULT_MAX_VH = 38;
const MIN_PX = 100;
const MAX_PX = 1200;
const MAX_SAVED_VIEWPORT_FRACTION = 0.52;

const ASPECT_CLASS: Record<AspectRatio, string> = {
  landscape: "aspect-[16/9]",
  square: "aspect-square",
  portrait: "aspect-[9/16]",
};

function readSavedMaxH(): number | null {
  if (typeof window === "undefined") return null;
  const saved = window.localStorage.getItem(CANVAS_HEIGHT_KEY);
  const parsed = saved ? parseInt(saved, 10) : NaN;
  if (!Number.isFinite(parsed)) return null;
  const viewportCap = Math.floor(window.innerHeight * MAX_SAVED_VIEWPORT_FRACTION);
  return Math.max(MIN_PX, Math.min(MAX_PX, parsed, viewportCap));
}

export function LockedVideoPreview({ sourceUrl, aspectRatio, summary }: Props) {
  const summaryLine = formatSummary(summary);

  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number | null>(() => readSavedMaxH());
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const lastTapRef = useRef(0);

  const applyMaxH = useCallback((h: number) => {
    const viewportCap = Math.floor(window.innerHeight * MAX_SAVED_VIEWPORT_FRACTION);
    const clamped = Math.max(MIN_PX, Math.min(MAX_PX, h, viewportCap));
    setMaxH(clamped);
    try {
      window.localStorage.setItem(CANVAS_HEIGHT_KEY, String(clamped));
    } catch {
      /* localStorage may be disabled — non-fatal */
    }
  }, []);

  const handleResizeDoubleTap = useCallback(() => {
    setMaxH(null);
    try {
      window.localStorage.removeItem(CANVAS_HEIGHT_KEY);
    } catch {
      /* non-fatal */
    }
  }, []);

  const maxHeightStyle = maxH != null ? `${maxH}px` : `${DEFAULT_MAX_VH}vh`;

  return (
    <div
      className="bg-[#111] px-5 pb-1 pt-2"
      data-testid="locked-video-preview"
    >
      <div
        ref={imgContainerRef}
        className={cn(
          "mx-auto w-full max-w-sm overflow-hidden rounded-xl border border-white/10 bg-black",
          ASPECT_CLASS[aspectRatio],
        )}
        style={{ maxHeight: maxHeightStyle }}
      >
        {sourceUrl ? (
          <img
            src={sourceUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/30">
            <ImageIcon className="h-8 w-8" />
            <span className="font-mono text-[10px] uppercase tracking-widest">
              Pick a photo
            </span>
          </div>
        )}
      </div>

      {summaryLine && (
        <p
          className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-white/50"
          data-testid="locked-video-preview-summary"
        >
          {summaryLine}
        </p>
      )}

      {/* Resize handle — drag to shrink/grow the preview. Double-tap restores default. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize preview"
        className="mx-auto mt-1 flex h-7 max-w-sm cursor-ns-resize touch-none items-center justify-center gap-2 group"
        data-testid="locked-video-preview-resize-handle"
        onMouseDown={(e) => {
          e.preventDefault();
          const el = imgContainerRef.current;
          if (!el) return;
          const startH = el.getBoundingClientRect().height;
          resizeDragRef.current = { startY: e.clientY, startH };
          document.body.style.userSelect = "none";
          const onMove = (mv: MouseEvent) => {
            const drag = resizeDragRef.current;
            if (!drag) return;
            applyMaxH(drag.startH + (mv.clientY - drag.startY));
          };
          const onUp = () => {
            resizeDragRef.current = null;
            document.body.style.userSelect = "";
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
        onDoubleClick={handleResizeDoubleTap}
        onTouchStart={(e) => {
          e.preventDefault();
          const el = imgContainerRef.current;
          const t = e.touches[0];
          if (!el || !t) return;
          const now = Date.now();
          if (now - lastTapRef.current < 300) {
            handleResizeDoubleTap();
            lastTapRef.current = 0;
            return;
          }
          lastTapRef.current = now;
          const startH = el.getBoundingClientRect().height;
          resizeDragRef.current = { startY: t.clientY, startH };
          const onMove = (mv: TouchEvent) => {
            const drag = resizeDragRef.current;
            const tt = mv.touches[0];
            if (!drag || !tt) return;
            applyMaxH(drag.startH + (tt.clientY - drag.startY));
          };
          const onEnd = () => {
            resizeDragRef.current = null;
            window.removeEventListener("touchmove", onMove);
            window.removeEventListener("touchend", onEnd);
            window.removeEventListener("touchcancel", onEnd);
          };
          window.addEventListener("touchmove", onMove, { passive: false });
          window.addEventListener("touchend", onEnd);
          window.addEventListener("touchcancel", onEnd);
        }}
      >
        <span className="text-[10px] text-white/30 transition-colors group-hover:text-[#ff6b35]/70 select-none">drag to resize</span>
        <div className="h-1 w-8 rounded-full bg-white/20 transition-colors group-hover:bg-[#ff6b35]/70" />
      </div>
    </div>
  );
}

function formatSummary(s: Props["summary"]): string {
  const parts: string[] = [];
  if (s.styleLabel) parts.push(`Style: ${s.styleLabel}`);
  if (s.motionLabel) parts.push(`Motion: ${s.motionLabel}`);
  if (s.lengthSec) parts.push(`Length: ${s.lengthSec}s`);
  if (s.resolution) parts.push(`Quality: ${s.resolution}`);
  return parts.join(" · ");
}
