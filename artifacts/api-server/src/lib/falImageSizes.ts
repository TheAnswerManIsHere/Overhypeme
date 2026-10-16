/**
 * fal.ai's named `image_size` presets and their pixel dimensions. Its own
 * module so the cost helpers and the fal client's recorder pricing read one
 * table without importing each other.
 */
export const IMAGE_SIZE_MAP: Readonly<Record<string, { width: number; height: number }>> = {
  square_hd:       { width: 1024, height: 1024 },
  square:          { width: 512,  height: 512  },
  portrait_4_3:    { width: 768,  height: 1024 },
  portrait_16_9:   { width: 576,  height: 1024 },
  landscape_4_3:   { width: 1024, height: 768  },
  landscape_16_9:  { width: 1024, height: 576  },
};

/** A named preset's pixel dimensions, or null for a name fal does not list. */
export function imageSizePresetPx(imageSize: string): { width: number; height: number } | null {
  return IMAGE_SIZE_MAP[imageSize] ?? null;
}
