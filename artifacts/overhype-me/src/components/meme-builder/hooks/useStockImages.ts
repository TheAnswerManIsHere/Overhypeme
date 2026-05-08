import { useEffect, useState } from "react";

export interface StockImage {
  id: string;
  url: string;
  photographer?: string;
  photographerUrl?: string;
}

interface FetchState {
  images: StockImage[];
  isLoading: boolean;
  isError: boolean;
  isZeroStock: boolean;
}

/**
 * Loads up to 10 stock photos for a fact. Backed by the existing
 * GET /api/facts/:factId/pexels-images endpoint, which reads from
 * facts.pexels_images (prefetched at fact-approval time, capped at 10/gender
 * in Phase 3 — see lib/factImagePipeline.ts).
 *
 * Defaults gender to "neutral"; the picker can offer a gender filter if/when
 * we want one back.
 */
export function useStockImages(factId: string, gender: "male" | "female" | "neutral" = "neutral"): FetchState {
  const [state, setState] = useState<FetchState>({ images: [], isLoading: true, isError: false, isZeroStock: false });

  useEffect(() => {
    let cancelled = false;
    setState({ images: [], isLoading: true, isError: false, isZeroStock: false });

    fetch(`/api/facts/${encodeURIComponent(factId)}/pexels-images?gender=${gender}&offset=0`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { photos: { id: number; url: string; photographer?: string; photographer_url?: string }[] };
        if (cancelled) return;
        const images: StockImage[] = data.photos.map((p) => ({
          id: String(p.id),
          url: p.url,
          photographer: p.photographer,
          photographerUrl: p.photographer_url,
        }));
        setState({ images, isLoading: false, isError: false, isZeroStock: images.length === 0 });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ images: [], isLoading: false, isError: true, isZeroStock: false });
      });

    return () => {
      cancelled = true;
    };
  }, [factId, gender]);

  return state;
}
