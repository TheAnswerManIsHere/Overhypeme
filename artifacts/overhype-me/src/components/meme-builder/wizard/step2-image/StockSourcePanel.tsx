import { cn } from "@/lib/utils";
import { useDesktopModality } from "../../hooks/useDesktopModality";
import { useAutoSelectDefault } from "../../hooks/useAutoSelectDefault";
import { useStockImages } from "./useStockImagesGrouped";
import type { StockImage } from "../../hooks/useStockImages";
import { pronounsToStockGender } from "../util/pronounsToStockGender";
import { ZERO_STOCK_COPY } from "../../copy";

interface Props {
  factId: string;
  pronouns: string | undefined;
  selectedId: string | null;
  onSelect: (image: StockImage) => void;
}

/**
 * Stock picker for Step 2. Shows images from the pool that matches the
 * user's pronouns. A "Load more images" button appends the next page when
 * the server indicates more results are available.
 */
export function StockSourcePanel({ factId, pronouns, selectedId, onSelect }: Props) {
  const gender = pronounsToStockGender(pronouns);
  const { images, isLoading, isError, hasMore, fetchMore } = useStockImages(factId, gender);
  const isDesktop = useDesktopModality();
  const isZeroStock = !isLoading && !isError && images.length === 0;

  // Draft restore: re-emit the stored selected image (with URL) once images load.
  useAutoSelectDefault<StockImage>({
    enabled: !isLoading && !isError && !!selectedId && images.length > 0,
    identityKey: selectedId,
    resolveDefault: () => images.find((img) => img.id === selectedId) ?? null,
    onSelect,
  });
  // Fresh entry: auto-select the first image so the live preview is never black.
  useAutoSelectDefault<StockImage>({
    enabled: !isLoading && !isError && !selectedId && images.length > 0,
    identityKey: images[0]?.id ? `first:${gender}:${images[0].id}` : null,
    resolveDefault: () => images[0] ?? null,
    onSelect,
  });

  if (isLoading && images.length === 0) {
    return (
      <div
        className="h-32 animate-pulse rounded-md bg-secondary/40"
        aria-label="Loading stock images"
      />
    );
  }
  if (isError && images.length === 0) {
    return (
      <p className="text-sm text-destructive">
        Could not load stock images. Try again in a moment.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        Photos for you
      </span>

      {isZeroStock && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm">
          <p className="font-display text-base uppercase">{ZERO_STOCK_COPY.title}</p>
          <p className="text-muted-foreground">{ZERO_STOCK_COPY.subtitle}</p>
        </div>
      )}

      {!isZeroStock && (
        <>
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
                    isSelected
                      ? "border-[#ff6b35]"
                      : "border-transparent hover:border-white/30",
                  )}
                >
                  <img
                    src={img.url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </button>
              );
            })}
          </div>

          {hasMore && (
            <button
              type="button"
              onClick={fetchMore}
              disabled={isLoading}
              className="mt-1 w-full rounded-md border border-border bg-white/5 py-2 text-xs uppercase tracking-wider text-muted-foreground hover:bg-white/10 disabled:opacity-50"
              data-testid="stock-load-more"
            >
              {isLoading ? "Loading…" : "Load more images"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
