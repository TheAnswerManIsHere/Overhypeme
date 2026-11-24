/**
 * Which arrangement the meme builder uses: the preview beside a controls
 * column ("wide") or above the controls ("stacked"). Issue #850, amendment 1
 * (David, 2026-11-24, Q31: 1): **whichever arrangement shows the picture
 * larger wins**, worked out for the current screen and the current picture
 * shape, so tapping a different shape can move the controls.
 *
 * Deliberately not `useDesktopModality`, which calls a touch tablet "mobile"
 * whatever its size: the choice follows the space, never the device.
 */
import { useEffect, useRef, useState } from "react";
import { MEME_CANVAS_DIMS } from "@workspace/api-zod";
import type { AspectRatio } from "../types";

export type BuilderLayout = "wide" | "stacked";

/** Width of the wide layout's controls column (`w-[420px]` in Step2Image). */
export const CONTROLS_COLUMN_PX = 420;
/** Wide preview area: px-6 each side. */
const WIDE_PAD_X = 48;
/** Wide preview area: top bar 48 + pt-4 16 + pb-3 12 + hint row 8 + 16. */
const WIDE_PAD_Y = 100;
/** Stacked preview: px-4 each side. */
const STACKED_PAD_X = 32;
/** The preview's 1px border each side. */
const BORDER = 2;
/** Switch only when the other arrangement's picture is this much larger. */
export const SWITCH_MARGIN = 1.1;

/** Displayed width of a picture of `ratio` (w/h) fitted into w×h. */
function fittedWidth(w: number, h: number, ratio: number): number {
  const maxW = Math.max(0, w - BORDER);
  const maxH = Math.max(0, h - BORDER);
  return Math.max(0, Math.min(maxW, maxH * ratio));
}

/**
 * The picture's displayed width in each arrangement. Comparing widths compares
 * areas, since the shape is the same in both.
 */
export function previewWidths(
  viewport: { w: number; h: number },
  aspectRatio: AspectRatio,
  stackedMaxHeight: number,
): Record<BuilderLayout, number> {
  const dims = MEME_CANVAS_DIMS[aspectRatio];
  const ratio = dims.w / dims.h;
  const wide = fittedWidth(viewport.w - CONTROLS_COLUMN_PX - WIDE_PAD_X, viewport.h - WIDE_PAD_Y, ratio);
  const stacked = fittedWidth(viewport.w - STACKED_PAD_X, stackedMaxHeight, ratio);
  return { wide, stacked };
}

/**
 * The arrangement that shows the picture larger. With `current` given, it is
 * kept unless the other is at least SWITCH_MARGIN larger, so near-ties do not
 * flicker on a resize.
 */
export function chooseBuilderLayout(
  viewport: { w: number; h: number },
  aspectRatio: AspectRatio,
  stackedMaxHeight: number,
  current?: BuilderLayout,
): BuilderLayout {
  // No width floor: a phone held sideways is short, so its picture is larger
  // beside the controls (David, 2026-11-24). Upright phones still stack,
  // because the side-by-side area is too narrow to win.
  const widths = previewWidths(viewport, aspectRatio, stackedMaxHeight);
  const best: BuilderLayout = widths.wide > widths.stacked ? "wide" : "stacked";
  if (!current || best === current) return best;
  const other = current === "wide" ? "stacked" : "wide";
  return widths[other] >= widths[current] * SWITCH_MARGIN ? other : current;
}

function viewportNow(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: 0, h: 0 };
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * The live choice. `stackedMaxHeight` reads the stacked preview's cap at the
 * moment of deciding (the remembered handle height, or its default).
 */
export function useBuilderLayout(
  aspectRatio: AspectRatio,
  stackedMaxHeight: (viewportHeight: number) => number,
): BuilderLayout {
  const capRef = useRef(stackedMaxHeight);
  capRef.current = stackedMaxHeight;
  const [layout, setLayout] = useState<BuilderLayout>(() => {
    const v = viewportNow();
    return chooseBuilderLayout(v, aspectRatio, stackedMaxHeight(v.h));
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const decide = () => {
      const v = viewportNow();
      setLayout((current) => chooseBuilderLayout(v, aspectRatio, capRef.current(v.h), current));
    };
    decide();
    window.addEventListener("resize", decide);
    return () => window.removeEventListener("resize", decide);
  }, [aspectRatio]);

  return layout;
}
