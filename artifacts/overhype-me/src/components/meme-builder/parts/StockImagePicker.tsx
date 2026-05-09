import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useDesktopModality } from "../hooks/useDesktopModality";
import { useStockImages, type StockImage } from "../hooks/useStockImages";
import { ZERO_STOCK_COPY } from "../copy";

interface Props {
  factId: string;
  selectedId: string | null;
  onSelect: (image: StockImage) => void;
  onZeroStock?: () => void;
}

export function StockImagePicker({ factId, selectedId, onSelect, onZeroStock }: Props) {
  const isDesktop = useDesktopModality();
  const { images, isLoading, isError, isZeroStock } = useStockImages(factId);

  // When the picker loads images and there is already a pre-selected ID (e.g.
  // from initialStockImageId on the cold-permalink flow), fire onSelect so the
  // parent state gets the URL too — otherwise stockImageUrl stays null and the
  // live preview canvas shows a black background.
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading || isError || images.length === 0) return;
    if (!selectedId) return;
    if (hydratedRef.current === selectedId) return;
    const match = images.find((img) => img.id === selectedId);
    if (match) {
      hydratedRef.current = selectedId;
      onSelect(match);
    }
  }, [isLoading, isError, images, selectedId, onSelect]);

  if (isLoading) {
    return <div className="h-32 animate-pulse rounded-md bg-secondary/40" aria-label="Loading stock images" />;
  }
  if (isError) {
    return <p className="text-sm text-destructive">Could not load stock images. Try again in a moment.</p>;
  }
  if (isZeroStock) {
    if (onZeroStock) onZeroStock();
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-sm">
        <p className="font-display text-base uppercase">{ZERO_STOCK_COPY.title}</p>
        <p className="text-muted-foreground">{ZERO_STOCK_COPY.subtitle}</p>
      </div>
    );
  }

  // Desktop: grid. Mobile-modality: horizontal scroll-snap strip. Discriminated
  // by `useDesktopModality` (CSS hover/pointer media query — NOT viewport width).
  return (
    <div
      className={cn(
        isDesktop
          ? "grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5"
          : "flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1",
      )}
      role="radiogroup"
      aria-label="Stock photo"
    >
      {images.map((img) => {
        const isSelected = selectedId === img.id;
        return (
          <button
            key={img.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(img)}
            className={cn(
              "relative flex shrink-0 snap-start overflow-hidden rounded-md border-2 transition",
              isDesktop ? "aspect-square" : "h-24 w-32",
              isSelected ? "border-primary" : "border-transparent hover:border-secondary",
            )}
          >
            <img src={img.url} alt="" loading="lazy" className="h-full w-full object-cover" />
          </button>
        );
      })}
    </div>
  );
}
