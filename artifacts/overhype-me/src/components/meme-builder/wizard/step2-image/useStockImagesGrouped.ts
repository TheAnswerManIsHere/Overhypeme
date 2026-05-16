import { useCallback, useEffect, useRef, useState } from "react";
import type { StockImage } from "../../hooks/useStockImages";
import { type StockGender } from "../util/pronounsToStockGender";

type RawPhoto = {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
};

/**
 * Fetches stock images for a single gender pool with offset-based pagination.
 *
 * The API endpoint (`GET /facts/:id/pexels-images`) accepts `offset` and
 * returns `{ photos, hasMore }`. Calling `fetchMore()` appends the next page
 * to `images` and hides the "Load more" button once `hasMore` is false.
 *
 * A generation counter prevents stale responses from a previous `factId` /
 * `gender` combo from clobbering the current state.
 */
export function useStockImages(
  factId: string,
  gender: StockGender,
): {
  images: StockImage[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  fetchMore: () => void;
} {
  const [images, setImages] = useState<StockImage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const nextOffsetRef = useRef(0);
  const isLoadingRef = useRef(false);
  const generationRef = useRef(0);

  const doLoad = useCallback(
    (offset: number, append: boolean) => {
      if (isLoadingRef.current) return;
      isLoadingRef.current = true;
      const gen = ++generationRef.current;
      setIsLoading(true);

      fetch(
        `/api/facts/${encodeURIComponent(factId)}/pexels-images?gender=${gender}&offset=${offset}`,
        { credentials: "include" },
      )
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{ photos: RawPhoto[]; hasMore: boolean }>;
        })
        .then((data) => {
          if (generationRef.current !== gen) return;
          const fresh: StockImage[] = data.photos.map((p) => ({
            id: String(p.id),
            url: p.url,
            photographer: p.photographer,
            photographerUrl: p.photographer_url,
          }));
          setImages((prev) => (append ? [...prev, ...fresh] : fresh));
          setHasMore(data.hasMore);
          nextOffsetRef.current = offset + fresh.length;
          isLoadingRef.current = false;
          setIsLoading(false);
        })
        .catch(() => {
          if (generationRef.current !== gen) return;
          setIsError(true);
          isLoadingRef.current = false;
          setIsLoading(false);
        });
    },
    [factId, gender],
  );

  useEffect(() => {
    isLoadingRef.current = false;
    nextOffsetRef.current = 0;
    setImages([]);
    setIsLoading(true);
    setIsError(false);
    setHasMore(false);
    doLoad(0, false);
  }, [doLoad]);

  const fetchMore = useCallback(() => {
    if (isLoadingRef.current || !hasMore) return;
    doLoad(nextOffsetRef.current, true);
  }, [hasMore, doLoad]);

  return { images, isLoading, isError, hasMore, fetchMore };
}
