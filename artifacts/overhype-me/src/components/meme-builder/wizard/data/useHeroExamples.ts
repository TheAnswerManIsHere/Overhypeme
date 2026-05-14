/**
 * Wizard-side hook for fetching and randomizing hero examples.
 *
 * Fetches both image and video sets on mount, then exposes a single chosen
 * row per artifact type. The "chosen" pick is stable across re-renders for
 * the lifetime of the hook (one wizard session) so a parent re-render
 * doesn't reshuffle the displayed asset mid-interaction. A new mount picks
 * fresh.
 *
 * Empty sets resolve to null — the Step 1 component falls back to a
 * placeholder card in that case.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchHeroExamples,
  type HeroExampleDTO,
  type HeroExamplesResponse,
} from "./heroExamplesClient";

export interface UseHeroExamplesResult {
  loading: boolean;
  error: Error | null;
  image: HeroExampleDTO | null;
  video: HeroExampleDTO | null;
}

interface InternalOptions {
  /** Override fetch (test seam). */
  fetcher?: (signal?: AbortSignal) => Promise<HeroExamplesResponse>;
  /** Override randomness (test seam). Receives a length, returns an index. */
  randomIndex?: (length: number) => number;
}

function defaultRandomIndex(length: number): number {
  if (length <= 0) return 0;
  return Math.floor(Math.random() * length);
}

export function useHeroExamples(opts: InternalOptions = {}): UseHeroExamplesResult {
  const { fetcher = fetchHeroExamples, randomIndex = defaultRandomIndex } = opts;

  const [data, setData] = useState<HeroExamplesResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  // Stable seed: indices are picked once per mount. We memo by setSize so a
  // server response that arrives later doesn't restate the pick beyond what's
  // necessary, but mid-render reshuffles never happen.
  const seedRef = useRef<{ imageIdx: number; videoIdx: number } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    fetcher(ctrl.signal)
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || ctrl.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [fetcher]);

  return useMemo(() => {
    const image = data?.image ?? [];
    const video = data?.video ?? [];
    if (!seedRef.current && (image.length > 0 || video.length > 0)) {
      seedRef.current = {
        imageIdx: image.length > 0 ? randomIndex(image.length) : 0,
        videoIdx: video.length > 0 ? randomIndex(video.length) : 0,
      };
    }
    const seed = seedRef.current;
    return {
      loading,
      error,
      image: seed && image.length > 0 ? image[seed.imageIdx % image.length] : null,
      video: seed && video.length > 0 ? video[seed.videoIdx % video.length] : null,
    };
  }, [data, loading, error, randomIndex]);
}
