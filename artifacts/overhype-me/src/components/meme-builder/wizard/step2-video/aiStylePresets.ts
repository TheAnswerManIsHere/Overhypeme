/**
 * Fallback look-style catalogue used when /api/look-styles is unreachable.
 * The runtime SHOULD always read from the server — this constant exists only
 * so the picker doesn't render empty when the catalogue request fails.
 *
 * Kept intentionally small: just enough for the user to pick a plausible
 * default. The full catalogue lives in `look_styles` on the server.
 */

import type { LookStyleDTO } from "./data/videoCatalogue";

export const FALLBACK_LOOK_STYLES: LookStyleDTO[] = [
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Filmic colors, soft contrast, shallow depth.",
    sortOrder: 0,
    previewImagePath: null,
  },
  {
    id: "anime",
    label: "Anime",
    description: "Hand-drawn anime line work and shading.",
    sortOrder: 1,
    previewImagePath: null,
  },
  {
    id: "renaissance",
    label: "Renaissance",
    description: "Oil-painted portrait energy.",
    sortOrder: 2,
    previewImagePath: null,
  },
  {
    id: "neon-noir",
    label: "Neon Noir",
    description: "Rain, neon, long shadows.",
    sortOrder: 3,
    previewImagePath: null,
  },
];

export const DEFAULT_LOOK_STYLE_ID = "cinematic";
