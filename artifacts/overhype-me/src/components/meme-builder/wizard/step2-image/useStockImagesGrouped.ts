import { useEffect, useState } from "react";
import type { StockImage } from "../../hooks/useStockImages";

interface FetchState {
  images: StockImage[];
  isLoading: boolean;
  isError: boolean;
  isZeroStock: boolean;
}

type Gender = "male" | "female" | "neutral";

async function fetchPool(factId: string, gender: Gender): Promise<StockImage[]> {
  const url = `/api/facts/${encodeURIComponent(factId)}/pexels-images?gender=${gender}&offset=0`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    photos: { id: number; url: string; photographer?: string; photographer_url?: string }[];
  };
  return data.photos.map((p) => ({
    id: String(p.id),
    url: p.url,
    photographer: p.photographer,
    photographerUrl: p.photographer_url,
  }));
}

/**
 * Variant of `useStockImages` that supports a `"all"` mode — fetches all three
 * gender pools in parallel, concatenates them gender-grouped (male → female →
 * neutral), and dedupes by photo id.
 *
 * The grouped ordering is intentional: "Show all" is a fallback for users
 * whose pronouns don't map cleanly to one of the curated pools, so giving
 * them a deterministic order keeps the picker stable across renders.
 */
export function useStockImagesGrouped(
  factId: string,
  scope: Gender | "all",
): FetchState {
  const [state, setState] = useState<FetchState>({
    images: [],
    isLoading: true,
    isError: false,
    isZeroStock: false,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ images: [], isLoading: true, isError: false, isZeroStock: false });

    const work: Promise<StockImage[]> =
      scope === "all"
        ? Promise.all([
            fetchPool(factId, "male").catch(() => [] as StockImage[]),
            fetchPool(factId, "female").catch(() => [] as StockImage[]),
            fetchPool(factId, "neutral").catch(() => [] as StockImage[]),
          ]).then(([m, f, n]) => {
            const seen = new Set<string>();
            const merged: StockImage[] = [];
            for (const img of [...m, ...f, ...n]) {
              if (seen.has(img.id)) continue;
              seen.add(img.id);
              merged.push(img);
            }
            return merged;
          })
        : fetchPool(factId, scope);

    work
      .then((images) => {
        if (cancelled) return;
        setState({ images, isLoading: false, isError: false, isZeroStock: images.length === 0 });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ images: [], isLoading: false, isError: true, isZeroStock: false });
      });

    return () => {
      cancelled = true;
    };
  }, [factId, scope]);

  return state;
}
