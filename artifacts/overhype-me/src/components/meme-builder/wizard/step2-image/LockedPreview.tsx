import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { MEME_CANVAS_DIMS } from "@workspace/api-zod";
import { LivePreview } from "../../parts/LivePreview";
import type { AspectRatio, MemeTextOptions } from "../../types";

interface Props {
  factText: string;
  name: string;
  pronouns: string;
  backgroundUrl: string | null;
  textOptions: MemeTextOptions;
  aspectRatio: AspectRatio;
  framingOffset: { x: number; y: number };
  onFramingChange: (next: { x: number; y: number }) => void;
  /**
   * The wide layout (Issue #850): the preview fills the space it is given,
   * in proportion, and has no resize handle. The remembered handle height
   * is neither read nor erased here, so the stacked layout still finds it.
   */
  fill?: boolean;
}

/** The preview's 1px border on each side, which the fitted canvas must clear. */
const FILL_BORDER_PX = 2;

/**
 * The largest canvas display size that keeps `ratio` (width / height) and
 * fits inside `area`. Pure, so the wide layout's fitting is unit-testable.
 */
export function fitCanvas(area: { w: number; h: number }, ratio: number): { w: number; h: number } {
  const maxW = Math.max(0, area.w - FILL_BORDER_PX);
  const maxH = Math.max(0, area.h - FILL_BORDER_PX);
  // Whichever side limits the fit is used exactly; the other follows the ratio.
  if (maxW / ratio <= maxH) return { w: Math.floor(maxW), h: Math.floor(maxW / ratio) };
  return { w: Math.floor(maxH * ratio), h: Math.floor(maxH) };
}

const CANVAS_HEIGHT_KEY = "mbfo_locked_preview_max_h";
const DEFAULT_MAX_VH = 38;
const MIN_PX = 160;
const MAX_PX = 1200;
/** Never let the saved height exceed this fraction of the visible viewport,
 *  so the controls below are always partially reachable on first scroll. */
const MAX_SAVED_VIEWPORT_FRACTION = 0.52;

/**
 * The stacked preview's height cap at this moment: the remembered handle
 * height, or the default share of the screen. The layout choice (Issue #850,
 * amendment 1) compares against it.
 */
export function stackedPreviewMaxHeight(viewportHeight: number): number {
  const saved = readSavedMaxH();
  return saved != null
    ? effectiveMaxH(saved, viewportHeight)
    : Math.floor((viewportHeight * DEFAULT_MAX_VH) / 100);
}

/**
 * A remembered height as the stacked preview actually draws it at this
 * viewport height. The layout choice and the preview both use it, so they
 * never disagree after a resize (Astra C7 on amendment 1).
 */
function effectiveMaxH(maxH: number, viewportHeight: number): number {
  return Math.max(MIN_PX, Math.min(MAX_PX, maxH, Math.floor(viewportHeight * MAX_SAVED_VIEWPORT_FRACTION)));
}

function readSavedMaxH(): number | null {
  if (typeof window === "undefined") return null;
  const saved = window.localStorage.getItem(CANVAS_HEIGHT_KEY);
  const parsed = saved ? parseInt(saved, 10) : NaN;
  if (!Number.isFinite(parsed)) return null;
  // Clamp against the actual visible height so a previously-saved large value
  // doesn't hide all the controls on a small screen / mobile browser.
  const viewportCap = Math.floor(window.innerHeight * MAX_SAVED_VIEWPORT_FRACTION);
  return Math.max(MIN_PX, Math.min(MAX_PX, parsed, viewportCap));
}

/**
 * The locked top section of Step 2. Hosts the LivePreview canvas and owns:
 *   - drag-to-reposition gesture (mouse + touch), lifted from `MemeBuilder.tsx`,
 *     with its hint below the canvas, never over it (#881);
 *   - a user-controlled resize handle below the canvas so the preview can be
 *     shrunk when the controls need more room. Height persists to
 *     localStorage under `mbfo_locked_preview_max_h` (clamped 160-1200px).
 *
 * `touch-action: none` on the preview wrapper suppresses native scroll inside
 * the preview rect so vertical drags reposition rather than scroll the page.
 * The resize handle is its own region with `touch-action: none` only during
 * the drag so it doesn't conflict.
 */
export function LockedPreview({
  factText,
  name,
  pronouns,
  backgroundUrl,
  textOptions,
  aspectRatio,
  framingOffset,
  onFramingChange,
  fill = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startOX: number;
    startOY: number;
  } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const [maxH, setMaxH] = useState<number | null>(() => readSavedMaxH());
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);

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

  // If the user double-taps the resize handle, restore the default.
  const lastTapRef = useRef(0);
  const handleResizeDoubleTap = useCallback(() => {
    setMaxH(null);
    try {
      window.localStorage.removeItem(CANVAS_HEIGHT_KEY);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    return () => {
      dragStateRef.current = null;
      resizeDragRef.current = null;
    };
  }, []);

  const scaleFromEvent = useCallback((): { sx: number; sy: number } => {
    const c = canvasRef.current;
    if (!c) return { sx: 1, sy: 1 };
    const rect = c.getBoundingClientRect();
    return {
      sx: rect.width === 0 ? 1 : c.width / rect.width,
      sy: rect.height === 0 ? 1 : c.height / rect.height,
    };
  }, []);

  const begin = useCallback(
    (clientX: number, clientY: number) => {
      dragStateRef.current = {
        startX: clientX,
        startY: clientY,
        startOX: framingOffset.x,
        startOY: framingOffset.y,
      };
      setGrabbing(true);
    },
    [framingOffset.x, framingOffset.y],
  );

  const move = useCallback(
    (clientX: number, clientY: number) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const { sx, sy } = scaleFromEvent();
      onFramingChange({
        x: drag.startOX + (clientX - drag.startX) * sx,
        y: drag.startOY + (clientY - drag.startY) * sy,
      });
    },
    [onFramingChange, scaleFromEvent],
  );

  const end = useCallback(() => {
    dragStateRef.current = null;
    setGrabbing(false);
  }, []);

  // Track the viewport height so a remembered height is re-clamped on resize,
  // exactly as the layout choice clamps it.
  const [viewportH, setViewportH] = useState<number>(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const canvasMaxHeightStyle =
    maxH != null ? `${effectiveMaxH(maxH, viewportH)}px` : `${DEFAULT_MAX_VH}vh`;

  // Wide layout: measure the area beside the controls and fit the canvas to it.
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!fill) return;
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setArea({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  const dims = MEME_CANVAS_DIMS[aspectRatio];
  const fitted = fill && area ? fitCanvas(area, dims.w / dims.h) : null;

  const dragHandlers = {
    onMouseDown: (e: ReactMouseEvent) => {
      if (!backgroundUrl) return;
      begin(e.clientX, e.clientY);
    },
    onMouseMove: (e: ReactMouseEvent) => move(e.clientX, e.clientY),
    onMouseUp: end,
    onMouseLeave: end,
    onTouchStart: (e: ReactTouchEvent) => {
      if (!backgroundUrl) return;
      const t = e.touches[0];
      if (!t) return;
      begin(t.clientX, t.clientY);
    },
    onTouchMove: (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      move(t.clientX, t.clientY);
    },
    onTouchEnd: end,
    onTouchCancel: end,
  };
  const dragStyle = { touchAction: "none" as const, cursor: backgroundUrl ? (grabbing ? "grabbing" : "grab") : "default" };

  const livePreview = (
    <LivePreview
      factText={factText}
      name={name}
      pronouns={pronouns}
      backgroundUrl={backgroundUrl}
      textOptions={textOptions}
      aspectRatio={aspectRatio}
      framingOffset={framingOffset}
      canvasRef={canvasRef}
      canvasStyle={
        !fill
          ? { maxWidth: "100%", maxHeight: canvasMaxHeightStyle, width: "auto", height: "auto" }
          : fitted
            ? { width: `${fitted.w}px`, height: `${fitted.h}px`, maxWidth: "none" }
            : { visibility: "hidden", width: 0, height: 0 }
      }
    />
  );

  if (fill) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[#111] px-6 pt-4 pb-3" data-testid="locked-preview-fill">
        <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center" data-testid="locked-preview-area">
          <div className="relative select-none" style={dragStyle} {...dragHandlers} data-testid="locked-preview">
            {livePreview}
          </div>
        </div>
        {/* The hint always takes its row, so the area above never changes size
            when a photo is chosen. */}
        <p className="mt-2 h-4 select-none text-center text-[10px] text-white/40">
          {backgroundUrl ? "Drag the photo to reposition" : ""}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-[#111] px-4 pb-1">
      <div
        className="relative mx-auto select-none"
        style={dragStyle}
        {...dragHandlers}
        data-testid="locked-preview"
      >
        {livePreview}
        {/* Nothing is drawn over the canvas: the preview must show the meme
            exactly as it is saved (#870), watermark included, and the
            watermark can sit in any corner — so the drag hint lives in the
            row below (#881). */}
      </div>

      {backgroundUrl && (
        <p className="mx-auto mt-1 max-w-md select-none text-center text-[10px] text-white/40">
          Drag the photo to reposition
        </p>
      )}

      {/* Resize handle — drag the bar to shrink/grow the preview. Double-tap restores the default. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize preview"
        className="mx-auto mt-1 flex h-7 max-w-md cursor-ns-resize touch-none items-center justify-center gap-2 group"
        data-testid="locked-preview-resize-handle"
        onMouseDown={(e) => {
          e.preventDefault();
          const el = canvasRef.current;
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
          const el = canvasRef.current;
          const t = e.touches[0];
          if (!el || !t) return;
          // Double-tap to reset.
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
