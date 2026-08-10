/**
 * Copy strings used by the meme builder. Centralized so the visual redesign
 * (planned post-Phase-3) can swap voice/tone without hunting through components.
 */

import type { HeaderCopyKey } from "./types";

export const HEADER_COPY: Record<HeaderCopyKey, { eyebrow: string; title: string; subtitle: string }> = {
  "see-with-your-name": {
    eyebrow: "Personalize",
    title: "See this fact with YOUR name",
    subtitle: "Drop your name in. Pick a photo. Watch the meme rewrite itself.",
  },
  "see-with-your-face": {
    eyebrow: "Make it personal",
    title: "See this fact with YOUR face",
    subtitle: "Upload a photo or pick one from your library.",
  },
  "see-yourself-ai": {
    eyebrow: "Legendary mode",
    title: "See yourself as the AI subject",
    subtitle: "Upload once, restyle endlessly. We'll never re-bill you for the same image.",
  },
  "make-this-your-own": {
    eyebrow: "Remix",
    title: "Make this meme your own",
    subtitle: "Same fact, your name, your photo. Customize and share.",
  },
  "build-your-meme": {
    eyebrow: "Build",
    title: "Build your meme",
    subtitle: "Where legends are made up.",
  },
};

export const ACTION_COPY = {
  download: "Download",
  save: "Save meme",
  share: "Share",
  signupCta: "Save and share — sign up free",
  tryAiMode: "Try AI mode",
} as const;

/**
 * Public/Private visibility control. `private` is a Legendary-level choice —
 * `createMemeRecord` rejects an explicit `isPublic: false` from every other
 * tier with a 403, so the control must never let a lower tier *select* it (it
 * upsells instead) — the save would refuse it, not silently publish it.
 */
export const VISIBILITY_COPY = {
  groupLabel: "Who can see this meme",
  public: "Public",
  private: "Private",
  privateHelper: "Only you. It stays out of the gallery and the link won't open for anyone else.",
  lockBadge: "LEGEND",
} as const;

export const UPLOAD_ERROR_COPY = {
  "too-large": "That file is too big. Try one under 15 MB.",
  "invalid-format": "Use a JPEG, PNG, or WebP image.",
  rejected: "This image cannot be used. Please try a different one.",
  network: "Something went wrong. Check your connection and try again.",
} as const;

export const TIER_LOCK_COPY = {
  registered: {
    title: "Sign up free to keep building",
    actionLabel: "Sign up",
  },
  legendary: {
    title: "Go Legendary to unlock this",
    actionLabel: "Upgrade",
  },
} as const;

export const STYLIZE_TOGGLE_COPY = {
  label: "Stylize me with AI",
  helper: "Generates an AI caricature from your photo. We won't re-bill you for the same image.",
  inProgress: "Generating your AI version…",
  inProgressNote: "This usually takes 30–60 seconds. Don't close the page.",
  cancel: "Cancel",
  fallbackNotice:
    "We couldn't find a face in that photo, so we generated a stylized scene instead. You can still use it.",
} as const;

export const ZERO_STOCK_COPY = {
  title: "No stock images available for this fact yet.",
  subtitle: "Try uploading your own photo, or pick another fact.",
} as const;
