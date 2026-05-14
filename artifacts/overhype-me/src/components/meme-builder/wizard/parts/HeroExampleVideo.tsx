/**
 * Looping MP4 hero example for the Step 1 video card.
 *
 * autoplay + muted + playsInline + loop — required for mobile autoplay.
 * Falls back to a brand-orange placeholder when no asset is available.
 */

import { HeroExamplePlaceholder } from "./HeroExampleImage";

interface Props {
  assetUrl?: string | null;
  posterUrl?: string | null;
}

export function HeroExampleVideo({ assetUrl, posterUrl }: Props) {
  if (!assetUrl) {
    return <HeroExamplePlaceholder kind="video" />;
  }
  return (
    <video
      src={assetUrl}
      poster={posterUrl ?? undefined}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
      className="absolute inset-0 w-full h-full object-cover"
      data-testid="hero-example-video"
    />
  );
}
