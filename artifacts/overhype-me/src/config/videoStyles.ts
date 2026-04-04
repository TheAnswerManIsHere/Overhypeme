export interface VideoStyleDef {
  id: string;
  label: string;
  description: string;
  gradientFrom: string;
  gradientTo: string;
  previewAsset: string | null;
}

export const VIDEO_STYLES: VideoStyleDef[] = [
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Slow dramatic push-in with moody volumetric lighting and epic atmosphere.",
    gradientFrom: "#2d1e00",
    gradientTo: "#8d6e63",
    previewAsset: null,
  },
  {
    id: "action",
    label: "Action",
    description: "Fast cuts, shaky cam, and high-energy movement bursting with intensity.",
    gradientFrom: "#bf360c",
    gradientTo: "#ff6d00",
    previewAsset: null,
  },
  {
    id: "breaking-news",
    label: "Breaking News",
    description: "Urgent broadcast feel with bold motion graphics and news-desk energy.",
    gradientFrom: "#7f0000",
    gradientTo: "#d32f2f",
    previewAsset: null,
  },
  {
    id: "hype-reel",
    label: "Hype Reel",
    description: "Hyperpump sports-montage energy with strobing light and triumphant movement.",
    gradientFrom: "#1a237e",
    gradientTo: "#00e5ff",
    previewAsset: null,
  },
  {
    id: "retro-vhs",
    label: "Retro VHS",
    description: "Nostalgic 80s VHS tape aesthetic with glitchy scan lines and warm grain.",
    gradientFrom: "#1a0030",
    gradientTo: "#e64a19",
    previewAsset: null,
  },
  {
    id: "dramatic-zoom",
    label: "Dramatic Zoom",
    description: "Extreme slow push-in zoom that builds unbearable tension.",
    gradientFrom: "#0a0a0a",
    gradientTo: "#455a64",
    previewAsset: null,
  },
  {
    id: "anime",
    label: "Anime",
    description: "Dynamic anime-style motion with speed lines, power surges, and expressive impact.",
    gradientFrom: "#4a0060",
    gradientTo: "#0288d1",
    previewAsset: null,
  },
  {
    id: "epic-storm",
    label: "Epic Storm",
    description: "Swirling storm clouds, lightning flashes, and god-like elemental power.",
    gradientFrom: "#0a0e2e",
    gradientTo: "#1565c0",
    previewAsset: null,
  },
];
