/**
 * Step 1 of the MBFO wizard: image or video?
 *
 * Two stacked cards (image on top, video on bottom). The video card is the
 * premium upsell surface — crown badge + gold-orange gradient ring stay at
 * full strength in every state.
 *
 * Click behavior (resolved in `useVideoCardState`, off the resolved
 * video_generation entitlement — not tier):
 *   - any viewer, image card       → onSelect("image")
 *   - not entitled                 → opens UnifiedUpgradeModal(video-card)
 *   - entitled, tappable           → onSelect("video")
 *   - entitled, budget-reached     → no-op (CardBudgetReached overlay)
 *
 * Hero example assets are fetched from /api/hero-examples and a single one
 * per type is picked at random per mount. The set is empty at MBFO-2 launch;
 * the components fall back to brand-orange placeholder cards.
 */

import { useState } from "react";
import type { ArtifactType } from "../state/wizardStorage";
import { useVideoCardState } from "../state/useVideoCardState";
import { useHeroExamples } from "../data/useHeroExamples";
import { HeroExampleImage } from "../parts/HeroExampleImage";
import { HeroExampleVideo } from "../parts/HeroExampleVideo";
import { VideoCardChrome } from "../parts/VideoCardChrome";
import { CardLockedOverlay } from "../parts/CardLockedOverlay";
import { CardBudgetReached } from "../parts/CardBudgetReached";
import { UnifiedUpgradeModal } from "../../../upgrade/UnifiedUpgradeModal";

interface Props {
  selected: ArtifactType | null;
  onSelect: (type: ArtifactType) => void;
  canVideoGeneration: boolean;
}

export function Step1ArtifactType({ selected, onSelect, canVideoGeneration }: Props) {
  const hero = useHeroExamples();
  const videoState = useVideoCardState({ canVideoGeneration });
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const handleVideoClick = () => {
    switch (videoState.kind) {
      case "tappable":
        onSelect("video");
        return;
      case "locked-upgrade":
        setUpgradeOpen(true);
        return;
      case "budget-reached":
        // Non-tappable; rendered as a non-button.
        return;
    }
  };

  return (
    <div className="flex flex-col h-full px-5 pt-6 pb-8 max-w-md mx-auto">
      <header className="text-center pb-5 shrink-0">
        <h1 className="text-white text-3xl font-[Bebas_Neue,sans-serif] tracking-wide uppercase">
          What kind of meme?
        </h1>
      </header>

      <div className="flex-1 flex flex-col gap-4 min-h-0">
        <ImageCard
          assetUrl={hero.image?.assetUrl ?? null}
          isSelected={selected === "image"}
          onClick={() => onSelect("image")}
        />

        <VideoCard
          assetUrl={hero.video?.assetUrl ?? null}
          posterUrl={hero.video?.posterUrl ?? null}
          isSelected={selected === "video"}
          state={videoState}
          onClick={handleVideoClick}
        />
      </div>

      <UnifiedUpgradeModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        context="video-card"
      />
    </div>
  );
}

/* ───────────────────────────── Image card ───────────────────────────────── */

interface ImageCardProps {
  assetUrl: string | null;
  isSelected: boolean;
  onClick: () => void;
}

function ImageCard({ assetUrl, isSelected, onClick }: ImageCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Image"
      aria-pressed={isSelected}
      className={`relative flex-1 rounded-2xl overflow-hidden text-left transition-shadow ${
        isSelected ? "ring-2 ring-[#ff6b35]" : "ring-1 ring-white/10"
      }`}
      data-testid="step1-image-card"
    >
      <div className="relative h-full w-full bg-[#1a1a1a]">
        <HeroExampleImage assetUrl={assetUrl} />
        <CardCaption
          eyebrow="Image meme"
          body="Classic format. Share anywhere."
        />
      </div>
    </button>
  );
}

/* ───────────────────────────── Video card ───────────────────────────────── */

interface VideoCardProps {
  assetUrl: string | null;
  posterUrl: string | null;
  isSelected: boolean;
  state: ReturnType<typeof useVideoCardState>;
  onClick: () => void;
}

function VideoCard({ assetUrl, posterUrl, isSelected, state, onClick }: VideoCardProps) {
  const isLocked = state.kind === "locked-upgrade";
  const isBudgetReached = state.kind === "budget-reached";
  const isInteractive = !isBudgetReached;

  // The dim state applies to the inner content only — the chrome (crown +
  // gradient border) stays full-strength even when locked.
  const innerOpacity = isLocked ? "opacity-50" : "opacity-100";

  const content = (
    <VideoCardChrome>
      <div className={`relative h-full w-full ${innerOpacity}`}>
        <HeroExampleVideo assetUrl={assetUrl} posterUrl={posterUrl} />
        <CardCaption
          eyebrow="Video meme"
          body="See yourself. AI-generated. Made for socials."
        />
      </div>
      {isLocked && <CardLockedOverlay />}
      {isBudgetReached && <CardBudgetReached resetDate={state.resetDate} />}
    </VideoCardChrome>
  );

  if (!isInteractive) {
    return (
      <div
        className="relative flex-1 min-h-0"
        aria-label="Video"
        aria-disabled="true"
        data-testid="step1-video-card"
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Video"
      aria-pressed={isSelected}
      className={`relative flex-1 min-h-0 text-left transition-shadow rounded-2xl ${
        isSelected ? "ring-2 ring-[#ff6b35]" : ""
      }`}
      data-testid="step1-video-card"
    >
      {content}
    </button>
  );
}

/* ───────────────────────────── Caption ──────────────────────────────────── */

interface CaptionProps {
  eyebrow: string;
  body: string;
}

function CardCaption({ eyebrow, body }: CaptionProps) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-[5] p-4 bg-gradient-to-t from-black/85 via-black/60 to-transparent">
      <div className="font-mono text-[10px] uppercase tracking-widest text-[#ff6b35]">
        {eyebrow}
      </div>
      <div className="text-white text-sm mt-1">{body}</div>
    </div>
  );
}
