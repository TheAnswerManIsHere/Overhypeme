import { useCallback, useEffect, useRef, useState } from "react";
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
}

const CANVAS_HEIGHT_KEY = "mbfo_locked_preview_max_h";
const DEFAULT_MAX_VH = 38;
const MIN_PX = 160;
const MAX_PX = 1200;
/** Never let the saved height exceed this fraction of the visible viewport,
 *  so the controls below are always partially reachable on first scroll. */
const MAX_SAVED_VIEWPORT_FRACTION = 0.52;

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
 *   - drag-to-reposition gesture (mouse + touch), lifted from `MemeBuilder.tsx`;
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

  const canvasMaxHeightStyle = maxH != null ? `${maxH}px` : `${DEFAULT_MAX_VH}vh`;

  return (
    <div className="sticky top-12 z-10 bg-[#111] px-4 pb-1 pt-2">
      <div
        className="relative mx-auto max-w-md select-none"
        style={{ touchAction: "none", cursor: backgroundUrl ? (grabbing ? "grabbing" : "grab") : "default" }}
        onMouseDown={(e) => {
          if (!backgroundUrl) return;
          begin(e.clientX, e.clientY);
        }}
        onMouseMove={(e) => move(e.clientX, e.clientY)}
        onMouseUp={end}
        onMouseLeave={end}
        onTouchStart={(e) => {
          if (!backgroundUrl) return;
          const t = e.touches[0];
          if (!t) return;
          begin(t.clientX, t.clientY);
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (!t) return;
          move(t.clientX, t.clientY);
        }}
        onTouchEnd={end}
        onTouchCancel={end}
        data-testid="locked-preview"
      >
        <LivePreview
          factText={factText}
          name={name}
          pronouns={pronouns}
          backgroundUrl={backgroundUrl}
          textOptions={textOptions}
          aspectRatio={aspectRatio}
          framingOffset={framingOffset}
          canvasRef={canvasRef}
          canvasStyle={{
            maxWidth: "100%",
            maxHeight: canvasMaxHeightStyle,
            width: "auto",
            height: "auto",
          }}
        />
        {backgroundUrl && (
          <p className="pointer-events-none absolute bottom-1 right-2 select-none rounded-sm bg-black/40 px-1.5 py-0.5 text-[9px] text-white/60">
            Drag to reposition
          </p>
        )}
      </div>

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
