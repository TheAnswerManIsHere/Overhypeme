/**
 * Which arrangement the meme builder uses: the preview beside a controls
 * column ("wide") or above the controls ("stacked"). Issue #850, amendment 1
 * (David, 2026-11-24, Q31: 1): **whichever arrangement shows the picture
 * larger wins**, worked out for the current screen and the current picture
 * shape, so tapping a different shape can move the controls.
 *
 * Amendment 2 (David, 2026-11-25): no resize handle, so the stacked picture's
 * height cap is a fixed share of the screen; a short sideways screen never
 * stacks; turning the screen chooses afresh.
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
): Record<BuilderLayout, number> {
  const dims = MEME_CANVAS_DIMS[aspectRatio];
  const ratio = dims.w / dims.h;
  const wide = fittedWidth(viewport.w - CONTROLS_COLUMN_PX - WIDE_PAD_X, viewport.h - WIDE_PAD_Y, ratio);
  // The stacked canvas is sized automatically, so it never grows past its own
  // pixel width (Codex F2 on PR #1258); the wide one is sized explicitly.
  const stacked = Math.min(dims.w, fittedWidth(viewport.w - STACKED_PAD_X, stackedCap(viewport.h), ratio));
  return { wide, stacked };
}

/** Below this height a sideways screen never stacks (David, 2026-11-24). */
const SHORT_SCREEN_PX = 500;
/** The smallest picture worth showing beside the controls (Astra C8). */
const MIN_SIDE_PICTURE_PX = 160;
/** The stacked picture's height cap: a fixed share of the screen. */
export const STACKED_HEIGHT_SHARE = 0.38;

/** The stacked picture's height cap at this screen height. */
function stackedCap(viewportHeight: number): number {
  return Math.floor(viewportHeight * STACKED_HEIGHT_SHARE);
}

function isSideways(v: { w: number; h: number }): boolean {
  return v.w > v.h;
}

/**
 * The arrangement for this screen and shape (Issue #850, amendments 1 and 2).
 *
 * - A short, sideways screen goes side by side whenever both columns fit:
 *   "there's not enough height" to stack (David, 2026-11-24). This comes
 *   before the size comparison and its margin.
 * - Otherwise the arrangement that shows the picture larger wins. With
 *   `current` given, it is kept unless the other is at least SWITCH_MARGIN
 *   larger, so near-ties do not flicker on a resize, except across a turn
 *   (`previous` upright and now sideways, or the reverse), which chooses
 *   afresh.
 */
export function chooseBuilderLayout(
  viewport: { w: number; h: number },
  aspectRatio: AspectRatio,
  current?: BuilderLayout,
  previous?: { w: number; h: number },
): BuilderLayout {
  // Turning the screen between upright and sideways chooses afresh: the
  // margin is for near-ties while a window is resized, and a turn is not one
  // (Issue #850, amendment 2).
  if (previous && isSideways(previous) !== isSideways(viewport)) current = undefined;
  const widths = previewWidths(viewport, aspectRatio);
  if (viewport.h < SHORT_SCREEN_PX && isSideways(viewport) && widths.wide >= MIN_SIDE_PICTURE_PX) {
    return "wide";
  }
  const best: BuilderLayout = widths.wide > widths.stacked ? "wide" : "stacked";
  if (!current || best === current) return best;
  const other = current === "wide" ? "stacked" : "wide";
  return widths[other] >= widths[current] * SWITCH_MARGIN ? other : current;
}

function viewportNow(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: 0, h: 0 };
  return { w: window.innerWidth, h: window.innerHeight };
}

/** The live choice, re-made on every resize and change of shape. */
export function useBuilderLayout(aspectRatio: AspectRatio): BuilderLayout {
  const previous = useRef<{ w: number; h: number } | null>(null);
  const [layout, setLayout] = useState<BuilderLayout>(() =>
    chooseBuilderLayout(viewportNow(), aspectRatio),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const decide = () => {
      const v = viewportNow();
      const before = previous.current ?? undefined;
      previous.current = v;
      setLayout((current) => chooseBuilderLayout(v, aspectRatio, current, before));
    };
    decide();
    window.addEventListener("resize", decide);
    return () => window.removeEventListener("resize", decide);
  }, [aspectRatio]);

  return layout;
}
