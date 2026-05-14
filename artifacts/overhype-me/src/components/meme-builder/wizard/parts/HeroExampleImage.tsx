/**
 * Renders the still hero example inside the Step 1 image card.
 * Falls back to a brand-orange placeholder when no asset is available.
 */

interface Props {
  assetUrl?: string | null;
}

export function HeroExampleImage({ assetUrl }: Props) {
  if (!assetUrl) {
    return <HeroExamplePlaceholder kind="image" />;
  }
  return (
    <img
      src={assetUrl}
      alt=""
      loading="eager"
      decoding="async"
      className="absolute inset-0 w-full h-full object-cover"
      data-testid="hero-example-image"
    />
  );
}

interface PlaceholderProps {
  kind: "image" | "video";
}

export function HeroExamplePlaceholder({ kind }: PlaceholderProps) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#ff6b35]/30 via-[#ff6b35]/10 to-transparent"
      data-testid={`hero-example-placeholder-${kind}`}
    >
      <span className="font-mono text-[10px] uppercase tracking-widest text-white/50">
        Example coming soon
      </span>
    </div>
  );
}
