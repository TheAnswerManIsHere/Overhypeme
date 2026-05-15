import { useCallback, useRef, useState } from "react";
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

/**
 * The locked top section of Step 2. Hosts the LivePreview canvas and owns the
 * drag-to-reposition gesture — mouse + touch handlers derived from
 * `MemeBuilder.tsx:943-980`. `touch-action: none` on the wrapper suppresses
 * native scroll inside the preview rect so vertical drags reposition the
 * image rather than scroll the page.
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

  return (
    <div className="sticky top-12 z-10 bg-[#111] px-4 pb-3 pt-2">
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
        />
        {backgroundUrl && (
          <p className="pointer-events-none absolute bottom-1 right-2 select-none rounded-sm bg-black/40 px-1.5 py-0.5 text-[9px] text-white/60">
            Drag to reposition
          </p>
        )}
      </div>
    </div>
  );
}
