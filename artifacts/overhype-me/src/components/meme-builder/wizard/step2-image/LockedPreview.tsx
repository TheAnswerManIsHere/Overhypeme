import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { MEME_CANVAS_DIMS } from "@workspace/api-zod";
import { STACKED_HEIGHT_SHARE } from "../../hooks/useWideBuilderLayout";
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

/**
 * Where the removed resize handle used to remember a preview height. Nothing
 * reads it now (Issue #850, amendment 2); the builder deletes it on opening
 * so an old value can never come back into play.
 */
const RETIRED_HEIGHT_KEY = "mbfo_locked_preview_max_h";

/**
 * The locked top section of Step 2. Hosts the LivePreview canvas and owns:
 *   - drag-to-reposition gesture (mouse + touch), lifted from `MemeBuilder.tsx`,
 *     with its hint below the canvas, never over it (#881);
 *   - its size: stacked, at most STACKED_HEIGHT_SHARE of the screen's height
 *     (the layout choice compares against the same cap); side by side, fitted
 *     to the area beside the controls. There is no resize handle (Issue #850,
 *     amendment 2: a remembered height kept a sideways phone stacked).
 *
 * `touch-action: none` on the preview wrapper suppresses native scroll inside
 * the preview rect so vertical drags reposition rather than scroll the page.
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

  useEffect(() => {
    try {
      window.localStorage.removeItem(RETIRED_HEIGHT_KEY);
    } catch {
      /* localStorage may be disabled — non-fatal */
    }
  }, []);

  useEffect(() => {
    return () => {
      dragStateRef.current = null;
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
          ? { maxWidth: "100%", maxHeight: `${STACKED_HEIGHT_SHARE * 100}vh`, width: "auto", height: "auto" }
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
    <div className="bg-[#111] px-4 pb-2">
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
    </div>
  );
}
