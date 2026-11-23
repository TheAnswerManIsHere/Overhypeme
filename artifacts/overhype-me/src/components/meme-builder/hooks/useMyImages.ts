import { useEffect, useState } from "react";

export interface MyImageRow {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
  createdAt: string;
  /** Always null here: the hook lists raw uploads only. */
  transform: string | null;
  sourceObjectPath: string | null;
  factId: number | null;
  transformParamsHash: string | null;
  /** True when this upload is the user's current profile photo. Task #507. */
  isProfile: boolean;
}

interface UploadsResponse {
  uploads: MyImageRow[];
  uploadCount: number;
  maxUploads: number;
  displayLimit: number;
  nextCursor?: string | null;
}

interface FetchState {
  rows: MyImageRow[];
  uploadCount: number;
  maxUploads: number;
  isLoading: boolean;
  isError: boolean;
  /** The server pages uploads; these fetch the rest (#875, R6). */
  nextCursor: string | null;
  loadingMore: boolean;
}

export interface MyImagesResult extends FetchState {
  hasMore: boolean;
  loadMore: () => void;
}

const EMPTY: FetchState = { rows: [], uploadCount: 0, maxUploads: 0, isLoading: true, isError: false, nextCursor: null, loadingMore: false };
const URL_BASE = "/api/users/me/uploads?transform=raw";

/**
 * Lists the current user's raw uploads from GET /api/users/me/uploads (its
 * default filter). The AI-styling filters went with PuLID (launch Phase 4,
 * removal 3).
 */
export function useMyImages(opts: {
  enabled: boolean;
  reloadKey?: number;
}): MyImagesResult {
  const { enabled, reloadKey } = opts;
  const [state, setState] = useState<FetchState>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setState({ ...EMPTY, isLoading: false });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true, isError: false }));

    fetch(URL_BASE, { credentials: "include" })
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
          nextCursor: data.nextCursor ?? null,
          loadingMore: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ ...EMPTY, isLoading: false, isError: true });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  const loadMore = () => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore) return;
    setState((prev) => ({ ...prev, loadingMore: true }));
    fetch(`${URL_BASE}&cursor=${encodeURIComponent(cursor)}`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as UploadsResponse;
        setState((prev) => ({
          ...prev,
          rows: [...prev.rows, ...data.uploads.filter((u) => !prev.rows.some((r) => r.objectPath === u.objectPath))],
          nextCursor: data.nextCursor ?? null,
          loadingMore: false,
        }));
      })
      .catch(() => setState((prev) => ({ ...prev, loadingMore: false })));
  };

  return { ...state, hasMore: !!state.nextCursor, loadMore };
}
