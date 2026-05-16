/**
 * AI style presets surfaced in the "Create new AI image" Advanced Options
 * panel. Mirrors a subset of `artifacts/api-server/src/config/imageStyles.ts`
 * — the server validates the styleId against its own canonical list, so this
 * file is just the (id, label) pairs the picker UI needs.
 *
 * Keep this list in sync with the server config when adding or removing
 * styles. Sending an unknown id is non-fatal server-side (the prompt suffix
 * is dropped), but a stale picker would offer styles that silently no-op.
 */
export interface AiStylePreset {
  id: string;
  label: string;
}

export const AI_STYLE_PRESETS: AiStylePreset[] = [
  { id: "none", label: "Default (no style)" },
  { id: "cinematic", label: "Cinematic" },
  { id: "epic", label: "Epic / Mythological" },
  { id: "anime", label: "Anime" },
  { id: "comic", label: "Comic book" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "pixel-art", label: "Pixel art" },
  { id: "oil-painting", label: "Oil painting" },
  { id: "propaganda", label: "Propaganda poster" },
  { id: "pop-art", label: "Pop art" },
  { id: "watercolor", label: "Watercolor" },
  { id: "photorealistic", label: "Photorealistic" },
  { id: "graffiti", label: "Graffiti / Street art" },
  { id: "sketch", label: "Sketch / Blueprint" },
  { id: "pulp-fiction", label: "Retro pulp fiction" },
  { id: "stained-glass", label: "Stained glass" },
  { id: "claymation", label: "Claymation" },
  { id: "ukiyo-e", label: "Ukiyo-e (Japanese woodblock)" },
  { id: "neon-noir", label: "Neon noir" },
];

export const DEFAULT_AI_STYLE_ID = "none";
