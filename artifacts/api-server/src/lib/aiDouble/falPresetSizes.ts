/**
 * fal.ai's named `image_size` presets and their pixel dimensions, for the
 * recorder's per-megapixel price bound (`falCallPrice`). The product's own
 * table is `costComputation.ts`; importing it here would close an import
 * cycle through the fal client, so this copy is held equal to it by
 * `falCallPrice.test.ts`.
 */
export const FAL_PRESET_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  square_hd:       { width: 1024, height: 1024 },
  square:          { width: 512,  height: 512  },
  portrait_4_3:    { width: 768,  height: 1024 },
  portrait_16_9:   { width: 576,  height: 1024 },
  landscape_4_3:   { width: 1024, height: 768  },
  landscape_16_9:  { width: 1024, height: 576  },
};

/** A named preset's pixel dimensions, or null for a name fal does not list. */
export function imageSizePresetPx(imageSize: string): { width: number; height: number } | null {
  return FAL_PRESET_SIZES[imageSize] ?? null;
}
