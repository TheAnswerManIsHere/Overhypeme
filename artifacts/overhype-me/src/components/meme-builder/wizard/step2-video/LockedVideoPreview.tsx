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
  /** Normalized crop focus {x,y} in [0,1]; 0.5/0.5 = centre. */
  framingFocus?: { x: number; y: number };
  /** Called as the user drags to reposition the source within the aspect frame. */
  onFramingChange?: (next: { x: number; y: number }) => void;
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

export function LockedVideoPreview({
  sourceUrl,
  aspectRatio,
  summary,
  framingFocus,
  onFramingChange,
}: Props) {
  const summaryLine = formatSummary(summary);

  const imgContainerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [maxH, setMaxH] = useState<number | null>(() => readSavedMaxH());
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const lastTapRef = useRef(0);

  const focus = framingFocus ?? { x: 0.5, y: 0.5 };
  const repositionable = !!sourceUrl && !!onFramingChange;
  const [grabbing, setGrabbing] = useState(false);
  // Drag origin: client coords + focus + the per-axis overflow (displayed px
  // beyond the frame). Converting a client-px delta to a focus delta uses the
  // overflow so the same {x,y} drives both this object-position preview and the
  // server-side sharp crop (imageFraming.computeCropRect).
  const repositionDragRef = useRef<{
    startX: number;
    startY: number;
    startFX: number;
    startFY: number;
    overflowX: number;
    overflowY: number;
  } | null>(null);

  const measureOverflow = useCallback((): { overflowX: number; overflowY: number } => {
    const frame = imgContainerRef.current;
    const img = imgRef.current;
    if (!frame || !img || !img.naturalWidth || !img.naturalHeight) {
      return { overflowX: 0, overflowY: 0 };
    }
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    // object-cover scale: the larger ratio wins so the image covers the frame.
    const scale = Math.max(fw / img.naturalWidth, fh / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    return {
      overflowX: Math.max(0, dw - fw),
      overflowY: Math.max(0, dh - fh),
    };
  }, []);

  const beginReposition = useCallback(
    (clientX: number, clientY: number) => {
      if (!repositionable) return;
      const { overflowX, overflowY } = measureOverflow();
      repositionDragRef.current = {
        startX: clientX,
        startY: clientY,
        startFX: focus.x,
        startFY: focus.y,
        overflowX,
        overflowY,
      };
      setGrabbing(true);
    },
    [repositionable, measureOverflow, focus.x, focus.y],
  );

  const moveReposition = useCallback(
    (clientX: number, clientY: number) => {
      const drag = repositionDragRef.current;
      if (!drag || !onFramingChange) return;
      // Dragging the image right (positive dx) reveals its left side → focus
      // decreases. Δfocus = -Δclient / overflow.
      const nextX = drag.overflowX > 0
        ? clamp01(drag.startFX - (clientX - drag.startX) / drag.overflowX)
        : drag.startFX;
      const nextY = drag.overflowY > 0
        ? clamp01(drag.startFY - (clientY - drag.startY) / drag.overflowY)
        : drag.startFY;
      onFramingChange({ x: nextX, y: nextY });
    },
    [onFramingChange],
  );

  const endReposition = useCallback(() => {
    repositionDragRef.current = null;
    setGrabbing(false);
  }, []);

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
          "relative mx-auto w-full max-w-sm select-none overflow-hidden rounded-xl border border-white/10 bg-black",
          ASPECT_CLASS[aspectRatio],
        )}
        style={{
          maxHeight: maxHeightStyle,
          touchAction: repositionable ? "none" : undefined,
          cursor: repositionable ? (grabbing ? "grabbing" : "grab") : "default",
        }}
        onMouseDown={(e) => beginReposition(e.clientX, e.clientY)}
        onMouseMove={(e) => moveReposition(e.clientX, e.clientY)}
        onMouseUp={endReposition}
        onMouseLeave={endReposition}
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (t) beginReposition(t.clientX, t.clientY);
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (t) moveReposition(t.clientX, t.clientY);
        }}
        onTouchEnd={endReposition}
        onTouchCancel={endReposition}
      >
        {sourceUrl ? (
          <>
            <img
              ref={imgRef}
              src={sourceUrl}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
              style={{ objectPosition: `${focus.x * 100}% ${focus.y * 100}%` }}
            />
            {repositionable && (
              <p className="pointer-events-none absolute bottom-1 right-2 select-none rounded-sm bg-black/40 px-1.5 py-0.5 text-[9px] text-white/60">
                Drag to reposition
              </p>
            )}
          </>
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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function formatSummary(s: Props["summary"]): string {
  const parts: string[] = [];
  if (s.styleLabel) parts.push(`Style: ${s.styleLabel}`);
  if (s.motionLabel) parts.push(`Motion: ${s.motionLabel}`);
  if (s.lengthSec) parts.push(`Length: ${s.lengthSec}s`);
  if (s.resolution) parts.push(`Quality: ${s.resolution}`);
  return parts.join(" · ");
}
