/**
 * Source-image framing for the video pipeline's Stage 1.
 *
 * The video wizard lets the user pick an output aspect ratio AND drag to
 * reposition their source selfie within that aspect frame. We honour that
 * intent by cropping the source buffer to the target aspect *before* it goes
 * to Stage-1 stylization — so the stylized still (and therefore the video,
 * which inherits the still's orientation) matches what the user framed.
 *
 * The crop is expressed as a normalized focus point {x, y} in [0, 1]:
 *   - {0.5, 0.5} = centre crop (default)
 *   - {0,   0.5} = pin the crop window to the left edge
 *   - {0.5, 0}   = pin to the top edge
 * This is the same convention CSS `object-position: {x*100}% {y*100}%` uses
 * with `object-fit: cover`, so the wizard preview and the server crop stay in
 * lock-step without any pixel-coordinate translation.
 */

import sharp from "sharp";

/**
 * Wizard aspect choices. Structurally identical to the `AspectRatio` union in
 * videoPipelineRunner.ts; defined here too so this leaf module stays free of
 * an import cycle with the runner.
 */
export type AspectRatio = "landscape" | "square" | "portrait";

export interface FramingFocus {
  /** Horizontal focus in [0,1]; 0.5 = centre. */
  x: number;
  /** Vertical focus in [0,1]; 0.5 = centre. */
  y: number;
}

/** Width:height ratio for each wizard aspect choice. */
const ASPECT_RATIO_VALUE: Record<AspectRatio, number> = {
  landscape: 16 / 9,
  square: 1,
  portrait: 9 / 16,
};

/**
 * PuLID's `image_size` vocabulary keyed by wizard aspect. PuLID has no 16:9
 * portrait/landscape pair finer than this; these are the closest matches in
 * `IMAGE_SIZE_MAP` (costComputation.ts).
 */
const ASPECT_RATIO_TO_PULID_IMAGE_SIZE: Record<AspectRatio, string> = {
  landscape: "landscape_16_9",
  square: "square_hd",
  portrait: "portrait_16_9",
};

/** Maps a wizard aspect ratio to PuLID's `image_size` string. */
export function aspectRatioToPulidImageSize(aspectRatio: AspectRatio): string {
  return ASPECT_RATIO_TO_PULID_IMAGE_SIZE[aspectRatio] ?? "square_hd";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Computes the center-or-focus crop rectangle that fits `targetRatio` inside a
 * `srcW × srcH` image. Exported for unit testing the geometry without sharp.
 */
export function computeCropRect(
  srcW: number,
  srcH: number,
  targetRatio: number,
  focus: FramingFocus,
): { left: number; top: number; width: number; height: number } {
  const srcRatio = srcW / srcH;
  let cropW: number;
  let cropH: number;
  if (srcRatio > targetRatio) {
    // Source is wider than target — crop the sides.
    cropH = srcH;
    cropW = Math.round(srcH * targetRatio);
  } else {
    // Source is taller than (or equal to) target — crop top/bottom.
    cropW = srcW;
    cropH = Math.round(srcW / targetRatio);
  }
  cropW = Math.max(1, Math.min(srcW, cropW));
  cropH = Math.max(1, Math.min(srcH, cropH));

  const fx = clamp01(focus.x);
  const fy = clamp01(focus.y);
  const left = Math.round((srcW - cropW) * fx);
  const top = Math.round((srcH - cropH) * fy);

  return {
    left: Math.max(0, Math.min(srcW - cropW, left)),
    top: Math.max(0, Math.min(srcH - cropH, top)),
    width: cropW,
    height: cropH,
  };
}

/**
 * Crops `buffer` to `aspectRatio`, honouring the user's framing focus. Returns
 * the cropped buffer (JPEG). When the source already matches the target ratio
 * (within a pixel of rounding) and the focus is centred, the original buffer is
 * returned untouched to avoid a needless re-encode.
 */
export async function cropBufferToAspect(
  buffer: Buffer,
  aspectRatio: AspectRatio,
  focus: FramingFocus = { x: 0.5, y: 0.5 },
): Promise<Buffer> {
  const targetRatio = ASPECT_RATIO_VALUE[aspectRatio] ?? 1;
  // `rotate()` with no args applies EXIF orientation so the crop math operates
  // on the visually-upright image (phone selfies are routinely rotated).
  const img = sharp(buffer, { failOn: "error" }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) {
    // Undecodable — hand the original back; the downstream fal call will
    // surface a clearer error than we can here.
    return buffer;
  }

  const rect = computeCropRect(meta.width, meta.height, targetRatio, focus);
  if (rect.width === meta.width && rect.height === meta.height) {
    // Nothing to crop (source already at target ratio).
    return buffer;
  }

  return img
    .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    .jpeg({ quality: 92 })
    .toBuffer();
}
