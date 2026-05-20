/**
 * Loads the three video-catalogue endpoints in parallel and exposes a
 * stable shape for Step 2 consumers. Each catalogue is a thin
 * { loading, error, rows } cell.
 *
 * Test seam: callers may inject overrides for any of the three fetchers.
 */

import { useEffect, useState } from "react";
import {
  fetchLookStyles,
  fetchMotionPresets,
  fetchVideoEngines,
  type LookStyleDTO,
  type MotionPresetDTO,
  type VideoEngineDTO,
} from "./videoCatalogue";
import { FALLBACK_LOOK_STYLES } from "../aiStylePresets";

export interface VideoCatalogueOverrides {
  fetchLookStyles?: (signal?: AbortSignal) => Promise<LookStyleDTO[]>;
  fetchMotionPresets?: (signal?: AbortSignal) => Promise<MotionPresetDTO[]>;
  fetchVideoEngines?: (signal?: AbortSignal) => Promise<VideoEngineDTO[]>;
}

export interface VideoCatalogueResult {
  loading: boolean;
  error: Error | null;
  lookStyles: LookStyleDTO[];
  motionPresets: MotionPresetDTO[];
  engines: VideoEngineDTO[];
}

export function useVideoCatalogue(
  overrides: VideoCatalogueOverrides = {},
): VideoCatalogueResult {
  const {
    fetchLookStyles: fetchLooks = fetchLookStyles,
    fetchMotionPresets: fetchMotions = fetchMotionPresets,
    fetchVideoEngines: fetchEngines = fetchVideoEngines,
  } = overrides;

  const [lookStyles, setLookStyles] = useState<LookStyleDTO[]>([]);
  const [motionPresets, setMotionPresets] = useState<MotionPresetDTO[]>([]);
  const [engines, setEngines] = useState<VideoEngineDTO[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    Promise.all([
      fetchLooks(ctrl.signal),
      fetchMotions(ctrl.signal),
      fetchEngines(ctrl.signal),
    ])
      .then(([looks, motions, engs]) => {
        if (cancelled) return;
        setLookStyles(looks.length > 0 ? looks : FALLBACK_LOOK_STYLES);
        setMotionPresets(motions);
        setEngines(engs);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || ctrl.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        // Still populate the fallback look styles so the UI has *something*
        // to display while we surface the error.
        setLookStyles(FALLBACK_LOOK_STYLES);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [fetchLooks, fetchMotions, fetchEngines]);

  return { loading, error, lookStyles, motionPresets, engines };
}
