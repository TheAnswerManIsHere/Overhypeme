import { useEffect, useState } from "react";

export interface MyImageRow {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
  createdAt: string;
  transform: "pulid" | "pulid_fallback_text" | null;
  sourceObjectPath: string | null;
  factId: number | null;
  transformParamsHash: string | null;
}

interface UploadsResponse {
  uploads: MyImageRow[];
  uploadCount: number;
  maxUploads: number;
  displayLimit: number;
}

interface FetchState {
  rows: MyImageRow[];
  uploadCount: number;
  maxUploads: number;
  isLoading: boolean;
  isError: boolean;
}

const EMPTY: FetchState = { rows: [], uploadCount: 0, maxUploads: 0, isLoading: true, isError: false };

/**
 * Lists the current user's library entries. Filters via the same
 * GET /api/users/me/uploads endpoint (extended in Phase 3 to support the
 * `transform` and `factId` filters).
 *
 *   transform = "raw"          → only raw uploads (the default)
 *   transform = "ai"           → all PuLID derivatives + fallbacks
 *   transform = "pulid"        → only PuLID-stylized
 *   transform = "all"          → no filter
 *   factId scopes derivatives to a specific fact (ignored for raw uploads).
 */
export function useMyImages(opts: {
  enabled: boolean;
  transform?: "raw" | "ai" | "pulid" | "pulid_fallback_text" | "all";
  factId?: string;
  reloadKey?: number;
}): FetchState {
  const { enabled, transform = "raw", factId, reloadKey } = opts;
  const [state, setState] = useState<FetchState>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setState({ ...EMPTY, isLoading: false });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true, isError: false }));

    const params = new URLSearchParams();
    params.set("transform", transform);
    if (factId && transform !== "raw") params.set("factId", factId);

    fetch(`/api/users/me/uploads?${params.toString()}`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as UploadsResponse;
        if (cancelled) return;
        setState({
          rows: data.uploads,
          uploadCount: data.uploadCount,
          maxUploads: data.maxUploads,
          isLoading: false,
          isError: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ rows: [], uploadCount: 0, maxUploads: 0, isLoading: false, isError: true });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, transform, factId, reloadKey]);

  return state;
}
