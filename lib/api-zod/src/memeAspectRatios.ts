/**
 * Shared meme canvas aspect-ratio constants.
 *
 * The same logical layout coordinate system is used by both the client
 * (preview canvas in `MemeBuilder.tsx`) and the server renderer
 * (`memeGenerator.ts`). Keeping the constants here guarantees the two
 * never drift apart.
 *
 * Logical units are arbitrary "design pixels" — the actual rendered output
 * is a multiple of these (template renders use a fixed scale; photo renders
 * use the cropped source resolution).
 */

export type MemeAspectRatio = "landscape" | "square" | "portrait";

export const MEME_ASPECT_RATIOS: Record<
  MemeAspectRatio,
  { w: number; h: number; label: string; ratio: string }
> = {
  landscape: { w: 800, h: 450, label: "Landscape", ratio: "16:9" },
  square:    { w: 600, h: 600, label: "Square",    ratio: "1:1"  },
  portrait:  { w: 450, h: 800, label: "Portrait",  ratio: "9:16" },
};

/** Render scale used for template (gradient) backgrounds. */
export const TEMPLATE_RENDER_SCALE = 3.6;

/** Default aspect ratio when none is specified (e.g. legacy meme rows). */
export const DEFAULT_MEME_ASPECT_RATIO: MemeAspectRatio = "landscape";
