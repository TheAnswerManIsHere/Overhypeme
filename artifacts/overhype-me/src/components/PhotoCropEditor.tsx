/**
 * @purpose The profile-photo zoom-and-crop editor shared by onboarding's photo step and Profile's "Change photo": shows the picked photo in a square stage under a round frame, lets the member drag (mouse, one finger, arrow keys) and zoom (pinch, wheel, slider, +/-) it, and on "Use this photo" hands the parent exactly the framed square as a JPEG of at most 1024 px; the preview and the saved file are drawn from the same still snapshot by the same crop calculation; while the site is paused the confirm is grayed out, and a pause that began while framing refuses it; uploading stays the parent's.
 * @subsystem studio
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Minus, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/slider";
import { PausedWhenReadOnly } from "@/components/PausedWhenReadOnly";
import { isReadOnlyNow, noteReadOnlyRefusal } from "@/lib/readOnlyNotice";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  decodeToSnapshot,
  defaultView,
  drawSquare,
  exportSquareJpeg,
  panView,
  sourceSquare,
  zoomView,
  type CropView,
} from "@/lib/photo-crop";

/** The stage's size on screen, in CSS pixels. */
const STAGE_PX = 256;
const KEY_PAN_PX = 8;
/** One press of +/− (key or button). */
const ZOOM_STEP = 0.25;

export interface PhotoCropEditorProps {
  /** The photo the member picked; a new file restarts the editor. */
  file: File;
  /**
   * Called with the framed square as a JPEG when the member confirms. Never called while
   * the site is read-only — a pause that began while framing refuses the confirm and
   * cancels instead, checked after the JPEG is encoded, immediately before handing it over.
   */
  onConfirm: (cropped: File) => void;
  /** "Pick a different one" / cancel, and a confirm refused by a pause — nothing is uploaded. */
  onCancel: () => void;
  /** Called when the picked file cannot be decoded; the parent shows its message. */
  onDecodeError: () => void;
  /** The parent is uploading the confirmed photo. */
  busy?: boolean;
  /** The parent's upload or save error, shown under the editor. */
  error?: string;
  cancelLabel?: string;
}

export function PhotoCropEditor({
  file,
  onConfirm,
  onCancel,
  onDecodeError,
  busy = false,
  error,
  cancelLabel = "Pick a different one",
}: PhotoCropEditorProps) {
  const [snapshot, setSnapshot] = useState<HTMLCanvasElement | null>(null);
  const [view, setView] = useState<CropView | null>(null);
  const [encoding, setEncoding] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // The file whose work may still publish; a replaced or cancelled file's late result is dropped.
  const liveFile = useRef<File | null>(file);
  const decodeErrorRef = useRef(onDecodeError);
  decodeErrorRef.current = onDecodeError;

  useEffect(() => {
    liveFile.current = file;
    let stale = false;
    setSnapshot(null);
    setView(null);
    decodeToSnapshot(file).then(
      (snap) => {
        if (stale) return;
        setSnapshot(snap);
        setView(defaultView({ width: snap.width, height: snap.height }));
      },
      () => {
        if (!stale) decodeErrorRef.current();
      },
    );
    return () => {
      stale = true;
      liveFile.current = null;
    };
  }, [file]);

  const size = useMemo(() => (snapshot ? { width: snapshot.width, height: snapshot.height } : null), [snapshot]);

  // The preview: the same snapshot and the same square the export draws.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snapshot || !view || !size) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const px = Math.round(STAGE_PX * dpr);
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (ctx) drawSquare(ctx, snapshot, sourceSquare(size, view));
  }, [snapshot, view, size]);

  const stageScale = useCallback(() => stageRef.current?.getBoundingClientRect().width || STAGE_PX, []);

  const update = useCallback(
    (fn: (v: CropView) => CropView) => {
      if (!size) return;
      setView((v) => (v ? clampView(size, fn(v)) : v));
    },
    [size],
  );

  const zoomBy = (delta: number) => size && update((v) => zoomView(size, v, v.zoom + delta, stageScale()));

  const locked = busy || encoding || !view;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !size || locked) return;
    const stage = stageScale();
    const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId);
    const next = { x: e.clientX, y: e.clientY };
    if (others.length === 0) {
      update((v) => panView(size, v, next.x - prev.x, next.y - prev.y, stage));
    } else {
      const other = others[0][1];
      const rect = stageRef.current!.getBoundingClientRect();
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      const midBefore = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const midAfter = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
      update((v) => {
        const zoomed = before > 0
          ? zoomView(size, v, v.zoom * (after / before), stage, midBefore.x - rect.left, midBefore.y - rect.top)
          : v;
        return panView(size, zoomed, midAfter.x - midBefore.x, midAfter.y - midBefore.y, stage);
      });
    }
    pointers.current.set(e.pointerId, next);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
  }

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !size) return;
    function onWheel(e: WheelEvent) {
      if (!size || locked) return;
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      update((v) => zoomView(size, v, v.zoom * Math.exp(-e.deltaY * 0.002), rect.width, e.clientX - rect.left, e.clientY - rect.top));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [size, locked, update]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!size || locked) return;
    const stage = stageScale();
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [KEY_PAN_PX, 0],
      ArrowRight: [-KEY_PAN_PX, 0],
      ArrowUp: [0, KEY_PAN_PX],
      ArrowDown: [0, -KEY_PAN_PX],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      update((v) => panView(size, v, dx, dy, stage));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomBy(-ZOOM_STEP);
    }
  }

  async function confirm() {
    if (!snapshot || !view || locked) return;
    const forFile = file;
    setEncoding(true);
    try {
      const cropped = await exportSquareJpeg(snapshot, view, file.name);
      if (liveFile.current !== forFile) return;
      if (isReadOnlyNow()) {
        noteReadOnlyRefusal();
        onCancel();
        return;
      }
      onConfirm(cropped);
    } catch {
      if (liveFile.current === forFile) decodeErrorRef.current();
    } finally {
      if (liveFile.current === forFile) setEncoding(false);
    }
  }

  const confirmButton = (
    <Button type="button" onClick={confirm} disabled={locked} className="w-full gap-2" data-testid="photo-crop-confirm">
      {busy || encoding ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" /> {busy ? "Uploading…" : "Preparing…"}
        </>
      ) : (
        <>Use this photo</>
      )}
    </Button>
  );

  return (
    <div className="space-y-4" data-testid="photo-crop-editor">
      <div
        ref={stageRef}
        data-testid="photo-crop-stage"
        role="application"
        aria-label="Photo framing. Drag to move, pinch or use the slider to zoom. Arrow keys move, plus and minus zoom."
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className="relative mx-auto overflow-hidden rounded-sm bg-black select-none cursor-grab active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        style={{ width: STAGE_PX, height: STAGE_PX, touchAction: "none" }}
      >
        <canvas
          ref={canvasRef}
          data-testid="photo-crop-preview"
          className="absolute inset-0 w-full h-full"
          aria-hidden="true"
        />
        {/* The round frame: the circle of the saved square; the corners outside it are dimmed. */}
        <div
          className="pointer-events-none absolute inset-0 rounded-full border-2 border-primary"
          style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)" }}
        />
        {!view && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 px-2">
        <button
          type="button"
          aria-label="Zoom out"
          disabled={locked}
          onClick={() => zoomBy(-ZOOM_STEP)}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Minus className="w-4 h-4" />
        </button>
        <Slider
          aria-label="Zoom"
          data-testid="photo-crop-zoom"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          disabled={locked}
          value={[view?.zoom ?? MIN_ZOOM]}
          onValueChange={([z]) => size && update((v) => zoomView(size, v, z, stageScale()))}
        />
        <button
          type="button"
          aria-label="Zoom in"
          disabled={locked}
          onClick={() => zoomBy(ZOOM_STEP)}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Drag to move, pinch or slide to zoom. The whole square is saved: your picture shows the circle, and memes use the square.
      </p>

      {error && <p className="text-destructive text-sm font-medium text-center">{error}</p>}

      <PausedWhenReadOnly className="w-full">{confirmButton}</PausedWhenReadOnly>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 underline transition-colors disabled:opacity-50"
        >
          <RotateCw className="w-3 h-3" /> {cancelLabel}
        </button>
      </div>
    </div>
  );
}
