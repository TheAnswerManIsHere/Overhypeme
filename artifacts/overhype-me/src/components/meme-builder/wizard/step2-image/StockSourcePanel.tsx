import { useState } from "react";
import { cn } from "@/lib/utils";
import { useDesktopModality } from "../../hooks/useDesktopModality";
import { useStockImagesGrouped } from "./useStockImagesGrouped";
import type { StockImage } from "../../hooks/useStockImages";
import { pronounsToStockGender, type StockGender } from "../util/pronounsToStockGender";
import { ZERO_STOCK_COPY } from "../../copy";

interface Props {
  factId: string;
  pronouns: string | undefined;
  selectedId: string | null;
  onSelect: (image: StockImage) => void;
}

/**
 * Stock picker for Step 2. Defaults to the gender pool derived from the user's
 * pronouns; "Show all" expands to the union of male + female + neutral pools
 * (gender-grouped order). When the default pool is empty, we silently widen
 * to "all" so the user never sees an empty picker.
 */
export function StockSourcePanel({ factId, pronouns, selectedId, onSelect }: Props) {
  const defaultGender: StockGender = pronounsToStockGender(pronouns);
  const [showAll, setShowAll] = useState(false);

  const scope = showAll ? "all" : defaultGender;
  const { images, isLoading, isError, isZeroStock } = useStockImagesGrouped(factId, scope);
  const isDesktop = useDesktopModality();

  // Silent widening: when the gender-filtered pool is empty, retry with "all".
  // The toggle reflects this so the user can see what's happening.
  const effectiveShowAll = showAll || (isZeroStock && !showAll);

  if (isLoading) {
    return <div className="h-32 animate-pulse rounded-md bg-secondary/40" aria-label="Loading stock images" />;
  }
  if (isError) {
    return <p className="text-sm text-destructive">Could not load stock images. Try again in a moment.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          {effectiveShowAll ? "All photos" : "Photos for you"}
        </span>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-white"
          data-testid="stock-show-all-toggle"
        >
          {effectiveShowAll ? "Filter to mine" : "Show all"}
        </button>
      </div>

      {isZeroStock && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm">
          <p className="font-display text-base uppercase">{ZERO_STOCK_COPY.title}</p>
          <p className="text-muted-foreground">{ZERO_STOCK_COPY.subtitle}</p>
        </div>
      )}

      {!isZeroStock && (
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
                data-testid={`stock-thumb-${img.id}`}
                className={cn(
                  "relative flex shrink-0 snap-start overflow-hidden rounded-md border-2 transition",
                  isDesktop ? "aspect-square" : "h-24 w-32",
                  isSelected ? "border-[#ff6b35]" : "border-transparent hover:border-white/30",
                )}
              >
                <img src={img.url} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
