export interface VideoStyleDef {
  id: string;
  label: string;
  description: string;
  motionPrompt: string;
  previewAsset: string | null;
}

export const VIDEO_STYLES: VideoStyleDef[] = [
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Slow dramatic push-in with moody volumetric lighting and epic atmosphere.",
    motionPrompt: "Slow cinematic camera push-in, dramatic volumetric lighting, deep shadows, epic atmosphere, film-quality motion blur",
    previewAsset: null,
  },
  {
    id: "action",
    label: "Action",
    description: "Fast cuts, shaky cam, and high-energy movement bursting with intensity.",
    motionPrompt: "High-energy action sequence, rapid camera shake, explosive motion, intense dynamic movement, adrenaline-fueled pacing",
    previewAsset: null,
  },
  {
    id: "breaking-news",
    label: "Breaking News",
    description: "Urgent broadcast feel with bold motion graphics and news-desk energy.",
    motionPrompt: "Urgent breaking-news broadcast style, bold sweeping camera pan, dramatic zoom-in on subject, high-stakes journalistic tension",
    previewAsset: null,
  },
  {
    id: "hype-reel",
    label: "Hype Reel",
    description: "Hyperpump sports-montage energy with strobing light and triumphant movement.",
    motionPrompt: "Sports highlight hype reel, triumphant slow-motion moment into fast-forward burst, strobing light flares, crowd energy atmosphere",
    previewAsset: null,
  },
  {
    id: "retro-vhs",
    label: "Retro VHS",
    description: "Nostalgic 80s VHS tape aesthetic with glitchy scan lines and warm grain.",
    motionPrompt: "Retro VHS tape aesthetic, warm film grain, horizontal scan-line glitch, slow wobbly zoom, 1980s nostalgic camcorder motion",
    previewAsset: null,
  },
  {
    id: "dramatic-zoom",
    label: "Dramatic Zoom",
    description: "Extreme slow push-in zoom that builds unbearable tension.",
    motionPrompt: "Extreme dramatic slow-zoom into subject, tension-building silence, subtle vibration, ominous creeping camera approach",
    previewAsset: null,
  },
  {
    id: "anime",
    label: "Anime",
    description: "Dynamic anime-style motion with speed lines, power surges, and expressive impact.",
    motionPrompt: "Anime-style dynamic motion, speed-line burst, power aura flare, expressive over-the-top impact frame, heroic pose reveal",
    previewAsset: null,
  },
  {
    id: "epic-storm",
    label: "Epic Storm",
    description: "Swirling storm clouds, lightning flashes, and god-like elemental power.",
    motionPrompt: "Epic storm atmosphere, swirling dark clouds time-lapse, lightning flash illumination, sweeping aerial crane shot, elemental power surge",
    previewAsset: null,
  },
];

export const VIDEO_STYLE_MAP = new Map(VIDEO_STYLES.map((s) => [s.id, s]));
